/**
 * Packet B part 3: the recorder's UI state, pure so it can be tested without
 * a DOM. Main owns the capture itself (one app-wide, Packet E3); this only
 * tracks what the shell shows and which intent the user may send next.
 *
 * Flow (interaction design): Record → a fresh, non-prompting read of the
 * microphone state → (unless permission is already decided) an explanation
 * before the OS prompt → starting → Recording with a timer, Stop and Discard → Stop keeps
 * the audio and asks before transcribing it (owner decision 2026-11-18: a recording is
 * never sent for transcription without a second, deliberate click), Discard keeps nothing. A recording can also end by itself
 * (time limit, device lost, permission revoked); its audio is held until
 * Keep or Discard.
 */
import type {
  CaptureEndReason,
  CaptureUnavailableReason,
  ChooseAudioResult,
  DiscardCaptureResult,
  IpcResult,
  MicrophoneState,
  StartCaptureResult,
} from '../contracts/ipc.ts';
import type { FailureCode } from '../contracts/session.ts';

export type RecorderPhase = 'idle' | 'checking' | 'explaining' | 'starting' | 'recording' | 'ended' | 'stopping' | 'discarding' | 'confirming';

/** What the last attempt left to say. Codes only; the component words them. */
export type RecorderNote =
  | { readonly kind: 'blocked'; readonly microphone: MicrophoneState }
  | { readonly kind: 'unavailable'; readonly reason: CaptureUnavailableReason }
  | { readonly kind: 'busy' }
  | { readonly kind: 'kept' }
  /** Kept, and the user chose not to transcribe it yet. */
  | { readonly kind: 'waiting' }
  | { readonly kind: 'discarded' }
  | { readonly kind: 'failed'; readonly code: FailureCode };

export interface RecorderState {
  /** Last state main reported, or null before the first read. */
  readonly microphone: MicrophoneState | null;
  readonly phase: RecorderPhase;
  readonly handle: string | null;
  readonly maxDurationMs: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly endReason: CaptureEndReason | null;
  readonly note: RecorderNote | null;
  /** While confirming, or after Not now: the kept recording's asset token, the only audio the prompt is about. */
  readonly keptAsset: string | null;
}

export type RecorderAction =
  | { readonly type: 'mic.status'; readonly microphone: MicrophoneState }
  | { readonly type: 'record' }
  /** The fresh read Record asks for; null when it failed. */
  | { readonly type: 'mic.checked'; readonly microphone: MicrophoneState | null }
  | { readonly type: 'explain.continue' }
  | { readonly type: 'explain.dismiss' }
  | { readonly type: 'start.result'; readonly result: IpcResult<StartCaptureResult>; readonly now: number }
  | { readonly type: 'ended'; readonly handle: string; readonly reason: CaptureEndReason; readonly now: number }
  | { readonly type: 'stop' }
  /** `ask`: transcription is offered, so a kept recording waits for confirmation. */
  | { readonly type: 'stop.result'; readonly result: IpcResult<ChooseAudioResult>; readonly ask: boolean }
  /** The second click: transcribe the kept recording. */
  | { readonly type: 'confirm.transcribe' }
  /** Not now: keep the recording without transcribing it. */
  | { readonly type: 'confirm.dismiss' }
  /** The confirmation no longer applies: other audio was chosen, or a transcription started another way. */
  | { readonly type: 'confirm.drop' }
  /** The "nothing was sent" note no longer holds: the recording was sent or replaced. */
  | { readonly type: 'note.clear' }
  | { readonly type: 'discard' }
  | { readonly type: 'discard.result'; readonly result: IpcResult<DiscardCaptureResult> };

/**
 * States in which main will not show the OS prompt, so no explanation is due.
 * Anything else (never asked, unreadable, or a failed read) explains first,
 * because main re-reads the state itself and prompts when it is "not_requested".
 */
const DECIDED: readonly MicrophoneState[] = ['granted', 'denied', 'restricted', 'unsupported'];

export function createRecorder(microphone: MicrophoneState | null = null): RecorderState {
  return { microphone, phase: 'idle', handle: null, maxDurationMs: 0, startedAt: null, endedAt: null, endReason: null, note: null, keptAsset: null };
}

const IDLE = { phase: 'idle', handle: null, startedAt: null, endedAt: null, endReason: null, keptAsset: null } as const;

/** A recording is held or settling, so other audio input waits. A start still waiting for the OS does not block it. */
export function recorderBusy(state: RecorderState): boolean {
  return state.phase === 'recording' || state.phase === 'ended' || state.phase === 'stopping' || state.phase === 'discarding';
}

