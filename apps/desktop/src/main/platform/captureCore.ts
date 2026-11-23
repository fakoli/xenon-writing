/**
 * Packet E, macOS capture: the recording rules apart from Electron, so they
 * can be tested. A driver (electronCapture.ts) opens the default input and
 * streams 16 kHz mono 16-bit samples; this module keeps at most the time
 * limit's worth, stops itself at the limit, reports how a recording ended,
 * and turns what was kept into fixture-format WAV bytes for main's intake.
 */
import type { CaptureEndReason } from '../../contracts/ipc.ts';
import { systemClock } from '../jobs.ts';
import type { Clock } from '../jobs.ts';
import type { CapturePort, CaptureStream } from './capture.ts';
import { FIXTURE_AUDIO } from './media.ts';

export interface CaptureListener {
  /** A run of 16 kHz mono samples, in order. */
  chunk(samples: Int16Array): void;
  /** The input stopped by itself (device lost or permission revoked). */
  ended(reason: CaptureEndReason): void;
}

export interface CaptureDriver {
  /**
   * Opens the default input and resolves once samples flow. Rejects with
   * CaptureUnavailable when the input is missing, busy or failed.
   */
  open(listener: CaptureListener): Promise<void>;
  /** Asks the input to hand over what it still holds, within `ms`; resolves either way. */
  flush(ms: number): Promise<void>;
  /** Releases the input. Safe to call more than once. */
  close(): void;
}

/** How long Stop waits for the input's last samples before closing it anyway. */
export const FLUSH_MS = 500;
/**
 * The timer backs up the sample count: it starts once the input is open and allows for the audio pipeline's
 * delay, so a full recording keeps exactly the limit's worth. It stays under main's own backstop (+1 s).
 */
export const LIMIT_GRACE_MS = 500;

export function createCapturePort(newDriver: () => CaptureDriver, clock: Clock = systemClock): CapturePort {
  return {
    async start({ maxDurationMs }): Promise<CaptureStream> {
      const limit = Math.round((Math.min(maxDurationMs, FIXTURE_AUDIO.maxDurationMs) * FIXTURE_AUDIO.sampleRate) / 1000);
      const kept: Int16Array[] = [];
      let length = 0;
      let state: 'recording' | 'ended' | 'closed' = 'recording';
      let endedListener: ((reason: CaptureEndReason) => void) | null = null;
      let endedReason: CaptureEndReason | null = null;
      const driver = newDriver();

      let timer: unknown = null;
      const end = (reason: CaptureEndReason) => {
        if (state !== 'recording') return;
        state = 'ended';
        if (timer !== null) clock.clearTimeout(timer);
        driver.close();
        endedReason = reason;
        endedListener?.(reason);
      };

      try {
        await driver.open({
          chunk(samples) {
            if (state === 'closed' || !(samples instanceof Int16Array) || length >= limit) return;
            const room = limit - length;
            const piece = samples.length > room ? samples.slice(0, room) : samples.slice();
            kept.push(piece);
            length += piece.length;
            if (length >= limit) end('max_duration');
          },
          ended(reason) {
            end(reason === 'revoked' ? 'revoked' : 'device_lost');
          },
        });
      } catch (error) {
        state = 'closed';
        driver.close();
        throw error;
      }
      // The port stops by itself at the limit, even if samples stop arriving.
      if (state === 'recording') timer = clock.setTimeout(() => end('max_duration'), maxDurationMs + LIMIT_GRACE_MS);

      return {
        async stop() {
          if (state === 'closed') throw new Error('capture already closed');
          if (state === 'recording') {
            if (timer !== null) clock.clearTimeout(timer);
            await driver.flush(FLUSH_MS);
          }
          state = 'closed';
          driver.close();
          return pcm16Wav(join(kept, length));
        },
        discard() {
          state = 'closed';
          if (timer !== null) clock.clearTimeout(timer);
          driver.close();
          kept.length = 0;
          length = 0;
        },
        onEnded(listener) {
          endedListener = listener;
          if (endedReason !== null) listener(endedReason);
        },
      };
    },
  };
}

function join(parts: readonly Int16Array[], length: number): Int16Array {
  const all = new Int16Array(length);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

/** A canonical 16 kHz mono 16-bit PCM WAV: a 44-byte header and the samples, little-endian. */
export function pcm16Wav(samples: Int16Array): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, FIXTURE_AUDIO.channels, true);
  view.setUint32(24, FIXTURE_AUDIO.sampleRate, true);
  view.setUint32(28, FIXTURE_AUDIO.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, FIXTURE_AUDIO.bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i] as number, true);
  return out;
}
