/**
 * Main-process IPC v1 handlers (Packet C).
 *
 * Every renderer call is checked here on its own terms: a registered window's
 * top frame at the trusted URL, contract version, exact fields and primitive
 * types, session and epoch binding, route policy, per-route UTF-8 limits, and
 * the one-running-job and unknown-outcome gates. A malformed or unauthorized
 * call has no side effect. Identical retries of a request ID replay the first
 * result without dispatching again; a different body under a used ID is
 * rejected.
 *
 * Running jobs and unknown outcomes are tracked app-wide, not per session: a
 * reload or a new session must not start a second job or slip past an
 * unresolved outcome. Every open session is told about each unknown outcome
 * (an `outcome.unresolved` event, and `SessionOpened.unresolved` for sessions
 * opened later), so the gate is never invisible. It clears only through
 * main-side `reconcile`, or the user's acknowledgment in Inspect for a route
 * whose card allows it (route card 07); see acknowledgmentRefusal.
 *
 * Electron is not imported. App wiring must:
 * - register `invoke` for each channel via `ipcMain.handle`, converting the
 *   event with `callerFromElectronEvent`;
 * - pass `webContents.send` as `send`;
 * - call `windowNavigated` when the top frame starts navigating, reloads or its
 *   renderer process goes away;
 * - call `windowClosed` when the webContents is destroyed.
 */
import { createHash } from 'node:crypto';

import { CONTRACT_VERSION, isFailureCode, utf8ByteLength } from '../contracts/session.ts';
import type {
  FailureCode,
  MainEvent,
  OutcomeReport,
  RewriteAccepted,
  RewriteFailed,
  RewriteSucceeded,
  RouteMode,
  TranscribeAccepted,
  TranscribeFailed,
  TranscribeSucceeded,
} from '../contracts/session.ts';
import { CAPTURE_END_REASONS, CAPTURE_UNAVAILABLE_REASONS, CHANNELS, MICROPHONE_STATES, REQUEST_SCHEMAS, checkSchema, isPlainRecord, pickSchemaFields } from '../contracts/ipc.ts';
import type {
  AcknowledgeResult,
  CancelResult,
  Capabilities,
  CaptureEndReason,
  ChooseAudioResult,
  DiscardCaptureResult,
  MicrophoneState,
  MicrophoneStatus,
  StartCaptureResult,
  CapabilityAction,
  CloseResult,
  CopyResult,
  Intent,
  IpcResult,
  PublishedRoute,
  SessionOpened,
} from '../contracts/ipc.ts';
import type { CapturePort, CaptureStream, MicrophonePort } from './platform/capture.ts';
import { CaptureUnavailable } from './platform/capture.ts';
import type { Clock } from './jobs.ts';
import { systemClock } from './jobs.ts';
import { FIXTURE_AUDIO, inspectWav } from './platform/media.ts';
import type { AudioChooserPort, ChooserResult } from './platform/media.ts';
import type { RoutePolicy } from './routePolicy.ts';
import { MAX_REQUEST_RECORDS, createSessionRegistry } from './sessionRegistry.ts';
import type { Caller, IdSource, RequestRecord, Session } from './sessionRegistry.ts';

/** What a provider adapter receives: the frozen request snapshot, no handles. */
export interface RewriteJob {
  readonly jobId: string;
  readonly route: PublishedRoute;
  readonly transcript: string;
  readonly steering: string;
}

/** A provider's claimed result. Main checks it before the renderer sees it. */
export interface ProviderSuccess {
  readonly actualMode: RouteMode;
  readonly actualIdentity: string;
  readonly text: string;
}

/** Reports one job's outcome. Only the first report counts. */
export interface JobSink {
  succeeded(result: ProviderSuccess): void;
  failed(code: FailureCode): void;
}

/** Runs rewrite jobs (Packet D). Must report each job exactly once via its sink. */
export interface RewriteJobPort {
  submit(job: RewriteJob, sink: JobSink): void;
  /** Asks the job to stop. The outcome still arrives through the sink. */
  cancel(jobId: string): void;
}

/** What a transcription adapter receives: a canonical WAV copy (fmt + data only). */
export interface TranscribeJob {
  readonly jobId: string;
  readonly route: PublishedRoute;
  readonly audio: Uint8Array;
}

/** Runs transcription jobs (Packet E2), with the same rules as RewriteJobPort. */
export interface TranscribeJobPort {
  submit(job: TranscribeJob, sink: JobSink): void;
  cancel(jobId: string): void;
}

export interface ClipboardPort {
  writeText(text: string): void;
}

export type SendToWindow = (windowId: number, channel: string, event: MainEvent) => void;

