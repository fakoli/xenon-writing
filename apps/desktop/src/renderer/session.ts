/**
 * Pure renderer reducer for one writing session (Packet A).
 *
 * It owns transcript and steering revisions, the single in-flight rewrite
 * snapshot, the reviewable draft and a safe status code. It performs no I/O.
 * Callers dispatch user intents and main-process events, and send
 * `rewriteRequest(state)` themselves. Behavior follows the interaction and
 * component designs, summarized in the invariants below.
 *
 * Since Packet E2 it also owns one synthetic transcription at a time. A
 * transcript for empty text fills the editor; a transcript for existing text
 * becomes a candidate the user must Replace or Keep (interaction design).
 *
 * Invariants:
 * - A late, stale or mismatched reply never replaces newer edits or a draft.
 * - A transcript never overwrites existing text without explicit Replace.
 * - Output is promoted only when its echoed revisions, route identity and
 *   session all match the request snapshot and the inputs have not changed.
 * - An unknown downstream outcome blocks new rewrites until main reconciles it.
 * - Unmatched events and no-op intents return the same state object.
 */
import { CONTRACT_VERSION, isFailureCode, isToken, utf8ByteLength } from '../contracts/session.ts';
import type {
  Envelope,
  FailureCode,
  MainEvent,
  RewriteAccepted,
  RewriteFailed,
  RewriteRequest,
  RewriteSucceeded,
  RouteDescriptor,
  RouteMode,
  TranscribeAccepted,
  TranscribeFailed,
  TranscribeRequest,
  TranscribeSucceeded,
} from '../contracts/session.ts';

export type JobKind = 'rewrite' | 'transcribe';

/** Correlates one attempt. jobId stays null until main accepts it. Events of the other kind never match. */
export interface JobRef {
  readonly kind: JobKind;
  readonly clientRequestId: string;
  readonly jobId: string | null;
}

/** Request snapshot frozen at dispatch. Later edits never change it. */
export interface PendingRewrite extends JobRef {
  readonly kind: 'rewrite';
  readonly route: RouteDescriptor;
  readonly sourceRevision: number;
  readonly steeringRevision: number;
  readonly transcript: string;
  readonly steering: string;
}

/** A transcription in flight. The source revision it was asked for decides whether it still applies. */
export interface PendingTranscription extends JobRef {
  readonly kind: 'transcribe';
  readonly route: RouteDescriptor;
  readonly sourceRevision: number;
  readonly assetToken: string;
}

/** A finished transcript waiting for the user to Replace the existing text or Keep it. */
export interface TranscriptCandidate {
  readonly jobId: string;
  /** The audio it came from; choosing other audio drops it. */
  readonly assetToken: string;
  readonly text: string;
  readonly mode: RouteMode;
  readonly identity: string;
  readonly sourceRevision: number;
}

/** A reviewable draft. Never written back into the transcript. */
export interface Draft {
  readonly jobId: string;
  readonly draftHandle: string;
  readonly text: string;
  readonly mode: RouteMode;
  readonly identity: string;
  readonly sourceRevision: number;
  readonly steeringRevision: number;
}

/** Safe status for the last attempt; never provider text or raw errors. */
export type NoticeCode = FailureCode | 'result_outdated';

export interface SessionState {
  readonly sessionId: string;
  readonly epoch: number;
  readonly route: RouteDescriptor | null;
  /** Transcription route, or null when audio cannot be transcribed. */
  readonly transcribeRoute: RouteDescriptor | null;
  readonly transcript: string;
  readonly steering: string;
  readonly sourceRevision: number;
  readonly steeringRevision: number;
  readonly pending: PendingRewrite | null;
  readonly transcription: PendingTranscription | null;
  readonly candidate: TranscriptCandidate | null;
  /** Token of the audio currently chosen or recorded, or null. Only it can be transcribed. */
  readonly selectedAsset: string | null;
  readonly draft: Draft | null;
  readonly notice: NoticeCode | null;
  /** Attempts with unknown downstream outcome; each blocks new rewrites. */
  readonly unresolved: readonly JobRef[];
  /**
   * Locally cancelled attempts still awaiting their terminal event from main.
   * Their downstream outcome is unknown, so they also block new rewrites.
   */
  readonly abandoned: readonly JobRef[];
  /**
   * Every clientRequestId issued in this session. IDs are never reused, so a
   * replayed reply for an old request cannot settle a new one. Grows by one
   * short ID per rewrite and is discarded with the session.
   */
  readonly requestIds: readonly string[];
}

