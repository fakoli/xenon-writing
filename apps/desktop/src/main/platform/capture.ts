/**
 * Microphone permission and capture ports (Packet E, part 3).
 *
 * Electron wiring implements these with the OS media APIs; tests use fakes.
 * Main calls them only from explicit intents, never at launch, on focus or on
 * retry (interaction and platform designs). Captured audio goes through the same
 * WAV inspection as a chosen file, so only canonical samples are kept.
 */
import type { CaptureEndReason, CaptureUnavailableReason, MicrophoneState } from '../../contracts/ipc.ts';

export interface MicrophonePort {
  /** The current OS permission state. Must never show a prompt. */
  status(): MicrophoneState;
  /** Shows the OS prompt. Main calls it only when status() is "not_requested". */
  request(): Promise<MicrophoneState>;
}

/** One recording in progress. */
export interface CaptureStream {
  /**
   * Stops recording and returns what was captured as fixture-format WAV
   * bytes. After the stream ended by itself, returns what it had captured.
   */
  stop(): Promise<Uint8Array>;
  /** Stops recording and drops everything. Must be safe to call more than once. */
  discard(): void;
  /** Called once if the recording stops by itself: time limit, device lost or permission revoked. */
  onEnded(listener: (reason: CaptureEndReason) => void): void;
}

/** Thrown by CapturePort.start when permission is granted but recording cannot start. */
export class CaptureUnavailable extends Error {
  readonly reason: CaptureUnavailableReason;
  constructor(reason: CaptureUnavailableReason) {
    super(reason);
    this.name = 'CaptureUnavailable';
    this.reason = reason;
  }
}

export interface CapturePort {
  /**
   * Starts recording from the selected input. The implementation must stop by
   * itself at maxDurationMs, show a persistent recording indicator, and fail
   * (reject) rather than record from an unexpected device.
   */
  start(options: { readonly maxDurationMs: number }): Promise<CaptureStream>;
}
