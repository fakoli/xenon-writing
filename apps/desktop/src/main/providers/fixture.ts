/**
 * Synthetic fixture rewrite provider (Packet D).
 *
 * Deterministic and in-process: it returns the transcript with whitespace
 * normalized, after an optional delay on the injected clock. It opens no
 * socket, reads no file, calls no model and never reports `dispatched`,
 * because nothing leaves the process. Its output is labeled "synthetic", not
 * AI, and it says nothing about real rewrite quality.
 */
import type { Clock, RewriteProvider, TranscribeProvider } from '../jobs.ts';
import { FIXTURE_JOB_TIMEOUT_MS, ProviderFailure, systemClock } from '../jobs.ts';
import { inspectWav } from '../platform/media.ts';
import { FIXTURE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE } from '../routePolicy.ts';

export interface FixtureProvider extends RewriteProvider {
  /** How many times run() was called; tests assert exact request counts. */
  readonly calls: number;
}

export interface FixtureOptions {
  readonly clock?: Clock;
  /** Simulated processing time. 0 completes on the next microtask. */
  readonly delayMs?: number;
  /** Defaults to the component design fixture timeout. */
  readonly timeoutMs?: number;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/** Collapses runs of whitespace and trims: "Meet  at\nnoon. " → "Meet at noon.". */
export function fixtureRewrite(transcript: string): string {
  return transcript.split(/\s+/u).filter((word) => word !== '').join(' ');
}

export function createFixtureRewriteProvider(options: FixtureOptions = {}): FixtureProvider {
  const clock = options.clock ?? systemClock;
  const delayMs = options.delayMs ?? 0;
  let calls = 0;

  return {
    routeKey: FIXTURE_REWRITE_ROUTE.routeKey,
    mode: FIXTURE_REWRITE_ROUTE.mode,
    identity: FIXTURE_REWRITE_ROUTE.identity,
    timeoutMs: options.timeoutMs ?? FIXTURE_JOB_TIMEOUT_MS,
    get calls() {
      return calls;
    },
    run(input, control) {
      calls += 1;
      const result = { actualMode: 'fixture' as const, actualIdentity: FIXTURE_REWRITE_ROUTE.identity, text: fixtureRewrite(input.transcript) };
      if (delayMs === 0) return control.signal.aborted ? Promise.reject(abortError()) : Promise.resolve(result);
      return new Promise((resolve, reject) => {
        if (control.signal.aborted) return reject(abortError());
        const timer = clock.setTimeout(() => resolve(result), delayMs);
        control.signal.addEventListener(
          'abort',
          () => {
            clock.clearTimeout(timer);
            reject(abortError());
          },
          { once: true },
        );
      });
    },
  };
}

/** What the fixture transcriber "hears" in any valid audio: fixed synthetic text. */
export const FIXTURE_TRANSCRIPT = 'Meet at noon.';

export interface FixtureTranscriber extends TranscribeProvider {
  readonly calls: number;
}

/**
 * Synthetic transcription: re-checks the audio is the fixture WAV format,
 * then returns FIXTURE_TRANSCRIPT after an optional delay. It understands
 * nothing; it never decodes speech, opens a socket or reports `dispatched`.
 */
export function createFixtureTranscriber(options: FixtureOptions = {}): FixtureTranscriber {
  const clock = options.clock ?? systemClock;
  const delayMs = options.delayMs ?? 0;
  let calls = 0;

  return {
    routeKey: FIXTURE_TRANSCRIBE_ROUTE.routeKey,
    mode: FIXTURE_TRANSCRIBE_ROUTE.mode,
    identity: FIXTURE_TRANSCRIBE_ROUTE.identity,
    timeoutMs: options.timeoutMs ?? FIXTURE_JOB_TIMEOUT_MS,
    get calls() {
      return calls;
    },
    run(input, control) {
      calls += 1;
      if (!inspectWav(input.audio).ok) return Promise.reject(new ProviderFailure('invalid_input'));
      const result = { actualMode: 'fixture' as const, actualIdentity: FIXTURE_TRANSCRIBE_ROUTE.identity, text: FIXTURE_TRANSCRIPT };
      if (delayMs === 0) return control.signal.aborted ? Promise.reject(abortError()) : Promise.resolve(result);
      return new Promise((resolve, reject) => {
        if (control.signal.aborted) return reject(abortError());
        const timer = clock.setTimeout(() => resolve(result), delayMs);
        control.signal.addEventListener(
          'abort',
          () => {
            clock.clearTimeout(timer);
            reject(abortError());
          },
          { once: true },
        );
      });
    },
  };
}
