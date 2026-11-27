/**
 * Versioned v1 session contracts shared by the renderer and the main process.
 *
 * Implements the *proposed* IPC v1 envelope between the renderer and main.
 * It is not a shipped API. This module
 * contains only data shapes and pure helpers: no Electron, Node, DOM,
 * filesystem or network objects.
 */

export const CONTRACT_VERSION = 1 as const;

/** Safe failure taxonomy. Carries no provider text, request body or trace. */
export const FAILURE_CODES = [
  'denied',
  'unsupported',
  'invalid_input',
  'route_unavailable',
  'timed_out',
  'cancelled',
  'unknown_outcome',
  'provider_mismatch',
  'invalid_response',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && (FAILURE_CODES as readonly string[]).includes(value);
}

/** Processing mode shown on the identity line. Fixture output is "synthetic". */
export const ROUTE_MODES = ['fixture', 'base', 'personalized'] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

/** Per-route size bounds, in UTF-8 bytes, enforced before dispatch and on reply. */
export interface RouteLimits {
  readonly transcriptBytes: number;
  readonly steeringBytes: number;
  readonly draftBytes: number;
}

/**
 * Fixture-only engineering defaults from the component design. They are
 * deterministic test values, not live-provider limits: each live route needs
 * its own approved limits before it is enabled.
 */
export const FIXTURE_LIMITS: RouteLimits = Object.freeze({
  transcriptBytes: 16 * 1024,
  steeringBytes: 2 * 1024,
  draftBytes: 24 * 1024,
});

/**
 * Policy-configured rewrite route issued by main. It never carries
 * credentials, URLs, headers or a model override.
 */
export interface RouteDescriptor {
  readonly routeKey: string;
  readonly mode: RouteMode;
  /** Exact identity a successful reply must echo, e.g. "fixture-v1". */
  readonly identity: string;
  readonly limits: RouteLimits;
}

const encoder = new TextEncoder();

/** UTF-8 byte length. Limits count bytes, not UTF-16 code units. */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Longest accepted opaque identifier: session, request, job or draft handle. */
export const MAX_TOKEN_LENGTH = 128;

/** Opaque identifier: a nonblank string of at most MAX_TOKEN_LENGTH characters. */
export function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TOKEN_LENGTH;
}

/** Fields every v1 message carries. */
export interface Envelope {
  readonly v: typeof CONTRACT_VERSION;
  readonly sessionId: string;
  readonly epoch: number;
}

/** Renderer → main. The snapshot is frozen when the user asks for a rewrite. */
export interface RewriteRequest extends Envelope {
  readonly clientRequestId: string;
  readonly routeKey: string;
  readonly sourceRevision: number;
  readonly steeringRevision: number;
  readonly transcript: string;
  readonly steering: string;
}

/** Main → renderer: the request was admitted and has a main-issued job ID. */
export interface RewriteAccepted extends Envelope {
  readonly type: 'rewrite.accepted';
  readonly clientRequestId: string;
  readonly jobId: string;
  readonly sourceRevision: number;
  readonly steeringRevision: number;
}

/** Main → renderer: terminal success with the provider-verified identity. */
export interface RewriteSucceeded extends Envelope {
  readonly type: 'rewrite.succeeded';
  readonly clientRequestId: string;
  readonly jobId: string;
  readonly sourceRevision: number;
  readonly steeringRevision: number;
  readonly actualMode: RouteMode;
  readonly actualIdentity: string;
  readonly text: string;
  /** Opaque main-held handle; the only way to request an explicit copy. */
  readonly draftHandle: string;
}

/** Main → renderer: terminal failure. jobId is null if rejected before acceptance. */
export interface RewriteFailed extends Envelope {
  readonly type: 'rewrite.failed';
  readonly clientRequestId: string;
  readonly jobId: string | null;
  readonly code: FailureCode;
}

