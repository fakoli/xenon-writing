/**
 * Rewrite job runner (Packet D).
 *
 * Implements Packet C's RewriteJobPort and E2's TranscribeJobPort with one
 * shared core: hands each admitted job to the
 * provider adapter registered for its exact route, enforces a timeout on an
 * injectable clock, and turns cancellation and timeouts into honest outcomes.
 *
 * The key rule is whether a request may have left the process. An adapter
 * calls `dispatched()` immediately before sending. It throws once the job was
 * cancelled, timed out or finished, and then the adapter must not send.
 * - Before dispatch, cancel → `cancelled` and timeout → `timed_out`: nothing
 *   was sent, so nothing can have happened downstream.
 * - After dispatch, an abort, a timeout, or an adapter's own claim of
 *   `cancelled`/`timed_out` → `unknown_outcome`. Main's gate then blocks new
 *   rewrites until the outcome is independently reconciled. The runner never
 *   retries and never falls back to another provider.
 *
 * Each route's adapter declares its own timeout; there is no shared default.
 * Each job reports exactly once. Later provider settlements are ignored.
 */
import { isFailureCode } from '../contracts/session.ts';
import type { FailureCode } from '../contracts/session.ts';
import type { PublishedRoute } from '../contracts/ipc.ts';
import type { JobSink, ProviderSuccess, RewriteJob, RewriteJobPort, TranscribeJob, TranscribeJobPort } from './ipc.ts';

/** Timer functions, so tests can drive time deterministically. */
export interface Clock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** The component design's fixture default. Not a live-provider SLA. */
export const FIXTURE_JOB_TIMEOUT_MS = 10_000;

export interface ProviderControl {
  /** Aborted on cancel, timeout or session teardown. */
  readonly signal: AbortSignal;
  /**
   * Call immediately before the request leaves this process. Throws if the
   * job was already cancelled, timed out or finished: then do not send.
   * After a successful call, an abort cannot prove nothing happened downstream.
   */
  dispatched(): void;
}

/** A known, safe failure an adapter can report instead of throwing anything. */
export class ProviderFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {
    super(code);
    this.name = 'ProviderFailure';
    this.code = code;
  }
}

/** One adapter for one configured route. */
export interface Provider<I> {
  readonly routeKey: string;
  readonly mode: PublishedRoute['mode'];
  readonly identity: string;
  /** This route's approved job timeout. Each route declares its own. */
  readonly timeoutMs: number;
  run(input: I, control: ProviderControl): Promise<ProviderSuccess>;
}

export interface RewriteInput {
  /**
   * Main's opaque job ID. An adapter that leaves the process sends it as the
   * request's idempotency key, so a downstream that keeps receipts dedupes a
   * repeat and a later reconciliation can find the job by it.
   */
  readonly jobId: string;
  readonly transcript: string;
  readonly steering: string;
}

/** Canonical WAV bytes (fmt + data only), a copy the adapter may keep. */
export interface TranscribeInput {
  readonly audio: Uint8Array;
}

export type RewriteProvider = Provider<RewriteInput>;
export type TranscribeProvider = Provider<TranscribeInput>;

export interface RunnerOptions<I> {
  /** The routes main's policy publishes; every provider must match one exactly. */
  readonly routes: readonly PublishedRoute[];
  readonly providers: readonly Provider<I>[];
  readonly clock?: Clock;
}
export type JobRunnerOptions = RunnerOptions<RewriteInput>;

interface RunningJob {
  readonly controller: AbortController;
  readonly timer: unknown;
  dispatched: boolean;
  report(outcome: { ok: true; result: ProviderSuccess } | { ok: false; code: FailureCode }): void;
}

/**
 * Builds the runner. Throws at startup if an adapter does not match a
 * published route's key, mode and identity exactly, or two adapters claim
 * one route, so a misconfigured app fails closed instead of misrouting.
 */
export function createJobRunner(options: JobRunnerOptions): RewriteJobPort {
  return createRunner<RewriteJob, RewriteInput>('rewrite', options, (job) => ({ jobId: job.jobId, transcript: job.transcript, steering: job.steering }));
}