export type UserIntent =
  | { readonly type: 'edit.transcript'; readonly text: string }
  | { readonly type: 'edit.steering'; readonly text: string }
  /** clientRequestId must be fresh for the session, e.g. crypto.randomUUID(). */
  | { readonly type: 'rewrite.request'; readonly clientRequestId: string }
  | { readonly type: 'rewrite.cancel'; readonly clientRequestId: string }
  /** assetToken comes from chooseAudio; clientRequestId must be fresh. */
  | { readonly type: 'transcribe.request'; readonly clientRequestId: string; readonly assetToken: string }
  | { readonly type: 'transcribe.cancel'; readonly clientRequestId: string }
  /**
   * Audio was chosen or recorded (main returned this token). A transcription
   * or candidate from other audio no longer applies (interaction design).
   */
  | { readonly type: 'audio.chosen'; readonly assetToken: string }
  /** Deliberate confirmation: the candidate replaces the transcript. */
  | { readonly type: 'candidate.replace' }
  | { readonly type: 'candidate.keep' };

export type SessionAction = UserIntent | MainEvent;

export function createSession(init: {
  readonly sessionId: string;
  readonly epoch: number;
  readonly route: RouteDescriptor | null;
  readonly transcribeRoute?: RouteDescriptor | null;
}): SessionState {
  return {
    sessionId: init.sessionId,
    epoch: init.epoch,
    route: init.route,
    transcribeRoute: init.transcribeRoute ?? null,
    transcript: '',
    steering: '',
    sourceRevision: 0,
    steeringRevision: 0,
    pending: null,
    transcription: null,
    candidate: null,
    selectedAsset: null,
    draft: null,
    notice: null,
    unresolved: [],
    abandoned: [],
    requestIds: [],
  };
}

