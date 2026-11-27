/**
 * Proposed IPC v1 channels, payload schemas and result shapes (Packet C).
 * Not a shipped API.
 *
 * Pure data and validators only: no Electron, Node, DOM or network objects.
 * Main validates every inbound payload against REQUEST_SCHEMAS on its own,
 * whatever the renderer claims. The preload façade builds payloads with
 * exactly these fields and forwards only events that match EVENT_SCHEMAS.
 */
import { CONTRACT_VERSION, OUTCOME_CLEARANCES, OUTCOME_KINDS, ROUTE_MODES, isToken } from './session.ts';
import type { Envelope, FailureCode, MainEvent, OutcomeReport, RouteDescriptor } from './session.ts';

/** Fixed channel names. Only main and the preload façade know them. */
export const CHANNELS = Object.freeze({
  createSession: 'xenon:v1:session.create',
  closeSession: 'xenon:v1:session.close',
  getCapabilities: 'xenon:v1:capabilities',
  rewrite: 'xenon:v1:rewrite',
  cancel: 'xenon:v1:cancel',
  copyDraft: 'xenon:v1:draft.copy',
  /** Opens the native audio chooser for this session (Packet E). */
  chooseAudio: 'xenon:v1:audio.choose',
  /** Transcribes a chosen audio asset (Packet E2). */
  transcribe: 'xenon:v1:transcribe',
  /** Microphone permission state, never prompting (Packet E3). */
  microphoneStatus: 'xenon:v1:mic.status',
  /** Starts recording after a deliberate action; prompts for permission only if never asked. */
  startCapture: 'xenon:v1:capture.start',
  stopCapture: 'xenon:v1:capture.stop',
  discardCapture: 'xenon:v1:capture.discard',
  /**
   * The user acknowledges one unknown outcome in Inspect, for a route whose
   * card allows it (the local base rewrite route). Clears that gate only.
   */
  acknowledgeOutcome: 'xenon:v1:outcome.acknowledge',
  /** Main → renderer, ordered: accepted, then one terminal, then any reconcile. */
  event: 'xenon:v1:event',
});

export type Intent = Exclude<keyof typeof CHANNELS, 'event'>;

export const ROUTE_STAGES = ['rewrite', 'transcribe'] as const;
export type RouteStage = (typeof ROUTE_STAGES)[number];

/** Where a route processes data. Fixture routes are always "synthetic". */
export const LOCATION_CLASSES = ['synthetic', 'local', 'remote'] as const;
export type LocationClass = (typeof LOCATION_CLASSES)[number];

export const ROUTE_READINESS = ['ready', 'disabled'] as const;
export type RouteReadiness = (typeof ROUTE_READINESS)[number];

/**
 * A route as main publishes it to the renderer: the descriptor plus display
 * and policy facts. Never credentials, URLs, headers or a model override.
 */
export interface PublishedRoute extends RouteDescriptor {
  readonly stage: RouteStage;
  readonly label: string;
  readonly locationClass: LocationClass;
  readonly readiness: RouteReadiness;
}

/** Session intents main currently allows, besides opening and closing. */
export type CapabilityAction = 'rewrite' | 'cancel' | 'copyDraft' | 'chooseAudio' | 'transcribe' | 'capture';

export interface Capabilities {
  readonly actions: readonly CapabilityAction[];
  readonly routes: readonly PublishedRoute[];
}

/**
 * createSession result. One active session per window. `unresolved` lists
 * every unknown outcome in the app right now (the gate is app-wide), so a
 * reload or a later session learns that new work waits and can show Inspect.
 */
export interface SessionOpened extends Envelope {
  readonly capabilities: Capabilities;
  readonly unresolved: readonly OutcomeReport[];
}

export interface CreateSessionRequest {
  readonly v: typeof CONTRACT_VERSION;
}

/** Cancels by the renderer's request ID; job IDs may not have arrived yet. */
export interface CancelRequest extends Envelope {
  readonly clientRequestId: string;
}

/** Copies the draft main holds for this handle. There is no clipboard read. */
export interface CopyDraftRequest extends Envelope {
  readonly draftHandle: string;
}

/**
 * Local disposition only. "cancel_requested" never claims the remote request
 * was retracted: the job's terminal event, normally cancelled, follows.
 */
export type CancelDisposition = 'cancel_requested' | 'already_finished';

export interface CancelResult {
  readonly disposition: CancelDisposition;
}

/**
 * Acknowledges one unknown outcome. `jobId` is the exact ID main reported;
 * `clientRequestId` is fresh and single-use in the session.
 */
export interface AcknowledgeOutcomeRequest extends Envelope {
  readonly clientRequestId: string;
  readonly jobId: string;
}