export function reduceRecorder(state: RecorderState, action: RecorderAction): RecorderState {
  switch (action.type) {
    case 'mic.status': {
      if (action.microphone === state.microphone) return state;
      // A recheck that finds access possible again clears the old refusal.
      const cleared = state.note?.kind === 'blocked' && (action.microphone === 'granted' || action.microphone === 'not_requested');
      return { ...state, microphone: action.microphone, note: cleared ? null : state.note };
    }
    case 'record':
      // Never decide from a remembered state: it may be unread or stale. Record reads it afresh.
      // Recording again while a kept recording waits for confirmation drops that confirmation.
      return state.phase === 'idle' || state.phase === 'confirming' ? { ...state, phase: 'checking', note: null, keptAsset: null } : state;
    case 'mic.checked': {
      if (state.phase !== 'checking') return state;
      const microphone = action.microphone ?? state.microphone;
      const decided = action.microphone !== null && DECIDED.includes(action.microphone);
      return { ...state, microphone, phase: decided ? 'starting' : 'explaining' };
    }
    case 'explain.continue':
      return state.phase === 'explaining' ? { ...state, phase: 'starting' } : state;
    case 'explain.dismiss':
      return state.phase === 'explaining' ? { ...state, phase: 'idle' } : state;
    case 'start.result':
      return state.phase === 'starting' ? started(state, action.result, action.now) : state;
    case 'ended':
      // Only the recording on screen; a stop already asked for wins.
      if (state.phase !== 'recording' || action.handle !== state.handle) return state;
      return { ...state, phase: 'ended', endedAt: action.now, endReason: action.reason };
    case 'stop':
      return state.phase === 'recording' || state.phase === 'ended' ? { ...state, phase: 'stopping' } : state;
    case 'stop.result': {
      if (state.phase !== 'stopping') return state;
      const r = action.result;
      if (r.ok && r.value.status === 'chosen') {
        // Kept, but never transcribed on Stop alone: with transcription offered, it waits for a second click.
        return action.ask ? { ...state, ...IDLE, phase: 'confirming', keptAsset: r.value.assetToken, note: null } : { ...state, ...IDLE, note: { kind: 'kept' } };
      }
      if (r.ok) return { ...state, ...IDLE, note: { kind: 'failed', code: 'invalid_response' } };
      // Main answers "cancelled" when a Discard won the race with the stop.
      return { ...state, ...IDLE, note: r.code === 'cancelled' ? { kind: 'discarded' } : { kind: 'failed', code: r.code } };
    }
    case 'confirm.transcribe':
      return state.phase === 'confirming' ? { ...state, ...IDLE, note: { kind: 'kept' } } : state;
    case 'confirm.dismiss':
      // Keeps the token, so the note can be cleared once that recording is sent or replaced.
      return state.phase === 'confirming' ? { ...state, ...IDLE, keptAsset: state.keptAsset, note: { kind: 'waiting' } } : state;
    case 'note.clear':
      return state.phase === 'idle' && state.note?.kind === 'waiting' ? { ...state, note: null, keptAsset: null } : state;
    case 'confirm.drop':
      return state.phase === 'confirming' ? { ...state, ...IDLE, note: null } : state;
    case 'discard':
      return state.phase === 'recording' || state.phase === 'ended' ? { ...state, phase: 'discarding' } : state;
    case 'discard.result':
      if (state.phase !== 'discarding') return state;
      // Either way nothing is kept: a refused discard means main already dropped the capture.
      return { ...state, ...IDLE, note: action.result.ok ? { kind: 'discarded' } : { kind: 'failed', code: action.result.code } };
  }
}

function started(state: RecorderState, result: IpcResult<StartCaptureResult>, now: number): RecorderState {
  if (!result.ok) return { ...state, ...IDLE, note: { kind: 'failed', code: result.code } };
  const value = result.value;
  switch (value.status) {
    case 'recording':
      return { ...state, microphone: 'granted', phase: 'recording', handle: value.captureHandle, maxDurationMs: value.maxDurationMs, startedAt: now, endedAt: null, endReason: null, note: null };
    case 'blocked':
      return { ...state, ...IDLE, microphone: value.microphone, note: { kind: 'blocked', microphone: value.microphone } };
    case 'unavailable':
      // Permission was granted; the device could not start.
      return { ...state, ...IDLE, microphone: 'granted', note: { kind: 'unavailable', reason: value.reason } };
    case 'already_recording':
      return { ...state, ...IDLE, note: { kind: 'busy' } };
  }
}

/** Elapsed recording time for the timer, capped at the limit. */
export function elapsedMs(state: RecorderState, now: number): number {
  if (state.startedAt === null) return 0;
  const end = state.endedAt ?? now;
  return Math.max(0, Math.min(end - state.startedAt, state.maxDurationMs));
}