export function reduce(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'edit.transcript': {
      if (typeof action.text !== 'string' || action.text === state.transcript) return state;
      const edited = { ...state, transcript: action.text, sourceRevision: state.sourceRevision + 1 };
      // Typing over a waiting candidate keeps the user's text; the candidate no longer applies.
      return state.candidate === null ? edited : { ...edited, candidate: null, notice: 'result_outdated' };
    }
    case 'edit.steering':
      if (typeof action.text !== 'string' || action.text === state.steering) return state;
      return { ...state, steering: action.text, steeringRevision: state.steeringRevision + 1 };
    case 'rewrite.request':
      return requestRewrite(state, action.clientRequestId);
    case 'rewrite.cancel':
      return cancelRewrite(state, action.clientRequestId);
    case 'transcribe.request':
      return requestTranscription(state, action.clientRequestId, action.assetToken);
    case 'transcribe.cancel':
      return cancelTranscription(state, action.clientRequestId);
    case 'candidate.replace': {
      // Any edit clears the candidate, so it always targets the current text.
      const c = state.candidate;
      if (c === null) return state;
      return { ...state, transcript: c.text, sourceRevision: state.sourceRevision + 1, candidate: null, notice: null };
    }
    case 'candidate.keep':
      return state.candidate === null ? state : { ...state, candidate: null };
    case 'audio.chosen':
      return chooseAudio(state, action.assetToken);
    case 'rewrite.accepted':
    case 'rewrite.succeeded':
    case 'rewrite.failed':
    case 'rewrite.reconciled':
    case 'transcribe.accepted':
    case 'transcribe.succeeded':
    case 'transcribe.failed':
    case 'transcribe.reconciled':
      return isForSession(state, action) ? applyMainEvent(state, action) : state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selectors

export type RewriteBlocker =
  | 'no_route'
  | 'pending'
  | 'awaiting_cancellation'
  | 'unresolved_outcome'
  | 'empty_transcript'
  | 'transcript_too_large'
  | 'steering_too_large';

/** Why Rewrite is disabled, or null when it may be requested. */
export function rewriteBlocker(state: SessionState): RewriteBlocker | null {
  const route = state.route;
  if (route === null) return 'no_route';
  if (state.pending !== null || state.transcription !== null) return 'pending';
  if (state.abandoned.length > 0) return 'awaiting_cancellation';
  if (state.unresolved.length > 0) return 'unresolved_outcome';
  if (state.transcript.trim() === '') return 'empty_transcript';
  if (utf8ByteLength(state.transcript) > route.limits.transcriptBytes) return 'transcript_too_large';
  if (utf8ByteLength(state.steering) > route.limits.steeringBytes) return 'steering_too_large';
  return null;
}

/** The frozen v1 request for the in-flight rewrite, or null when idle. */
export function rewriteRequest(state: SessionState): RewriteRequest | null {
  const p = state.pending;
  if (p === null) return null;
  return {
    v: CONTRACT_VERSION,
    sessionId: state.sessionId,
    epoch: state.epoch,
    clientRequestId: p.clientRequestId,
    routeKey: p.route.routeKey,
    sourceRevision: p.sourceRevision,
    steeringRevision: p.steeringRevision,
    transcript: p.transcript,
    steering: p.steering,
  };
}

export type TranscribeBlocker = 'no_route' | 'pending' | 'awaiting_cancellation' | 'unresolved_outcome' | 'candidate_open';

/** Why Transcribe is disabled, or null. One processing job at a time, as for rewrites. */
export function transcribeBlocker(state: SessionState): TranscribeBlocker | null {
  if (state.transcribeRoute === null) return 'no_route';
  if (state.pending !== null || state.transcription !== null) return 'pending';
  if (state.abandoned.length > 0) return 'awaiting_cancellation';
  if (state.unresolved.length > 0) return 'unresolved_outcome';
  if (state.candidate !== null) return 'candidate_open';
  return null;
}

/** The frozen v1 request for the in-flight transcription, or null. */
export function transcribeRequest(state: SessionState): TranscribeRequest | null {
  const t = state.transcription;
  if (t === null) return null;
  return {
    v: CONTRACT_VERSION,
    sessionId: state.sessionId,
    epoch: state.epoch,
    clientRequestId: t.clientRequestId,
    routeKey: t.route.routeKey,
    assetToken: t.assetToken,
    sourceRevision: t.sourceRevision,
  };
}

/**
 * "current": the draft was produced from the text now in the editor.
 * "previous": the inputs changed or a regeneration is in flight; label it
 * "Previous draft".
 */
export type DraftStatus = 'none' | 'current' | 'previous';

export function draftStatus(state: SessionState): DraftStatus {
  const d = state.draft;
  if (d === null) return 'none';
  if (state.pending !== null) return 'previous';
  if (d.sourceRevision !== state.sourceRevision || d.steeringRevision !== state.steeringRevision) {
    return 'previous';
  }
  return 'current';
}

export type SessionPhase = 'idle' | 'editing' | 'pending' | 'ready';

export function phase(state: SessionState): SessionPhase {
  if (state.pending !== null || state.transcription !== null) return 'pending';
  if (draftStatus(state) === 'current') return 'ready';
  if (state.transcript !== '' || state.steering !== '' || state.draft !== null) return 'editing';
  return 'idle';
}

/**
 * Whether an explicit Copy draft is available. Copying a previous draft must
 * be confirmed with prior-draft labeling. Copy never marks a draft accepted
 * or training-eligible.
 */
export type CopyEligibility =
  | { readonly allowed: false; readonly reason: 'no_draft' }
  | {
      readonly allowed: true;
      readonly draftHandle: string;
      readonly draftStatus: 'current' | 'previous';
      readonly requiresConfirmation: boolean;
    };

export function copyEligibility(state: SessionState): CopyEligibility {
  const status = draftStatus(state);
  if (state.draft === null || status === 'none') return { allowed: false, reason: 'no_draft' };
  return {
    allowed: true,
    draftHandle: state.draft.draftHandle,
    draftStatus: status,
    requiresConfirmation: status === 'previous',
  };
}

// ---------------------------------------------------------------------------
// User intents

function requestRewrite(state: SessionState, clientRequestId: string): SessionState {
  const route = state.route;
  if (route === null || rewriteBlocker(state) !== null) return state;
  if (!isToken(clientRequestId) || state.requestIds.includes(clientRequestId)) return state;
  return {
    ...state,
    notice: null,
    requestIds: [...state.requestIds, clientRequestId],
    pending: {
      kind: 'rewrite',
      clientRequestId,
      jobId: null,
      route,
      sourceRevision: state.sourceRevision,
      steeringRevision: state.steeringRevision,
      transcript: state.transcript,
      steering: state.steering,
    },
  };
}

/**
 * Local cancellation: return to editing with edits and prior draft intact.
 * This does not claim the remote request was retracted. The attempt is kept
 * as abandoned, which blocks new rewrites until main reports its terminal
 * outcome (normally `rewrite.failed` with `cancelled`). A late unknown outcome
 * moves it to the reconcile gate. Cancelling anything but the current
 * in-flight request is a no-op.
 */
function cancelRewrite(state: SessionState, clientRequestId: string): SessionState {
  const p = state.pending;
  if (p === null || p.clientRequestId !== clientRequestId) return state;
  return {
    ...state,
    pending: null,
    notice: 'cancelled',
    abandoned: [...state.abandoned, { kind: 'rewrite', clientRequestId: p.clientRequestId, jobId: p.jobId }],
  };
}

/**
 * New audio replaces the old. An in-flight transcription of other audio is
 * abandoned (its terminal still has to arrive, as for a cancel), and a
 * candidate from other audio is dropped, so neither can overwrite anything.
 */
function chooseAudio(state: SessionState, assetToken: string): SessionState {
  if (!isToken(assetToken) || assetToken === state.selectedAsset) return state;
  let next: SessionState = { ...state, selectedAsset: assetToken };
  const t = state.transcription;
  if (t !== null && t.assetToken !== assetToken) {
    next = {
      ...next,
      transcription: null,
      notice: 'result_outdated',
      abandoned: [...state.abandoned, { kind: 'transcribe', clientRequestId: t.clientRequestId, jobId: t.jobId }],
    };
  }
  if (state.candidate !== null && state.candidate.assetToken !== assetToken) next = { ...next, candidate: null, notice: 'result_outdated' };
  return next;
}

function requestTranscription(state: SessionState, clientRequestId: string, assetToken: string): SessionState {
  const route = state.transcribeRoute;
  if (route === null || transcribeBlocker(state) !== null) return state;
  if (!isToken(clientRequestId) || assetToken !== state.selectedAsset || state.requestIds.includes(clientRequestId)) return state;
  return {
    ...state,
    notice: null,
    requestIds: [...state.requestIds, clientRequestId],
    transcription: { kind: 'transcribe', clientRequestId, jobId: null, route, sourceRevision: state.sourceRevision, assetToken },
  };
}

/** As for rewrites: local, immediate, and blocking until main reports the outcome. */
function cancelTranscription(state: SessionState, clientRequestId: string): SessionState {
  const t = state.transcription;
  if (t === null || t.clientRequestId !== clientRequestId) return state;
  return {
    ...state,
    transcription: null,
    notice: 'cancelled',
    abandoned: [...state.abandoned, { kind: 'transcribe', clientRequestId: t.clientRequestId, jobId: t.jobId }],
  };
}

// ---------------------------------------------------------------------------
// Main-process events

function eventKind(event: MainEvent): JobKind {
  return event.type.startsWith('transcribe.') ? 'transcribe' : 'rewrite';
}

function applyMainEvent(state: SessionState, event: MainEvent): SessionState {
  // Capture events carry no request or job ID, so they never settle an attempt.
  if (event.type === 'capture.ended') return state;
  const kind = eventKind(event);
  if (event.type === 'rewrite.reconciled' || event.type === 'transcribe.reconciled') {
    // Request IDs are unique per session, so kind and request ID identify the
    // attempt. A job ID, when both sides have one, must still agree.
    const reconciles = (ref: JobRef) =>
      ref.kind === kind &&
      ref.clientRequestId === event.clientRequestId &&
      (ref.jobId === null || event.jobId === null || ref.jobId === event.jobId);
    const remaining = state.unresolved.filter((ref) => !reconciles(ref));
    return remaining.length === state.unresolved.length ? state : { ...state, unresolved: remaining };
  }
  const p = state.pending;
  if (p !== null && matches(p, kind, event.clientRequestId, event.jobId)) {
    switch (event.type) {
      case 'rewrite.accepted':
        return acceptPending(state, p, event);
      case 'rewrite.succeeded':
        return settleSuccess(state, p, event);
      case 'rewrite.failed':
        return settleFailure(state, p, event);
    }
  }
  const t = state.transcription;
  if (t !== null && matches(t, kind, event.clientRequestId, event.jobId)) {
    switch (event.type) {
      case 'transcribe.accepted':
        return acceptTranscription(state, t, event);
      case 'transcribe.succeeded':
        return settleTranscription(state, t, event);
      case 'transcribe.failed':
        return failTranscription(state, t, event);
    }
  }
  const index = state.abandoned.findIndex((ref) => matches(ref, kind, event.clientRequestId, event.jobId));
  return index === -1 ? state : applyToAbandoned(state, index, event);
}

function acceptTranscription(state: SessionState, t: PendingTranscription, event: TranscribeAccepted): SessionState {
  if (t.jobId !== null || !isToken(event.jobId) || event.sourceRevision !== t.sourceRevision) return state;
  return { ...state, transcription: { ...t, jobId: event.jobId } };
}

/** Integrity and identity problems first, then staleness, as for rewrites. */
function transcriptionVerdict(state: SessionState, t: PendingTranscription, event: TranscribeSucceeded): NoticeCode | null {
  if (!isToken(event.jobId) || event.sourceRevision !== t.sourceRevision) return 'invalid_response';
  if (event.actualMode !== t.route.mode || event.actualIdentity !== t.route.identity) return 'provider_mismatch';
  if (typeof event.text !== 'string' || event.text.trim() === '') return 'invalid_response';
  if (utf8ByteLength(event.text) > t.route.limits.transcriptBytes) return 'invalid_response';
  // The user typed, replaced or started over since asking: nothing is overwritten.
  if (t.sourceRevision !== state.sourceRevision) return 'result_outdated';
  return null;
}

function settleTranscription(state: SessionState, t: PendingTranscription, event: TranscribeSucceeded): SessionState {
  const verdict = transcriptionVerdict(state, t, event);
  if (verdict !== null) return { ...state, transcription: null, notice: verdict };
  // Empty text is filled directly. Any existing text, even whitespace, needs a deliberate Replace.
  if (state.transcript === '') {
    return { ...state, transcription: null, notice: null, transcript: event.text, sourceRevision: state.sourceRevision + 1 };
  }
  const candidate: TranscriptCandidate = {
    jobId: event.jobId,
    assetToken: t.assetToken,
    text: event.text,
    mode: event.actualMode,
    identity: event.actualIdentity,
    sourceRevision: state.sourceRevision,
  };
  return { ...state, transcription: null, notice: null, candidate };
}

function failTranscription(state: SessionState, t: PendingTranscription, event: TranscribeFailed): SessionState {
  const code = safeFailureCode(event.code);
  const ref: JobRef = { kind: 'transcribe', clientRequestId: t.clientRequestId, jobId: t.jobId ?? tokenOrNull(event.jobId) };
  return {
    ...state,
    transcription: null,
    notice: code,
    unresolved: code === 'unknown_outcome' ? [...state.unresolved, ref] : state.unresolved,
  };
}

function acceptPending(state: SessionState, p: PendingRewrite, event: RewriteAccepted): SessionState {
  if (p.jobId !== null || !isToken(event.jobId)) return state;
  if (event.sourceRevision !== p.sourceRevision || event.steeringRevision !== p.steeringRevision) return state;
  return { ...state, pending: { ...p, jobId: event.jobId } };
}

function settleSuccess(state: SessionState, p: PendingRewrite, event: RewriteSucceeded): SessionState {
  const verdict = successVerdict(state, p, event);
  if (verdict !== null) return { ...state, pending: null, notice: verdict };
  return {
    ...state,
    pending: null,
    notice: null,
    draft: {
      jobId: event.jobId,
      draftHandle: event.draftHandle,
      text: event.text,
      mode: event.actualMode,
      identity: event.actualIdentity,
      sourceRevision: p.sourceRevision,
      steeringRevision: p.steeringRevision,
    },
  };
}

/** Integrity and identity problems take precedence over staleness. */
function successVerdict(state: SessionState, p: PendingRewrite, event: RewriteSucceeded): NoticeCode | null {
  if (!isToken(event.jobId) || !isToken(event.draftHandle)) return 'invalid_response';
  if (event.sourceRevision !== p.sourceRevision || event.steeringRevision !== p.steeringRevision) {
    return 'invalid_response';
  }
  if (event.actualMode !== p.route.mode || event.actualIdentity !== p.route.identity) return 'provider_mismatch';
  if (typeof event.text !== 'string' || event.text.trim() === '') return 'invalid_response';
  if (utf8ByteLength(event.text) > p.route.limits.draftBytes) return 'invalid_response';
  if (p.sourceRevision !== state.sourceRevision || p.steeringRevision !== state.steeringRevision) {
    return 'result_outdated';
  }
  if (!sameRoute(state.route, p.route)) return 'result_outdated';
  return null;
}

function settleFailure(state: SessionState, p: PendingRewrite, event: RewriteFailed): SessionState {
  const code = safeFailureCode(event.code);
  const ref: JobRef = { kind: 'rewrite', clientRequestId: p.clientRequestId, jobId: p.jobId ?? tokenOrNull(event.jobId) };
  return {
    ...state,
    pending: null,
    notice: code,
    unresolved: code === 'unknown_outcome' ? [...state.unresolved, ref] : state.unresolved,
  };
}

/**
 * A cancelled attempt never promotes output or changes the notice. Its
 * terminal event retires it, but an unknown outcome still gates new rewrites.
 */
function applyToAbandoned(state: SessionState, index: number, event: MainEvent): SessionState {
  const ref = state.abandoned[index];
  if (ref === undefined) return state;
  if (event.type === 'rewrite.accepted' || event.type === 'transcribe.accepted') {
    if (ref.jobId !== null || !isToken(event.jobId)) return state;
    const abandoned = state.abandoned.map((r, i) => (i === index ? { ...r, jobId: event.jobId } : r));
    return { ...state, abandoned };
  }
  const abandoned = state.abandoned.filter((_, i) => i !== index);
  if ((event.type === 'rewrite.failed' || event.type === 'transcribe.failed') && safeFailureCode(event.code) === 'unknown_outcome') {
    const settled: JobRef = { kind: ref.kind, clientRequestId: ref.clientRequestId, jobId: ref.jobId ?? tokenOrNull(event.jobId) };
    return { ...state, abandoned, unresolved: [...state.unresolved, settled] };
  }
  return { ...state, abandoned };
}

// ---------------------------------------------------------------------------
// Helpers

function tokenOrNull(value: unknown): string | null {
  return isToken(value) ? value : null;
}

/** Unrecognized codes become unknown outcomes: unknown is not completed. */
function safeFailureCode(code: unknown): FailureCode {
  return isFailureCode(code) ? code : 'unknown_outcome';
}

function isForSession(state: SessionState, event: Envelope): boolean {
  return event.v === CONTRACT_VERSION && event.sessionId === state.sessionId && event.epoch === state.epoch;
}

/** Same kind and request; once a job ID is known, the event must carry exactly it. */
function matches(ref: JobRef, kind: JobKind, clientRequestId: unknown, jobId: unknown): boolean {
  if (ref.kind !== kind || ref.clientRequestId !== clientRequestId) return false;
  return ref.jobId === null || ref.jobId === jobId;
}

function sameRoute(a: RouteDescriptor | null, b: RouteDescriptor): boolean {
  return a !== null && a.routeKey === b.routeKey && a.mode === b.mode && a.identity === b.identity;
}