export interface DesktopMainOptions {
  readonly policy: RoutePolicy;
  readonly jobs: RewriteJobPort;
  readonly clipboard: ClipboardPort;
  readonly send: SendToWindow;
  readonly newId?: IdSource;
  /** Native audio chooser (Packet E). Without it, chooseAudio is not offered. */
  readonly chooser?: AudioChooserPort;
  /** Transcription runner (Packet E2). Without it, transcribe is not offered. */
  readonly transcriber?: TranscribeJobPort;
  /** Microphone permission and capture (Packet E3). Without both, capture is not offered. */
  readonly microphone?: MicrophonePort;
  readonly capture?: CapturePort;
  /** Timers for the capture backstop and stop timeout; tests pass a fake clock. */
  readonly clock?: Clock;
  /** Wall-clock time in ms, stamped on each accepted job for Inspect; tests pass a fixed one. */
  readonly now?: () => number;
  /**
   * Route keys whose card lets the user acknowledge an unknown outcome
   * (today only route card 07's `local-base-rewrite`). Each must
   * be a registered route that is not a fixture, or creation throws. Every
   * other route's unknown outcome clears only through `reconcile` or a restart.
   */
  readonly acknowledgeRoutes?: readonly string[];
}

export interface DesktopMain {
  registerWindow(windowId: number, trustedUrl: string): void;
  /** Lifecycle hook: the top frame navigated, reloaded or lost its renderer. */
  windowNavigated(windowId: number): void;
  /** Lifecycle hook: the window's webContents was destroyed. */
  windowClosed(windowId: number): void;
  /**
   * The wiring entry point for every channel. Never throws or rejects;
   * failures are safe result codes. Async intents (chooseAudio) resolve later.
   */
  invoke(channel: string, caller: Caller | null, payload: unknown): Promise<IpcResult<unknown>>;
  /**
   * Synchronous core for every intent that completes immediately; async
   * intents answer `unsupported` here. Tests use it for direct assertions.
   */
  handle(channel: string, caller: Caller | null, payload: unknown): IpcResult<unknown>;
  /**
   * Main-side only, never renderer-invokable: an unknown outcome was
   * independently reconciled (for a future route with receipts). Clears that
   * gate, even if its session has closed, tells that session if it is still
   * open, and tells every open session the gate cleared. The renderer's
   * `acknowledgeOutcome` clears a gate the same way, but only for a route in
   * `acknowledgeRoutes`.
   */
  reconcile(jobId: string): boolean;
}

type JobKind = 'rewrite' | 'transcribe';

interface JobRecord {
  readonly kind: JobKind;
  readonly jobId: string;
  readonly clientRequestId: string;
  readonly route: PublishedRoute;
  readonly session: Session;
  readonly accepted: RewriteAccepted | TranscribeAccepted;
  /** For transcriptions: the asset being transcribed. */
  readonly assetToken?: string;
  /** When main accepted the job and handed it to its route (ms since the Unix epoch). */
  readonly acceptedAt: number;
  /** A terminal outcome has been recorded; later ones are duplicates. */
  finished: boolean;
  cancelRequested: boolean;
}

/**
 * Bodies longer than this are rejected before hashing. Far above any route's
 * byte limit, it only keeps an oversized payload from costing a large hash.
 */
const MAX_HASHED_CHARS = 1024 * 1024;

/** A capture port that does not stop itself at the limit is ended by main this long after it. */
const CAPTURE_BACKSTOP_GRACE_MS = 1_000;
/** Longest main waits for a stopping stream before discarding it. */
const CAPTURE_STOP_TIMEOUT_MS = 5_000;

const INTENT_BY_CHANNEL = new Map<string, Intent>(
  Object.entries(CHANNELS)
    .filter(([intent]) => intent !== 'event')
    .map(([intent, channel]) => [channel, intent as Intent]),
);