export interface AcknowledgeResult {
  readonly status: 'acknowledged';
}

export interface CloseResult {
  readonly closed: true;
}

export interface CopyResult {
  readonly status: 'copied';
}

/** Safe facts about accepted audio. Never a path, file name or sample data. */
export interface AudioSummary {
  readonly format: 'wav-pcm16-mono-16k';
  readonly durationMs: number;
  readonly bytes: number;
}

/**
 * Microphone permission as the OS reports it (platform design). "not_requested"
 * is the only state in which main will show the OS prompt, and only from a
 * startCapture intent. Denied and restricted are different: restricted means
 * system policy, not a choice the user can undo in place.
 */
export const MICROPHONE_STATES = ['not_requested', 'granted', 'denied', 'restricted', 'unsupported', 'unknown'] as const;
export type MicrophoneState = (typeof MICROPHONE_STATES)[number];

export interface MicrophoneStatus {
  readonly microphone: MicrophoneState;
}

/** Why a capture could not start although permission is granted (platform design). */
export const CAPTURE_UNAVAILABLE_REASONS = ['no_input', 'in_use', 'failed'] as const;
export type CaptureUnavailableReason = (typeof CAPTURE_UNAVAILABLE_REASONS)[number];

/**
 * startCapture result. None of these is an error:
 * - "blocked": permission is not granted; explain it and keep Type and Import.
 * - "unavailable": no input, input in use (temporarily) or the device failed;
 *   offer device settings and retry.
 * - "already_recording": a capture is open somewhere in the app.
 */
export type StartCaptureResult =
  | { readonly status: 'recording'; readonly captureHandle: string; readonly maxDurationMs: number }
  | { readonly status: 'blocked'; readonly microphone: MicrophoneState }
  | { readonly status: 'unavailable'; readonly reason: CaptureUnavailableReason }
  | { readonly status: 'already_recording' };

/** Why a recording ended without Stop. What was recorded is kept until Stop or Discard. */
export const CAPTURE_END_REASONS = ['max_duration', 'device_lost', 'revoked'] as const;
export type CaptureEndReason = (typeof CAPTURE_END_REASONS)[number];

export interface DiscardCaptureResult {
  readonly status: 'discarded';
}

/**
 * chooseAudio result. Closing the chooser is not an error and changes
 * nothing; neither is a chooser that is already open in this window. A chosen
 * file becomes a main-held asset, named by an opaque, session-bound token.
 * Failures are codes: `invalid_input`/`unsupported` mean "choose another",
 * `route_unavailable` means the dialog failed, `denied` means the session
 * ended, and `unsupported` without a chooser capability means no chooser.
 */
export type ChooseAudioResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'already_open' }
  | { readonly status: 'chosen'; readonly assetToken: string; readonly summary: AudioSummary };

/** Every invoke resolves to this. Rejections carry a safe code, never detail. */
export type IpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: FailureCode };

// ---------------------------------------------------------------------------
// Schemas

/**
 * Field kinds. "count" is a non-negative safe integer (revisions, epochs);
 * "text" is any string, bounded later by the route's byte limits.
 */
export type FieldKind = 'version' | 'token' | 'nullableToken' | 'count' | 'text' | 'mode' | 'code' | 'eventType' | 'outcomeKind' | 'clearance';
export type Schema = Readonly<Record<string, FieldKind>>;

const ENVELOPE_SCHEMA = { v: 'version', sessionId: 'token', epoch: 'count' } as const;

/** Exact fields per intent. Anything missing, extra or mistyped is rejected. */
export const REQUEST_SCHEMAS: Readonly<Record<Intent, Schema>> = Object.freeze({
  createSession: { v: 'version' },
  closeSession: ENVELOPE_SCHEMA,
  getCapabilities: ENVELOPE_SCHEMA,
  rewrite: {
    ...ENVELOPE_SCHEMA,
    clientRequestId: 'token',
    routeKey: 'token',
    sourceRevision: 'count',
    steeringRevision: 'count',
    transcript: 'text',
    steering: 'text',
  },
  cancel: { ...ENVELOPE_SCHEMA, clientRequestId: 'token' },
  copyDraft: { ...ENVELOPE_SCHEMA, draftHandle: 'token' },
  chooseAudio: ENVELOPE_SCHEMA,
  transcribe: { ...ENVELOPE_SCHEMA, clientRequestId: 'token', routeKey: 'token', assetToken: 'token', sourceRevision: 'count' },
  microphoneStatus: ENVELOPE_SCHEMA,
  startCapture: ENVELOPE_SCHEMA,
  stopCapture: { ...ENVELOPE_SCHEMA, captureHandle: 'token' },
  discardCapture: { ...ENVELOPE_SCHEMA, captureHandle: 'token' },
  acknowledgeOutcome: { ...ENVELOPE_SCHEMA, clientRequestId: 'token', jobId: 'token' },
});