/** The same rules for the transcribe stage (Packet E2). */
export function createTranscribeRunner(options: RunnerOptions<TranscribeInput>): TranscribeJobPort {
  return createRunner<TranscribeJob, TranscribeInput>('transcribe', options, (job) => ({ audio: job.audio }));
}

interface CoreJob {
  readonly jobId: string;
  readonly route: PublishedRoute;
}

function createRunner<J extends CoreJob, I>(
  stage: PublishedRoute['stage'],
  options: RunnerOptions<I>,
  inputOf: (job: J) => I,
): { submit(job: J, sink: JobSink): void; cancel(jobId: string): void } {
  const clock = options.clock ?? systemClock;

  const providers = new Map<string, Provider<I>>();
  for (const provider of options.providers) {
    if (!Number.isSafeInteger(provider.timeoutMs) || provider.timeoutMs <= 0) {
      throw new Error('each provider needs a positive integer timeoutMs');
    }
    const route = options.routes.find((r) => r.routeKey === provider.routeKey);
    if (route === undefined || route.stage !== stage) throw new Error(`provider has no published ${stage} route`);
    if (route.mode !== provider.mode || route.identity !== provider.identity) {
      throw new Error('provider mode or identity differs from its route');
    }
    if (providers.has(provider.routeKey)) throw new Error('two providers claim one route');
    providers.set(provider.routeKey, provider);
  }

  const running = new Map<string, RunningJob>();

  function submit(job: J, sink: JobSink): void {
    const provider = providers.get(job.route.routeKey);
    // A route without its own adapter is unavailable. Never substitute another.
    if (provider === undefined || provider.identity !== job.route.identity || provider.mode !== job.route.mode) {
      sink.failed('route_unavailable');
      return;
    }

    const controller = new AbortController();
    let settled = false;
    const entry: RunningJob = {
      controller,
      timer: clock.setTimeout(() => {
        controller.abort();
        entry.report({ ok: false, code: entry.dispatched ? 'unknown_outcome' : 'timed_out' });
      }, provider.timeoutMs),
      dispatched: false,
      report(outcome) {
        if (settled) return;
        settled = true;
        clock.clearTimeout(entry.timer);
        running.delete(job.jobId);
        if (outcome.ok) sink.succeeded(outcome.result);
        else sink.failed(outcome.code);
      },
    };
    running.set(job.jobId, entry);

    const control: ProviderControl = {
      signal: controller.signal,
      dispatched() {
        // Too late: the job already reported, so nothing may be sent now.
        if (settled || controller.signal.aborted) throw new ProviderFailure('cancelled');
        entry.dispatched = true;
      },
    };

    let pending: Promise<ProviderSuccess>;
    try {
      // Promise.resolve also absorbs an adapter that returns a non-promise.
      pending = Promise.resolve(provider.run(inputOf(job), control));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (result) => entry.report({ ok: true, result }),
      (error: unknown) => {
        if (error instanceof ProviderFailure && isFailureCode(error.code)) {
          // After dispatch, only the remote side could confirm a cancel or
          // timeout; the adapter's word is not enough.
          const unconfirmed = entry.dispatched && (error.code === 'cancelled' || error.code === 'timed_out');
          entry.report({ ok: false, code: unconfirmed ? 'unknown_outcome' : error.code });
        } else if (entry.dispatched) {
          // Aborted or failed after the request left: whether it was applied is unknown.
          entry.report({ ok: false, code: 'unknown_outcome' });
        } else {
          // Failed in-process before anything was sent.
          entry.report({ ok: false, code: 'route_unavailable' });
        }
      },
    );
  }

  function cancel(jobId: string): void {
    // A repeat cancel is harmless: aborting twice is a no-op and a job reports once.
    const entry = running.get(jobId);
    if (entry === undefined) return;
    entry.controller.abort();
    // Nothing left the process, so the cancel is certain. After dispatch,
    // wait for the adapter (or the timeout) to say what happened.
    if (!entry.dispatched) entry.report({ ok: false, code: 'cancelled' });
  }

  return { submit, cancel };
}