function rejected(code: FailureCode): IpcResult<never> {
  return { ok: false, code };
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

/** Byte limit check that skips encoding when the length alone already fails. */
function withinBytes(text: string, maxBytes: number): boolean {
  // Every UTF-16 code unit encodes to at least one UTF-8 byte.
  return text.length <= maxBytes && utf8ByteLength(text) <= maxBytes;
}

/** What main knows when an acknowledgment arrives; see acknowledgmentRefusal. */
export interface AcknowledgmentFacts {
  /** The acknowledgment's request ID was already used in this session, by any request. */
  readonly requestIdUsed: boolean;
  /** The named job is an unknown outcome main reported and has not cleared. */
  readonly unresolved: boolean;
  /** That job's route card lets the user acknowledge (today only route card 07). */
  readonly acknowledgeable: boolean;
  /** Jobs still running, app-wide. */
  readonly running: number;
}

/**
 * Why an acknowledgment is refused, or null to accept it. Every refusal has
 * no side effect.
 * - A reused request ID → denied. An acknowledgment is single-use and never
 *   replayed: its effect is reported as events, so a replay has nothing to add.
 * - A job that is not a current unknown outcome (a wrong, cleared or never
 *   issued ID) → denied.
 * - A route whose card does not allow acknowledgment → unsupported.
 * - Any job still running → denied. One job runs at a time and none starts
 *   while an outcome is unknown, so today no intent can reach this; it keeps
 *   the rule if concurrency ever changes.
 */
export function acknowledgmentRefusal(facts: AcknowledgmentFacts): FailureCode | null {
  if (facts.requestIdUsed) return 'denied';
  if (!facts.unresolved) return 'denied';
  if (!facts.acknowledgeable) return 'unsupported';
  if (facts.running > 0) return 'denied';
  return null;
}

/** Normalizes an Electron IpcMainInvokeEvent, structurally. Null if unusable. */
export function callerFromElectronEvent(event: unknown): Caller | null {
  try {
    if (event === null || typeof event !== 'object') return null;
    const { sender, senderFrame } = event as { sender?: unknown; senderFrame?: unknown };
    if (sender === null || typeof sender !== 'object' || senderFrame === null || typeof senderFrame !== 'object') return null;
    const windowId = (sender as { id?: unknown }).id;
    const frame = senderFrame as { url?: unknown; parent?: unknown };
    if (typeof windowId !== 'number' || typeof frame.url !== 'string') return null;
    return { windowId, frameUrl: frame.url, isTopFrame: frame.parent === null };
  } catch {
    // A destroyed frame can throw on access; treat it as no caller.
    return null;
  }
}

export function createDesktopMain(options: DesktopMainOptions): DesktopMain {
  const { policy, jobs, clipboard, send } = options;
  const clock = options.clock ?? systemClock;
  const now = options.now ?? (() => Date.now());
  const registry = createSessionRegistry(options.newId);
  /** Routes whose unknown outcomes the user may acknowledge. Fixed at startup. */
  const acknowledgeable = new Set<string>();
  for (const key of options.acknowledgeRoutes ?? []) {
    const route = policy.routes.find((r) => r.routeKey === key);
    // A fixture never leaves the process, so its unknown outcome is main's own fault: it stays until a restart.
    if (route === undefined || route.mode === 'fixture') throw new Error('acknowledgeRoutes may name only registered, non-fixture routes');
    acknowledgeable.add(key);
  }
  /** Jobs without a terminal outcome yet, across all sessions and windows. */
  const running = new Map<string, JobRecord>();
  /** Jobs whose outcome is unknown. New rewrites wait until main reconciles them. */
  const unresolved = new Map<string, JobRecord>();

  function envelope(session: Session) {
    return { v: CONTRACT_VERSION, sessionId: session.sessionId, epoch: session.epoch };
  }

  function deliver(session: Session, event: MainEvent): void {
    if (!session.open) return;
    try {
      send(session.windowId, CHANNELS.event, event);
    } catch {
      // A window that cannot receive is closing; its lifecycle hook cleans up.
    }
  }

  /** Sends one event, addressed to each, to every open session. */
  function broadcast(build: (session: Session) => MainEvent): void {
    for (const session of registry.openSessions()) deliver(session, build(session));
  }

  /** The acceptance time as a non-negative safe integer, as the event schema requires. */
  function stamp(): number {
    const t = now();
    return Number.isSafeInteger(t) && t >= 0 ? t : 0;
  }

  function outcomeReport(job: JobRecord): OutcomeReport {
    const clearance = acknowledgeable.has(job.route.routeKey) ? 'acknowledge' : 'restart';
    return { kind: job.kind, jobId: job.jobId, routeKey: job.route.routeKey, sentAt: job.acceptedAt, clearance };
  }

  /**
   * Clears one unknown outcome: its own session, if still open, gets the
   * reconciled event for its request; then every open session hears the gate cleared.
   */
  function clearGate(job: JobRecord): void {
    unresolved.delete(job.jobId);
    const { session } = job;
    const settled = { ...envelope(session), clientRequestId: job.clientRequestId, jobId: job.jobId };
    deliver(session, job.kind === 'rewrite' ? { ...settled, type: 'rewrite.reconciled' } : { ...settled, type: 'transcribe.reconciled' });
    broadcast((s) => ({ ...envelope(s), type: 'outcome.cleared', kind: job.kind, jobId: job.jobId }));
  }

  function requestCancel(job: JobRecord): void {
    if (job.cancelRequested) return;
    job.cancelRequested = true;
    try {
      (job.kind === 'rewrite' ? jobs : options.transcriber)?.cancel(job.jobId);
    } catch {
      // Cancellation is best effort; the sink still settles the job.
    }
  }

  /** Closes a session and asks its running job to stop. The job stays tracked until it settles. */
  function closeSession(session: Session): void {
    dropCapture(session.windowId);
    registry.close(session);
    for (const job of running.values()) if (job.session === session) requestCancel(job);
  }

  function capabilities(): Capabilities {
    const ready = (stage: string) => policy.routes.some((r) => r.stage === stage && r.readiness === 'ready');
    const actions: CapabilityAction[] = ready('rewrite') ? ['rewrite', 'cancel', 'copyDraft'] : ['cancel', 'copyDraft'];
    if (options.chooser !== undefined) actions.push('chooseAudio');
    if (options.transcriber !== undefined && ready('transcribe')) actions.push('transcribe');
    if (options.microphone !== undefined && options.capture !== undefined) actions.push('capture');
    return { actions, routes: policy.routes };
  }

  /**
   * Stores a request's first result, evicting the oldest settled record past
   * the cap. A running job's record is kept, and so is an unknown outcome's:
   * once it is acknowledged, an identical retry must still replay, not dispatch again.
   */
  function remember(session: Session, clientRequestId: string, record: RequestRecord): void {
    if (session.requests.size >= MAX_REQUEST_RECORDS) {
      for (const [id, old] of session.requests) {
        if (old.jobId === null || (!running.has(old.jobId) && !unresolved.has(old.jobId))) {
          session.requests.delete(id);
          break;
        }
      }
    }
    session.requests.set(clientRequestId, record);
  }

  function sinkFor(job: JobRecord): JobSink {
    const { session, accepted } = job;
    const base = { ...envelope(session), clientRequestId: job.clientRequestId, jobId: job.jobId };

    // Both report paths return early once the job is finished, before any
    // side effect, so a duplicate terminal changes nothing.
    function settle(event: MainEvent | null): void {
      job.finished = true;
      running.delete(job.jobId);
      if (event !== null) deliver(session, event);
    }

    function fail(code: FailureCode): void {
      if (job.finished) return;
      const safe: FailureCode = isFailureCode(code) ? code : 'unknown_outcome';
      if (safe === 'unknown_outcome') unresolved.set(job.jobId, job);
      const event: RewriteFailed | TranscribeFailed =
        job.kind === 'rewrite' ? { ...base, type: 'rewrite.failed', code: safe } : { ...base, type: 'transcribe.failed', code: safe };
      settle(event);
      // After the job's own terminal, every open session (its own, a reload, another window) learns
      // that new work waits, with what Inspect shows. Unless it already cleared meanwhile.
      if (safe === 'unknown_outcome' && unresolved.get(job.jobId) === job) {
        const report = outcomeReport(job);
        broadcast((s) => ({ ...envelope(s), type: 'outcome.unresolved', ...report }));
      }
    }

    return {
      failed: fail,
      succeeded(result) {
        if (job.finished) return;
        if (!isPlainRecord(result) || typeof result.text !== 'string') return fail('invalid_response');
        if (result.actualMode !== job.route.mode || result.actualIdentity !== job.route.identity) {
          return fail('provider_mismatch');
        }
        // A transcript lands in the editor, so it is bounded by the transcript limit.
        const maxBytes = job.kind === 'rewrite' ? job.route.limits.draftBytes : job.route.limits.transcriptBytes;
        if (result.text.trim() === '' || !withinBytes(result.text, maxBytes)) {
          return fail('invalid_response');
        }
        if (!session.open) return settle(null);
        if (job.kind === 'transcribe') {
          const event: TranscribeSucceeded = {
            ...base,
            type: 'transcribe.succeeded',
            sourceRevision: accepted.sourceRevision,
            actualMode: job.route.mode,
            actualIdentity: job.route.identity,
            text: result.text,
          };
          return settle(event);
        }
        const rewriteAccepted = accepted as RewriteAccepted;
        // A job the user cancelled never gets a copyable draft: its handle is
        // a fresh ID that main does not store. The renderer only retires it.
        const draftHandle = job.cancelRequested ? registry.newId() : registry.issueDraft(session, result.text);
        const event: RewriteSucceeded = {
          ...base,
          type: 'rewrite.succeeded',
          sourceRevision: rewriteAccepted.sourceRevision,
          steeringRevision: rewriteAccepted.steeringRevision,
          actualMode: job.route.mode,
          actualIdentity: job.route.identity,
          text: result.text,
          draftHandle,
        };
        settle(event);
      },
    };
  }

  /** Route, limit and gate checks. Returns the route to use or a safe code. */
  function admit(payload: Record<string, unknown>): PublishedRoute | FailureCode {
    const resolution = policy.resolve('rewrite', payload.routeKey as string);
    if (!resolution.ok) return resolution.code;
    const { route } = resolution;
    const transcript = payload.transcript as string;
    if (transcript.trim() === '') return 'invalid_input';
    if (!withinBytes(transcript, route.limits.transcriptBytes)) return 'invalid_input';
    if (!withinBytes(payload.steering as string, route.limits.steeringBytes)) return 'invalid_input';
    // One running job at a time, and none while any outcome is unknown.
    if (running.size > 0 || unresolved.size > 0) return 'denied';
    return route;
  }

  /**
   * Rejects a new request before acceptance. The renderer is told on the
   * event channel too, because its reducer settles requests from events.
   */
  function refuse(session: Session, clientRequestId: string, code: FailureCode, kind: JobKind = 'rewrite'): IpcResult<never> {
    const base = { ...envelope(session), clientRequestId, jobId: null, code };
    const event: RewriteFailed | TranscribeFailed =
      kind === 'rewrite' ? { ...base, type: 'rewrite.failed' } : { ...base, type: 'transcribe.failed' };
    deliver(session, event);
    return rejected(code);
  }

  /**
   * Transcribes the session's chosen audio. Same idempotency and gates as
   * rewrite: one processing job app-wide and none while an outcome is unknown.
   */
  function transcribe(session: Session, payload: Record<string, unknown>): IpcResult<TranscribeAccepted> {
    const clientRequestId = payload.clientRequestId as string;
    const previous = session.requests.get(clientRequestId);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ intent: 'transcribe', ...pickSchemaFields(payload, REQUEST_SCHEMAS.transcribe) }))
      .digest('hex');
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) return rejected('invalid_input');
      return previous.result as IpcResult<TranscribeAccepted>;
    }
    const transcriber = options.transcriber;
    let admitted: PublishedRoute | FailureCode;
    const resolution = policy.resolve('transcribe', payload.routeKey as string);
    const asset = session.assets.get(payload.assetToken as string);
    if (transcriber === undefined) admitted = 'unsupported';
    else if (!resolution.ok) admitted = resolution.code;
    else if (asset === undefined) admitted = 'denied'; // expired, replaced or another session's token
    else if (running.size > 0 || unresolved.size > 0) admitted = 'denied';
    else admitted = resolution.route;
    if (typeof admitted === 'string' || transcriber === undefined || asset === undefined) {
      const result = refuse(session, clientRequestId, typeof admitted === 'string' ? admitted : 'unsupported', 'transcribe');
      remember(session, clientRequestId, { fingerprint, result, jobId: null });
      return result;
    }

    const accepted: TranscribeAccepted = {
      ...envelope(session),
      type: 'transcribe.accepted',
      clientRequestId,
      jobId: registry.newId(),
      sourceRevision: payload.sourceRevision as number,
    };
    const result = ok(accepted);
    const job: JobRecord = {
      kind: 'transcribe',
      jobId: accepted.jobId,
      clientRequestId,
      route: admitted,
      session,
      accepted,
      assetToken: payload.assetToken as string,
      acceptedAt: stamp(),
      finished: false,
      cancelRequested: false,
    };
    remember(session, clientRequestId, { fingerprint, result, jobId: job.jobId });
    running.set(job.jobId, job);
    deliver(session, accepted);
    const sink = sinkFor(job);
    try {
      transcriber.submit({ jobId: job.jobId, route: admitted, audio: asset.bytes.slice() }, sink);
    } catch {
      sink.failed('unknown_outcome');
    }
    return result;
  }

  function rewrite(session: Session, payload: Record<string, unknown>): IpcResult<RewriteAccepted> {
    const clientRequestId = payload.clientRequestId as string;
    const previous = session.requests.get(clientRequestId);
    const transcript = payload.transcript as string;
    const steering = payload.steering as string;

    if (transcript.length > MAX_HASHED_CHARS || steering.length > MAX_HASHED_CHARS) {
      // Never stored, so it cannot match a stored body: a used ID means conflict.
      return previous !== undefined ? rejected('invalid_input') : refuse(session, clientRequestId, 'invalid_input');
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(pickSchemaFields(payload, REQUEST_SCHEMAS.rewrite)))
      .digest('hex');
    if (previous !== undefined) {
      // Same ID and body: replay, never dispatch twice. Same ID, new body:
      // conflict, with no event, so the original request is not disturbed.
      if (previous.fingerprint !== fingerprint) return rejected('invalid_input');
      return previous.result as IpcResult<RewriteAccepted>;
    }

    const admitted = admit(payload);
    if (typeof admitted === 'string') {
      const result = refuse(session, clientRequestId, admitted);
      remember(session, clientRequestId, { fingerprint, result, jobId: null });
      return result;
    }

    const accepted: RewriteAccepted = {
      ...envelope(session),
      type: 'rewrite.accepted',
      clientRequestId,
      jobId: registry.newId(),
      sourceRevision: payload.sourceRevision as number,
      steeringRevision: payload.steeringRevision as number,
    };
    const result = ok(accepted);
    const job: JobRecord = {
      kind: 'rewrite',
      jobId: accepted.jobId,
      clientRequestId,
      route: admitted,
      session,
      accepted,
      acceptedAt: stamp(),
      finished: false,
      cancelRequested: false,
    };
    remember(session, clientRequestId, { fingerprint, result, jobId: job.jobId });
    running.set(job.jobId, job);
    // The accepted event goes out first on the ordered event channel, so the
    // renderer sees accepted before any terminal, even a synchronous one.
    deliver(session, accepted);

    const sink = sinkFor(job);
    try {
      jobs.submit({ jobId: job.jobId, route: admitted, transcript, steering }, sink);
    } catch {
      // Whether anything was dispatched is unknown, so the gate closes.
      sink.failed('unknown_outcome');
    }
    return result;
  }

  function cancel(session: Session, payload: Record<string, unknown>): IpcResult<CancelResult> {
    const record = session.requests.get(payload.clientRequestId as string);
    if (record === undefined) return rejected('denied');
    const job = record.jobId === null ? undefined : running.get(record.jobId);
    if (job === undefined) return ok({ disposition: 'already_finished' });
    requestCancel(job);
    return ok({ disposition: 'cancel_requested' });
  }

  /**
   * The user acknowledges one unknown outcome in Inspect (route card 07).
   * Accepted only for the exact job ID main reported, on a route
   * whose card allows it, with nothing running and a fresh request ID; see
   * acknowledgmentRefusal. Any session may acknowledge, because the gate is
   * app-wide and main reported the job to every session.
   */
  function acknowledgeOutcome(session: Session, fields: Record<string, unknown>): IpcResult<AcknowledgeResult> {
    const clientRequestId = fields.clientRequestId as string;
    const job = unresolved.get(fields.jobId as string);
    const refusal = acknowledgmentRefusal({
      requestIdUsed: session.requests.has(clientRequestId),
      unresolved: job !== undefined,
      acknowledgeable: job !== undefined && acknowledgeable.has(job.route.routeKey),
      running: running.size,
    });
    if (refusal !== null || job === undefined) return rejected(refusal ?? 'denied');
    const result = ok<AcknowledgeResult>({ status: 'acknowledged' });
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ intent: 'acknowledgeOutcome', ...pickSchemaFields(fields, REQUEST_SCHEMAS.acknowledgeOutcome) }))
      .digest('hex');
    // Recorded so the ID stays used: a later rewrite under it is a conflict, a later acknowledgment a replay.
    remember(session, clientRequestId, { fingerprint, result, jobId: null });
    clearGate(job);
    return result;
  }

  function copyDraft(session: Session, payload: Record<string, unknown>): IpcResult<CopyResult> {
    const text = session.drafts.get(payload.draftHandle as string);
    if (text === undefined) return rejected('denied');
    try {
      clipboard.writeText(text);
    } catch {
      return rejected('unknown_outcome');
    }
    return ok({ status: 'copied' });
  }

  function replaceAsset(session: Session): void {
    for (const job of running.values()) if (job.session === session && job.kind === 'transcribe') requestCancel(job);
    session.assets.clear();
  }

  /** Windows with a chooser open. Per window, so opening new sessions cannot stack dialogs. */
  const choosing = new Set<number>();

  /**
   * Opens the platform chooser, at most once per window at a time. Closing it
   * changes nothing. A session closed while it was open gets nothing, and the
   * bytes are dropped. Only a canonical copy of the samples is kept.
   */
  async function chooseAudio(session: Session): Promise<IpcResult<ChooseAudioResult>> {
    const chooser = options.chooser;
    if (chooser === undefined) return rejected('unsupported');
    if (choosing.has(session.windowId)) return ok({ status: 'already_open' });
    choosing.add(session.windowId);
    let picked: ChooserResult;
    try {
      picked = await chooser.pickAudio({ maxBytes: FIXTURE_AUDIO.maxBytes, windowId: session.windowId });
    } catch {
      return rejected('route_unavailable'); // the dialog failed; trying again may work
    } finally {
      choosing.delete(session.windowId);
    }
    if (!session.open) return rejected('denied');
    if (!isPlainRecord(picked)) return rejected('invalid_response');
    if (picked.status === 'cancelled') return ok({ status: 'cancelled' });
    if (picked.status !== 'picked' || !(picked.bytes instanceof Uint8Array)) return rejected('invalid_response');
    const verdict = inspectWav(picked.bytes);
    if (!verdict.ok) return rejected(verdict.code);
    // One asset per session: a new choice revokes the previous token, and a
    // transcription still reading the old audio is asked to stop.
    replaceAsset(session);
    const assetToken = registry.newId();
    session.assets.set(assetToken, { bytes: verdict.canonical, summary: verdict.summary });
    return ok({ status: 'chosen', assetToken, summary: verdict.summary });
  }

  type Admitted =
    | { readonly ok: false; readonly result: IpcResult<never> }
    | { readonly ok: true; readonly intent: Intent; readonly caller: Caller; readonly payload: Record<string, unknown> };

  /** Checks shared by every intent: channel, caller trust, version and exact schema. */
  function admitCall(channel: string, caller: Caller | null, payload: unknown): Admitted {
    const intent = INTENT_BY_CHANNEL.get(channel);
    if (intent === undefined) return { ok: false, result: rejected('unsupported') };
    if (caller === null || !registry.isTrusted(caller)) return { ok: false, result: rejected('denied') };
    const verdict = checkSchema(payload, REQUEST_SCHEMAS[intent]);
    if (verdict === 'unsupported_version') return { ok: false, result: rejected('unsupported') };
    if (verdict !== 'ok' || !isPlainRecord(payload)) return { ok: false, result: rejected('invalid_input') };
    return { ok: true, intent, caller, payload };
  }

  /**
   * The one capture in the app (component design: "one capture"), or null.
   * Phases: starting (prompt or device opening, no handle yet) → recording →
   * ended (stopped by itself, audio held) or stopping (Stop pressed). The slot
   * stays taken until the capture is fully released, so a second capture can
   * never start while a stop is still settling.
   */
  interface CaptureSlot {
    readonly session: Session;
    phase: 'starting' | 'recording' | 'ended' | 'stopping';
    handle: string | null;
    stream: CaptureStream | null;
    /** The captured audio, once Stop was pressed or the stream ended by itself. */
    result: Promise<Uint8Array> | null;
    discarded: boolean;
    timer: unknown;
  }
  let activeCapture: CaptureSlot | null = null;

  function releaseCapture(slot: CaptureSlot): void {
    if (slot.timer !== null) clock.clearTimeout(slot.timer);
    slot.timer = null;
    if (activeCapture === slot) activeCapture = null;
  }

  /** Stops the device and forgets the audio. Safe to call more than once. */
  function discardStream(slot: CaptureSlot): void {
    slot.discarded = true;
    try {
      slot.stream?.discard();
    } catch {
      // The stream is gone either way; teardown must continue.
    }
  }

  /**
   * Stops and drops a window's capture: on close, navigation, session
   * replacement or destroy. A capture still starting (OS prompt or device
   * opening) or stopping stays reserved until that path finishes, so a second
   * prompt or device can never open meanwhile; it sees the discard and keeps nothing.
   */
  function dropCapture(windowId: number): void {
    const slot = activeCapture;
    if (slot === null || slot.session.windowId !== windowId) return;
    discardStream(slot);
    if (slot.phase === 'recording' || slot.phase === 'ended') releaseCapture(slot);
  }

  function knownMicrophoneState(value: unknown): MicrophoneState {
    return (MICROPHONE_STATES as readonly unknown[]).includes(value) ? (value as MicrophoneState) : 'unknown';
  }

  function microphoneStatus(): IpcResult<MicrophoneStatus> {
    const microphone = options.microphone;
    if (microphone === undefined) return ok({ microphone: 'unsupported' });
    try {
      return ok({ microphone: knownMicrophoneState(microphone.status()) });
    } catch {
      return ok({ microphone: 'unknown' });
    }
  }

  /** The stream stopped by itself: hold its audio and tell the renderer, so the UI stops showing Recording. */
  function captureEnded(slot: CaptureSlot, reason: unknown): void {
    if (slot.phase !== 'recording' || slot.stream === null || slot.handle === null) return;
    slot.phase = 'ended';
    if (slot.timer !== null) clock.clearTimeout(slot.timer);
    slot.timer = null;
    slot.result = slot.stream.stop();
    slot.result.catch(() => undefined); // observed later by Stop, or dropped with the slot
    const safe = (CAPTURE_END_REASONS as readonly unknown[]).includes(reason) ? (reason as CaptureEndReason) : 'device_lost';
    deliver(slot.session, { ...envelope(slot.session), type: 'capture.ended', captureHandle: slot.handle, reason: safe });
  }

  /**
   * Starts the app's one capture after a deliberate action. Prompts only when
   * the OS has never been asked; denied, restricted or unknown permission is
   * "blocked" without prompting again, so prompts never loop.
   */
  async function startCapture(session: Session): Promise<IpcResult<StartCaptureResult>> {
    const { microphone, capture } = options;
    if (microphone === undefined || capture === undefined) return rejected('unsupported');
    if (activeCapture !== null) return ok({ status: 'already_recording' });
    const slot: CaptureSlot = { session, phase: 'starting', handle: null, stream: null, result: null, discarded: false, timer: null };
    activeCapture = slot;
    const stillWanted = () => session.open && activeCapture === slot && !slot.discarded;

    let state: MicrophoneState;
    try {
      state = knownMicrophoneState(microphone.status());
      if (state === 'not_requested') state = knownMicrophoneState(await microphone.request());
    } catch {
      state = 'unknown'; // a failing OS query is never treated as granted
    }
    if (!stillWanted()) {
      releaseCapture(slot);
      return rejected('denied');
    }
    if (state !== 'granted') {
      releaseCapture(slot);
      return ok({ status: 'blocked', microphone: state });
    }

    let stream: CaptureStream;
    try {
      stream = await capture.start({ maxDurationMs: FIXTURE_AUDIO.maxDurationMs });
    } catch (error) {
      releaseCapture(slot);
      const reason = error instanceof CaptureUnavailable && (CAPTURE_UNAVAILABLE_REASONS as readonly string[]).includes(error.reason) ? error.reason : 'failed';
      return ok({ status: 'unavailable', reason });
    }
    slot.stream = stream;
    if (!stillWanted()) {
      discardStream(slot); // closed or navigated while starting: never keep recording
      releaseCapture(slot);
      return rejected('denied');
    }
    slot.phase = 'recording';
    slot.handle = registry.newId();
    try {
      stream.onEnded((reason) => captureEnded(slot, reason));
    } catch {
      // A port that cannot report endings still gets the backstop below.
    }
    // Backstop: if the port does not stop itself at the limit, main ends the recording.
    slot.timer = clock.setTimeout(() => captureEnded(slot, 'max_duration'), FIXTURE_AUDIO.maxDurationMs + CAPTURE_BACKSTOP_GRACE_MS);
    return ok({ status: 'recording', captureHandle: slot.handle, maxDurationMs: FIXTURE_AUDIO.maxDurationMs });
  }

  /** The app's capture, only for this session and exactly this handle. */
  function captureFor(session: Session, handle: unknown): CaptureSlot | null {
    const slot = activeCapture;
    if (slot === null || slot.session !== session || slot.handle === null || slot.handle !== handle) return null;
    return slot;
  }

  /** Resolves to the audio, or rejects if the stream fails or takes longer than the stop timeout. */
  function boundedResult(slot: CaptureSlot): Promise<Uint8Array> {
    const result = slot.result ?? Promise.reject(new Error('no audio'));
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => reject(new Error('stop timed out')), CAPTURE_STOP_TIMEOUT_MS);
      result.then(
        (bytes) => {
          clock.clearTimeout(timer);
          resolve(bytes);
        },
        (error: unknown) => {
          clock.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Stops recording (or collects an ended recording) and keeps the audio as the session's asset. */
  async function stopCapture(session: Session, fields: Record<string, unknown>): Promise<IpcResult<ChooseAudioResult>> {
    const slot = captureFor(session, fields.captureHandle);
    if (slot === null || slot.stream === null || (slot.phase !== 'recording' && slot.phase !== 'ended')) return rejected('denied');
    if (slot.phase === 'recording') {
      if (slot.timer !== null) clock.clearTimeout(slot.timer);
      slot.timer = null;
      slot.result = slot.stream.stop();
    }
    slot.phase = 'stopping';
    let bytes: Uint8Array;
    try {
      bytes = await boundedResult(slot);
    } catch {
      discardStream(slot); // a failed or hung stop must not leave the device recording
      releaseCapture(slot);
      return rejected('route_unavailable');
    }
    const discarded = slot.discarded;
    releaseCapture(slot);
    if (discarded) return rejected('cancelled'); // Discard during the stop wins
    if (!session.open) return rejected('denied');
    if (!(bytes instanceof Uint8Array)) return rejected('invalid_response');
    const verdict = inspectWav(bytes, { trimToLimit: true });
    if (!verdict.ok) return rejected(verdict.code);
    replaceAsset(session); // like a chosen file: revokes the old token and stops its transcription
    const assetToken = registry.newId();
    session.assets.set(assetToken, { bytes: verdict.canonical, summary: verdict.summary });
    return ok({ status: 'chosen', assetToken, summary: verdict.summary });
  }

  /** Drops the recording and keeps nothing, even while a stop is settling. */
  function discardCapture(session: Session, fields: Record<string, unknown>): IpcResult<DiscardCaptureResult> {
    const slot = captureFor(session, fields.captureHandle);
    if (slot === null || slot.discarded) return rejected('denied');
    discardStream(slot);
    if (slot.phase !== 'stopping') releaseCapture(slot); // a settling stop releases it
    return ok({ status: 'discarded' });
  }

  type Resolved =
    | { readonly ok: false; readonly result: IpcResult<never> }
    | { readonly ok: true; readonly intent: 'createSession'; readonly caller: Caller }
    | { readonly ok: true; readonly intent: Exclude<Intent, 'createSession'>; readonly session: Session; readonly fields: Record<string, unknown> };

  /** Every check both entry points share, including the session binding. Add per-intent checks here. */
  function resolveCall(channel: string, caller: Caller | null, payload: unknown): Resolved {
    const call = admitCall(channel, caller, payload);
    if (!call.ok) return call;
    if (call.intent === 'createSession') return { ok: true, intent: 'createSession', caller: call.caller };
    const session = registry.find(call.caller.windowId, call.payload.sessionId, call.payload.epoch);
    if (session === null) return { ok: false, result: rejected('denied') };
    return { ok: true, intent: call.intent, session, fields: call.payload };
  }

  async function invoke(channel: string, caller: Caller | null, payload: unknown): Promise<IpcResult<unknown>> {
    const call = resolveCall(channel, caller, payload);
    if (call.ok && call.intent === 'chooseAudio') return chooseAudio(call.session);
    if (call.ok && call.intent === 'startCapture') return startCapture(call.session);
    if (call.ok && call.intent === 'stopCapture') return stopCapture(call.session, call.fields);
    return handle(channel, caller, payload);
  }

  function handle(channel: string, caller: Caller | null, payload: unknown): IpcResult<unknown> {
    const call = resolveCall(channel, caller, payload);
    if (!call.ok) return call.result;

    if (call.intent === 'createSession') {
      const current = registry.current(call.caller.windowId);
      if (current !== null) closeSession(current);
      const session = registry.open(call.caller.windowId);
      // Every unknown outcome in the app, so a reload or later session shows that work waits and can reach Inspect.
      const opened: SessionOpened = { ...envelope(session), capabilities: capabilities(), unresolved: [...unresolved.values()].map(outcomeReport) };
      return ok(opened);
    }

    const { session, fields } = call;
    switch (call.intent) {
      case 'closeSession': {
        closeSession(session);
        const closed: CloseResult = { closed: true };
        return ok(closed);
      }
      case 'getCapabilities':
        return ok(capabilities());
      case 'rewrite':
        return rewrite(session, fields);
      case 'cancel':
        return cancel(session, fields);
      case 'copyDraft':
        return copyDraft(session, fields);
      case 'chooseAudio':
        return rejected('unsupported'); // async: only through invoke()
      case 'transcribe':
        return transcribe(session, fields);
      case 'microphoneStatus':
        return microphoneStatus();
      case 'discardCapture':
        return discardCapture(session, fields);
      case 'startCapture':
      case 'stopCapture':
        return rejected('unsupported'); // async: only through invoke()
      case 'acknowledgeOutcome':
        return acknowledgeOutcome(session, fields);
    }
  }

  return {
    registerWindow: registry.registerWindow,
    windowNavigated(windowId) {
      const session = registry.current(windowId);
      if (session !== null) closeSession(session);
    },
    windowClosed(windowId) {
      dropCapture(windowId);
      const session = registry.forgetWindow(windowId);
      if (session !== null) for (const job of running.values()) if (job.session === session) requestCancel(job);
    },
    invoke,
    handle,
    reconcile(jobId) {
      const job = unresolved.get(jobId);
      if (job === undefined) return false;
      clearGate(job);
      return true;
    },
  };
}