/** Exact fields of one OutcomeReport, in SessionOpened.unresolved and the outcome.unresolved event. */
export const OUTCOME_REPORT_SCHEMA = Object.freeze({ kind: 'outcomeKind', jobId: 'token', routeKey: 'token', sentAt: 'count', clearance: 'clearance' } as const);

const EVENT_BASE = { ...ENVELOPE_SCHEMA, type: 'eventType', clientRequestId: 'token' } as const;

/** Exact fields per main → renderer event type. */
export const EVENT_SCHEMAS: Readonly<Record<MainEvent['type'], Schema>> = Object.freeze({
  'rewrite.accepted': { ...EVENT_BASE, jobId: 'token', sourceRevision: 'count', steeringRevision: 'count' },
  'rewrite.succeeded': {
    ...EVENT_BASE,
    jobId: 'token',
    sourceRevision: 'count',
    steeringRevision: 'count',
    actualMode: 'mode',
    actualIdentity: 'token',
    text: 'text',
    draftHandle: 'token',
  },
  // The code stays a plain string here: the reducer turns unknown codes into
  // unknown_outcome, which is safer than dropping a terminal event.
  'rewrite.failed': { ...EVENT_BASE, jobId: 'nullableToken', code: 'code' },
  'rewrite.reconciled': { ...EVENT_BASE, jobId: 'nullableToken' },
  'transcribe.accepted': { ...EVENT_BASE, jobId: 'token', sourceRevision: 'count' },
  'transcribe.succeeded': { ...EVENT_BASE, jobId: 'token', sourceRevision: 'count', actualMode: 'mode', actualIdentity: 'token', text: 'text' },
  'transcribe.failed': { ...EVENT_BASE, jobId: 'nullableToken', code: 'code' },
  'transcribe.reconciled': { ...EVENT_BASE, jobId: 'nullableToken' },
  'capture.ended': { ...ENVELOPE_SCHEMA, type: 'eventType', captureHandle: 'token', reason: 'code' },
  'outcome.unresolved': { ...ENVELOPE_SCHEMA, type: 'eventType', ...OUTCOME_REPORT_SCHEMA },
  'outcome.cleared': { ...ENVELOPE_SCHEMA, type: 'eventType', kind: 'outcomeKind', jobId: 'token' },
});

/** A structured-clone-style plain object: no prototype tricks, accessors or symbols. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true;
  });
}

/** Non-negative safe integer. */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function fieldMatches(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'version':
      return value === CONTRACT_VERSION;
    case 'token':
      return isToken(value);
    case 'nullableToken':
      return value === null || isToken(value);
    case 'count':
      return isCount(value);
    case 'text':
      return typeof value === 'string';
    case 'mode':
      return (ROUTE_MODES as readonly unknown[]).includes(value);
    case 'code':
      return typeof value === 'string' && value !== '';
    case 'eventType':
      return typeof value === 'string' && Object.hasOwn(EVENT_SCHEMAS, value);
    case 'outcomeKind':
      return (OUTCOME_KINDS as readonly unknown[]).includes(value);
    case 'clearance':
      return (OUTCOME_CLEARANCES as readonly unknown[]).includes(value);
  }
}

export type SchemaVerdict = 'ok' | 'unsupported_version' | 'invalid';

/**
 * Checks a payload against a schema. A wrong version is reported separately
 * so callers can answer "unsupported" rather than "invalid input".
 */
export function checkSchema(value: unknown, schema: Schema): SchemaVerdict {
  if (!isPlainRecord(value)) return 'invalid';
  if ('v' in schema && Object.hasOwn(value, 'v') && value.v !== CONTRACT_VERSION) return 'unsupported_version';
  const expected = Object.keys(schema);
  const actual = Object.keys(value);
  if (actual.length !== expected.length) return 'invalid';
  for (const key of expected) {
    const kind = schema[key];
    if (kind === undefined || !Object.hasOwn(value, key) || !fieldMatches(kind, value[key])) return 'invalid';
  }
  return 'ok';
}

/** An outcome report with exactly its fields, as a fresh frozen copy, or null. */
export function readOutcomeReport(value: unknown): OutcomeReport | null {
  if (checkSchema(value, OUTCOME_REPORT_SCHEMA) !== 'ok' || !isPlainRecord(value)) return null;
  return Object.freeze(pickSchemaFields(value, OUTCOME_REPORT_SCHEMA)) as unknown as OutcomeReport;
}

/** Copies exactly the schema's fields, so nothing else crosses the bridge. */
export function pickSchemaFields(value: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) copy[key] = value[key];
  return copy;
}
