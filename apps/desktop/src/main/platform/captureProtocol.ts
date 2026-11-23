/**
 * Packet E, macOS capture: the private messages between main and the hidden
 * capture window, and the pure rules main applies to them. Only the capture
 * window's own preload uses these channels; the app window never sees them.
 */
import type { CaptureUnavailableReason, MicrophoneState } from '../../contracts/ipc.ts';
import type { MicrophonePort } from './capture.ts';

export const CAPTURE_CHANNELS = Object.freeze({
  /** page → main: the input is open and samples flow. */
  started: 'xenon:capture:started',
  /** page → main: the input could not open; the payload is the DOMException name only. */
  failed: 'xenon:capture:failed',
  /** page → main: an ArrayBuffer of 16 kHz mono 16-bit samples. */
  chunk: 'xenon:capture:chunk',
  /** page → main: the input track ended by itself. */
  ended: 'xenon:capture:ended',
  /** main → page: hand over what you hold and stop. */
  flush: 'xenon:capture:flush',
  /** page → main: everything held was sent. */
  flushed: 'xenon:capture:flushed',
});

/** At most a few seconds per message, so a misbehaving page cannot flood main. */
export const MAX_CHUNK_BYTES = 16_000 * 2 * 4;

/** What a getUserMedia failure means for the user (platform design): missing, busy or failed. */
export function unavailableReason(name: unknown): CaptureUnavailableReason {
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no_input';
  if (name === 'NotReadableError' || name === 'AbortError') return 'in_use';
  return 'failed';
}

/** A chunk from the page as samples, or null when it is not a bounded, even-length ArrayBuffer. */
export function chunkSamples(payload: unknown): Int16Array | null {
  if (!(payload instanceof ArrayBuffer) || payload.byteLength === 0 || payload.byteLength % 2 !== 0 || payload.byteLength > MAX_CHUNK_BYTES) return null;
  return new Int16Array(payload.slice(0));
}

/** The subset of Electron's systemPreferences the microphone port uses (macOS). */
export interface MacMediaAccess {
  getMediaAccessStatus(mediaType: 'microphone'): string;
  askForMediaAccess(mediaType: 'microphone'): Promise<boolean>;
}

/** macOS's (TCC) microphone states in Electron's spelling, as the contract's; anything else is unknown. */
export function macMicrophoneState(value: unknown): MicrophoneState {
  switch (value) {
    case 'not-determined':
      return 'not_requested';
    case 'granted':
    case 'denied':
    case 'restricted':
      return value;
    default:
      return 'unknown';
  }
}

/** The microphone port over macOS media access. status() never prompts; request() is the OS prompt. */
export function createMacMicrophone(access: MacMediaAccess): MicrophonePort {
  const status = () => macMicrophoneState(access.getMediaAccessStatus('microphone'));
  return {
    status,
    async request() {
      await access.askForMediaAccess('microphone');
      // The prompt's answer is re-read from the OS rather than trusted from the call.
      return status();
    },
  };
}