/** Main → renderer: an unknown outcome was independently reconciled. */
export interface OutcomeReconciled extends Envelope {
  readonly type: 'rewrite.reconciled';
  readonly clientRequestId: string;
  readonly jobId: string | null;
}

/** Renderer → main: transcribe a main-held audio asset (Packet E2). */
export interface TranscribeRequest extends Envelope {
  readonly clientRequestId: string;
  readonly routeKey: string;
  /** Opaque token from chooseAudio, bound to this session. */
  readonly assetToken: string;
  /** Transcript revision when the user asked; a later edit outdates the result. */
  readonly sourceRevision: number;
}

export interface TranscribeAccepted extends Envelope {
  readonly type: 'transcribe.accepted';
  readonly clientRequestId: string;
  readonly jobId: string;
  readonly sourceRevision: number;
}

/** Plain transcript text with the provider-verified identity. No handle: the text goes into the editor only on the user's say. */
export interface TranscribeSucceeded extends Envelope {
  readonly type: 'transcribe.succeeded';
  readonly clientRequestId: string;
  readonly jobId: string;
  readonly sourceRevision: number;
  readonly actualMode: RouteMode;
  readonly actualIdentity: string;
  readonly text: string;
}

export interface TranscribeFailed extends Envelope {
  readonly type: 'transcribe.failed';
  readonly clientRequestId: string;
  readonly jobId: string | null;
  readonly code: FailureCode;
}

export interface TranscribeReconciled extends Envelope {
  readonly type: 'transcribe.reconciled';
  readonly clientRequestId: string;
  readonly jobId: string | null;
}

/**
 * Main → renderer: a recording stopped by itself (time limit, device lost or
 * permission revoked). The UI stops showing "Recording"; what was captured is
 * kept until the user chooses Stop (keep) or Discard.
 */
export interface CaptureEnded extends Envelope {
  readonly type: 'capture.ended';
  readonly captureHandle: string;
  readonly reason: 'max_duration' | 'device_lost' | 'revoked';
}

/** Which processing job an unknown outcome belongs to. */
export const OUTCOME_KINDS = ['rewrite', 'transcribe'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/**
 * How an unknown outcome's gate can clear, from its route card:
 * - "acknowledge": the user acknowledges it in Inspect (the local base rewrite route: the
 *   service keeps no receipts to reconcile against);
 * - "restart": nothing in the app clears it; quitting does, because the gate
 *   lives in memory. Every route without a card that allows acknowledgment,
 *   fixture routes included.
 */
export const OUTCOME_CLEARANCES = ['acknowledge', 'restart'] as const;
export type OutcomeClearance = (typeof OUTCOME_CLEARANCES)[number];

/**
 * What main knows about one unknown outcome, reported to every session so a
 * reload or a later session can show Inspect. Never text, a draft or a reply.
 */
export interface OutcomeReport {
  readonly kind: OutcomeKind;
  /** The main-issued job ID; an acknowledgment must name exactly this. */
  readonly jobId: string;
  readonly routeKey: string;
  /** When main accepted the job and handed it to its route, in ms since the Unix epoch. */
  readonly sentAt: number;
  readonly clearance: OutcomeClearance;
}

/** Main → renderer: an outcome became unknown somewhere in the app, so new work waits. */
export interface OutcomeUnresolved extends Envelope, OutcomeReport {
  readonly type: 'outcome.unresolved';
}

/** Main → renderer: that outcome's gate cleared (acknowledged or reconciled). */
export interface OutcomeCleared extends Envelope {
  readonly type: 'outcome.cleared';
  readonly kind: OutcomeKind;
  readonly jobId: string;
}

export type RewriteEvent = RewriteAccepted | RewriteSucceeded | RewriteFailed | OutcomeReconciled;
export type TranscribeEvent = TranscribeAccepted | TranscribeSucceeded | TranscribeFailed | TranscribeReconciled;
export type OutcomeEvent = OutcomeUnresolved | OutcomeCleared;
export type MainEvent = RewriteEvent | TranscribeEvent | CaptureEnded | OutcomeEvent;
