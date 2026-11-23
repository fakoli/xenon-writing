/**
 * Packet B part 2: the audio chooser's rules, apart from Electron so they can
 * be tested. The binding (electronChooser.ts) supplies the native dialog and
 * a bounded file read; the path stays in main and never reaches the renderer.
 */
import { systemClock } from '../jobs.ts';
import type { Clock } from '../jobs.ts';
import type { AudioChooserPort, ChooserResult } from './media.ts';

/** A read that has not finished by then fails, so a hung mount cannot hold the chooser open. */
export const READ_TIMEOUT_MS = 10_000;

export interface ChooserPlatform {
  /** Shows the open dialog over the caller's window; null when that window is gone. */
  showOpenDialog(windowId: number): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] } | null>;
  /** Reads at most `limit` bytes from the start of a regular file; rejects for anything else. */
  readHead(file: string, limit: number): Promise<Uint8Array>;
}

export function createChooser(platform: ChooserPlatform, options: { readonly clock?: Clock; readonly readTimeoutMs?: number } = {}): AudioChooserPort {
  const clock = options.clock ?? systemClock;
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  return {
    async pickAudio({ maxBytes, windowId }): Promise<ChooserResult> {
      const choice = await platform.showOpenDialog(windowId);
      // Closing the dialog, a vanished window or anything but one file is a cancel, not an error.
      if (choice === null || choice.canceled || choice.filePaths.length !== 1) return { status: 'cancelled' };
      // One byte past the limit lets intake tell "too large" from "exactly at the limit".
      const bytes = await withTimeout(platform.readHead(choice.filePaths[0] as string, maxBytes + 1), clock, readTimeoutMs);
      return { status: 'picked', bytes };
    },
  };
}

function withTimeout<T>(work: Promise<T>, clock: Clock, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new Error('read timed out')), ms);
    work.then(
      (value) => {
        clock.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clock.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
