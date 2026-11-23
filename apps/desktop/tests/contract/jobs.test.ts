// Synthetic contract tests for Packet D: job runner, fixture provider and the
// offline composition, end to end through the preload façade and reducer.
// Fictional text only. Time is a fake clock; network APIs are trapped.
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

import type { FailureCode, MainEvent } from '../../src/contracts/session.ts';
import type { PublishedRoute, SessionOpened } from '../../src/contracts/ipc.ts';
import { createDesktopMain } from '../../src/main/ipc.ts';
import type { JobSink, ProviderSuccess, RewriteJob } from '../../src/main/ipc.ts';
import { FIXTURE_JOB_TIMEOUT_MS, ProviderFailure, createJobRunner } from '../../src/main/jobs.ts';
import type { Clock, ProviderControl, RewriteProvider } from '../../src/main/jobs.ts';
import { createFixtureRewriteProvider, fixtureRewrite } from '../../src/main/providers/fixture.ts';
import { FIXTURE_REWRITE_ROUTE, createRoutePolicy } from '../../src/main/routePolicy.ts';
import { createSyntheticMain } from '../../src/main/synthetic.ts';
import type { Caller } from '../../src/main/sessionRegistry.ts';
import { createDesktopApi } from '../../src/preload/desktop.ts';
import type { PreloadTransport } from '../../src/preload/desktop.ts';
import { copyEligibility, createSession, reduce, rewriteBlocker, rewriteRequest } from '../../src/renderer/session.ts';
import type { SessionState } from '../../src/renderer/session.ts';

/** Lets pending promise reactions run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Deterministic timers: due callbacks run in time order, ties in creation order. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock & { advance(ms: number): Promise<void>; readonly pending: number } = {
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    async advance(ms) {
      const target = now + ms;
      await settle();
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) {
          if (entry[1].at > target) continue;
          if (next === undefined || entry[1].at < next[1].at) next = entry;
        }
        if (next === undefined) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = target;
    },
    get pending() {
      return timers.size;
    },
  };
  return clock;
}

type Outcome = { ok: true; result: ProviderSuccess } | { ok: false; code: FailureCode };

function recordingSink() {
  const outcomes: Outcome[] = [];
  const sink: JobSink = {
    succeeded: (result) => outcomes.push({ ok: true, result }),
    failed: (code) => outcomes.push({ ok: false, code }),
  };
  return { sink, outcomes };
}

const job = (overrides: Partial<RewriteJob> = {}): RewriteJob => ({
  jobId: 'j1',
  route: FIXTURE_REWRITE_ROUTE,
  transcript: 'Meet  on Thursday\nat noon. ',
  steering: '',
  ...overrides,
});

const FIXTURE_TEXT = 'Meet on Thursday at noon.';

/** A stand-in for a future remote adapter: it reports dispatch, then waits. */
function remoteLikeProvider(behavior: (control: ProviderControl) => Promise<ProviderSuccess>): RewriteProvider {
  return { routeKey: FIXTURE_REWRITE_ROUTE.routeKey, mode: 'fixture', identity: 'fixture-v1', timeoutMs: FIXTURE_JOB_TIMEOUT_MS, run: (_input, control) => behavior(control) };
}

function aborted(control: ProviderControl): Promise<never> {
  return new Promise((_resolve, reject) => control.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
}

describe('job runner', () => {
  test('the fixture returns normalized text with its synthetic identity, once', async () => {
    const fixture = createFixtureRewriteProvider();
    const runner = createJobRunner({ routes: [FIXTURE_REWRITE_ROUTE], providers: [fixture] });
    const { sink, outcomes } = recordingSink();
    runner.submit(job(), sink);
    await settle();
    assert.deepEqual(outcomes, [{ ok: true, result: { actualMode: 'fixture', actualIdentity: 'fixture-v1', text: FIXTURE_TEXT } }]);
    assert.equal(fixture.calls, 1);
    assert.equal(fixtureRewrite('<b>Literal</b>  markup'), '<b>Literal</b> markup', 'markup stays text; rendering is the UI’s job');
  });

  test('delayed responses are deterministic', async () => {
    const clock = fakeClock();
    const runner = createJobRunner({ routes: [FIXTURE_REWRITE_ROUTE], providers: [createFixtureRewriteProvider({ clock, delayMs: 500 })], clock });
    const { sink, outcomes } = recordingSink();
    runner.submit(job(), sink);
    await clock.advance(499);
    assert.deepEqual(outcomes, []);
    await clock.advance(1);
    assert.equal(outcomes.length, 1);
    assert.equal(clock.pending, 0, 'the timeout timer is cleared on completion');
  });

  test('the timeout boundary: done before the deadline succeeds, at or after it times out', async () => {
    for (const [delayMs, expected] of [[FIXTURE_JOB_TIMEOUT_MS - 1, 'ok'], [FIXTURE_JOB_TIMEOUT_MS, 'timed_out'], [FIXTURE_JOB_TIMEOUT_MS + 1, 'timed_out']] as const) {
      const clock = fakeClock();
      const runner = createJobRunner({ routes: [FIXTURE_REWRITE_ROUTE], providers: [createFixtureRewriteProvider({ clock, delayMs })], clock });
      const { sink, outcomes } = recordingSink();
      runner.submit(job(), sink);
      await clock.advance(FIXTURE_JOB_TIMEOUT_MS * 2);
      assert.equal(outcomes.length, 1, `delay ${delayMs}`);
      assert.equal(outcomes[0]?.ok ? 'ok' : outcomes[0]?.code, expected, `delay ${delayMs}`);
      assert.equal(clock.pending, 0, 'the provider stopped and nothing is left scheduled');
    }
  });

  test('each route uses its own timeout', async () => {
    const clock = fakeClock();
    const fixture = createFixtureRewriteProvider({ clock, delayMs: 60, timeoutMs: 50 });
    const runner = createJobRunner({ routes: [FIXTURE_REWRITE_ROUTE], providers: [fixture], clock });
    const { sink, outcomes } = recordingSink();
    runner.submit(job(), sink);
    await clock.advance(49);
    assert.deepEqual(outcomes, []);
    await clock.advance(1);
    assert.deepEqual(outcomes, [{ ok: false, code: 'timed_out' }]);
  });

  test('cancel before dispatch is certain and immediate', async () => {
    const clock = fakeClock();
    const fixture = createFixtureRewriteProvider({ clock, delayMs: 500 });
    const runner = createJobRunner({ routes: [FIXTURE_REWRITE_ROUTE], providers: [fixture], clock });
    const { sink, outcomes } = recordingSink();
    runner.submit(job(), sink);
    runner.cancel('j1');
    runner.cancel('j1');
    runner.cancel('never-submitted');
    assert.deepEqual(outcomes, [{ ok: false, code: 'cancelled' }]);
    assert.equal(clock.pending, 0, 'both the timeout and the fixture’s own timer stopped at once');
    await clock.advance(FIXTURE_JOB_TIMEOUT_MS * 2);
    assert.equal(outcomes.length, 1, 'no late completion or timeout');
  });

  test('after dispatch, an abort or timeout is an unknown outcome, never a retry', async () => {
    // Cancel: the adapter rejects on abort.
    const clock = fakeClock();
    let calls = 0;
    const cancelled = createJobRunner({
      routes: [FIXTURE_REWRITE_ROUTE],
      clock,
      providers: [remoteLikeProvider((control) => { calls += 1; control.dispatched(); return aborted(control); })],
    });
    const first = recordingSink();
    cancelled.submit(job(), first.sink);
    cancelled.cancel('j1');
    assert.deepEqual(first.outcomes, [], 'no immediate claim once dispatched');
    await settle();
    assert.deepEqual(first.outcomes, [{ ok: false, code: 'unknown_outcome' }]);

    // Timeout: the adapter never answers.
    const timed = createJobRunner({
      routes: [FIXTURE_REWRITE_ROUTE],
      clock,
      providers: [remoteLikeProvider((control) => { calls += 1; control.dispatched(); return new Promise(() => {}); })],
    });
    const second = recordingSink();
    timed.submit(job({ jobId: 'j2' }), second.sink);
    await clock.advance(FIXTURE_JOB_TIMEOUT_MS);
    assert.deepEqual(second.outcomes, [{ ok: false, code: 'unknown_outcome' }]);
    assert.equal(calls, 2, 'each job dispatched exactly once');

    // A result that arrives despite the cancel is still reported as what it is.
    const late = createJobRunner({
      routes: [FIXTURE_REWRITE_ROUTE],
      clock,
      providers: [remoteLikeProvider(async (control) => {
        control.dispatched();
        await settle();
        return { actualMode: 'fixture', actualIdentity: 'fixture-v1', text: 'Finished anyway.' };
      })],
    });
    const third = recordingSink();
    late.submit(job({ jobId: 'j3' }), third.sink);
    late.cancel('j3');
    await settle();
    await settle();
    await clock.advance(FIXTURE_JOB_TIMEOUT_MS * 2);
    assert.equal(third.outcomes.length, 1, 'exactly one outcome');
    assert.equal(third.outcomes[0]?.ok, true);
  });

  test('after dispatch an adapter cannot downgrade an abort to a known cancel or timeout', async () => {
    for (const [code, expected] of [['cancelled', 'unknown_outcome'], ['timed_out', 'unknown_outcome'], ['invalid_response', 'invalid_response']] as const) {
      const runner = createJobRunner({
        routes: [FIXTURE_REWRITE_ROUTE],
        providers: [remoteLikeProvider(async (control) => { control.dispatched(); throw new ProviderFailure(code); })],
      });
      const { sink, outcomes } = recordingSink();
      runner.submit(job(), sink);
      await settle();
      assert.deepEqual(outcomes, [{ ok: false, code: expected }], code);
    }
  });

  test('dispatched() refuses once the job was cancelled, so a racing adapter cannot send', async () => {
    let sends = 0;
    let refused = false;
    const runner = createJobRunner({
      routes: [FIXTURE_REWRITE_ROUTE],
      providers: [remoteLikeProvider(async (control) => {
        await settle(); // preparation, during which the user cancels
        try {
          control.dispatched();
        } catch (error) {
          refused = true;
          throw error;
        }
        sends += 1;
        return new Promise<never>(() => {});
      })],
    });
    const { sink, outcomes } = recordingSink();
    runner.submit(job(), sink);
    runner.cancel('j1');
    await settle();
    await settle();
    assert.deepEqual(outcomes, [{ ok: false, code: 'cancelled' }]);
    assert.equal(refused, true);
    assert.equal(sends, 0);
  });

  test('an adapter that returns a non-promise still reports exactly once', async () => {
    const clock = fakeClock();
    const provider: RewriteProvider = {
      routeKey: 'fixture-rewrite', mode: 'fixture', identity: 'fixture-v1', timeoutMs: FIXTURE_JOB_TIMEOUT_MS,
      run: (() => undefined) as unknown as RewriteProvider['run'],
    };
    const runner = createJobRunner({ routes: [FIXTURE_REWRITE_ROUTE], providers: [provider], clock });
    const { sink, outcomes } = recordingSink();
    assert.doesNotThrow(() => runner.submit(job(), sink));
    await clock.advance(FIXTURE_JOB_TIMEOUT_MS * 2);
    assert.equal(outcomes.length, 1, 'main validates the empty result; the timer never fires a second report');
    assert.equal(clock.pending, 0);
  });

  test('adapter failures map to safe codes', async () => {
    const cases: [RewriteProvider['run'], FailureCode][] = [
      [async () => { throw new ProviderFailure('invalid_response'); }, 'invalid_response'],
      [async () => { throw new ProviderFailure('provider_said_maybe' as FailureCode); }, 'route_unavailable'],
      [async () => { throw new Error('adapter bug before sending'); }, 'route_unavailable'],
      [() => { throw new Error('synchronous adapter bug'); }, 'route_unavailable'],
      [async (_input, control) => { control.dispatched(); throw new Error('connection reset'); }, 'unknown_outcome'],
    ];
    for (const [run, expected] of cases) {
      const provider: RewriteProvider = { routeKey: 'fixture-rewrite', mode: 'fixture', identity: 'fixture-v1', timeoutMs: FIXTURE_JOB_TIMEOUT_MS, run };
      const runner = createJobRunner({ routes: [FIXTURE_REWRITE_ROUTE], providers: [provider] });
      const { sink, outcomes } = recordingSink();
      runner.submit(job(), sink);
      await settle();
      assert.deepEqual(outcomes, [{ ok: false, code: expected }], expected);
    }
  });

  test('a route without its own adapter is unavailable, with no fallback', async () => {
    const other: PublishedRoute = { ...FIXTURE_REWRITE_ROUTE, routeKey: 'fixture-other', identity: 'fixture-v2' };
    const fixture = createFixtureRewriteProvider();
    const runner = createJobRunner({ routes: [FIXTURE_REWRITE_ROUTE, other], providers: [fixture] });
    const { sink, outcomes } = recordingSink();
    runner.submit(job({ route: other }), sink);
    runner.submit(job({ jobId: 'j2', route: { ...FIXTURE_REWRITE_ROUTE, identity: 'fixture-v9' } }), sink);
    await settle();
    assert.deepEqual(outcomes, [{ ok: false, code: 'route_unavailable' }, { ok: false, code: 'route_unavailable' }]);
    assert.equal(fixture.calls, 0);
  });

  test('misconfigured adapters fail at startup', () => {
    const fixture = createFixtureRewriteProvider();
    const transcribe: PublishedRoute = { ...FIXTURE_REWRITE_ROUTE, stage: 'transcribe' };
    assert.throws(() => createJobRunner({ routes: [], providers: [fixture] }), /no published rewrite route/);
    assert.throws(() => createJobRunner({ routes: [transcribe], providers: [fixture] }), /no published rewrite route/);
    assert.throws(() => createJobRunner({ routes: [{ ...FIXTURE_REWRITE_ROUTE, identity: 'fixture-v2' }], providers: [fixture] }), /identity/);
    assert.throws(() => createJobRunner({ routes: [FIXTURE_REWRITE_ROUTE], providers: [fixture, fixture] }), /two providers/);
    for (const timeoutMs of [0, -1, 1.5, undefined]) {
      const untimed = { ...fixture, run: fixture.run, timeoutMs } as unknown as RewriteProvider;
      assert.throws(() => createJobRunner({ routes: [FIXTURE_REWRITE_ROUTE], providers: [untimed] }), /timeoutMs/);
    }
  });
});

describe('offline synthetic app end to end', () => {
  // Every test below runs with network entry points trapped. The static scan
  // in offline.test.ts covers what a runtime trap cannot (workers, child
  // processes, new modules).
  const attempts: string[] = [];
  beforeEach(() => {
    attempts.length = 0;
    const trap = (name: string) => () => {
      attempts.push(name);
      throw new Error(`network use is forbidden in synthetic tests: ${name}`);
    };
    const targets: [object, string, string][] = [
      [net, 'connect', 'net.connect'],
      [net, 'createConnection', 'net.createConnection'],
      [net.Socket.prototype, 'connect', 'net.Socket.connect'],
      [net.Server.prototype, 'listen', 'net.Server.listen'],
      [tls, 'connect', 'tls.connect'],
      [http, 'request', 'http.request'],
      [http, 'get', 'http.get'],
      [https, 'request', 'https.request'],
      [https, 'get', 'https.get'],
      [dgram, 'createSocket', 'dgram.createSocket'],
      [dgram.Socket.prototype, 'send', 'dgram.Socket.send'],
      [dgram.Socket.prototype, 'bind', 'dgram.Socket.bind'],
      [dns, 'lookup', 'dns.lookup'],
      [dns, 'resolve', 'dns.resolve'],
      [dns.Resolver.prototype, 'resolve', 'dns.Resolver.resolve'],
      [dns.promises, 'lookup', 'dns.promises.lookup'],
      [dns.promises, 'resolve', 'dns.promises.resolve'],
      [dns.promises.Resolver.prototype, 'resolve', 'dns.promises.Resolver.resolve'],
      [globalThis, 'fetch', 'fetch'],
    ];
    for (const [target, method, name] of targets) mock.method(target, method as never, trap(name));
  });
  afterEach(() => {
    mock.restoreAll();
    assert.deepEqual(attempts, [], 'no network entry point was touched');
  });

  test('the trap itself works', () => {
    assert.throws(() => net.connect(9), /forbidden/);
    assert.throws(() => dns.promises.lookup('example.invalid'), /forbidden/);
    assert.deepEqual(attempts.splice(0), ['net.connect', 'dns.promises.lookup']);
  });

  const TRUSTED_URL = 'file:///app/renderer/index.html';
  const caller: Caller = { windowId: 1, frameUrl: TRUSTED_URL, isTopFrame: true };

  /** Façade → main → runner → fixture, with the reducer consuming events. */
  function app(options: { delayMs?: number; timeoutMs?: number } = {}) {
    const clock = fakeClock();
    const copied: string[] = [];
    const listeners = new Set<(payload: unknown) => void>();
    const sent: MainEvent[] = [];
    let next = 0;
    const { main, fixture } = createSyntheticMain({
      clock,
      fixtureDelayMs: options.delayMs ?? 300,
      timeoutMs: options.timeoutMs,
      newId: () => `id-${++next}`,
      clipboard: { writeText: (text) => copied.push(text) },
      send: (_windowId, _channel, event) => {
        sent.push(event);
        listeners.forEach((listener) => listener(structuredClone(event)));
      },
    });
    main.registerWindow(1, TRUSTED_URL);
    const transport: PreloadTransport = {
      invoke: async (channel, payload) => main.handle(channel, caller, structuredClone(payload)),
      subscribe: (_channel, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const api = createDesktopApi(transport);
    const state: { current: SessionState | null } = { current: null };
    api.onEvent((event) => {
      if (state.current !== null) state.current = reduce(state.current, event);
    });

    async function start(): Promise<SessionOpened> {
      const opened = await api.createSession();
      assert.ok(opened.ok);
      state.current = createSession({ sessionId: opened.value.sessionId, epoch: opened.value.epoch, route: opened.value.capabilities.routes[0] ?? null });
      return opened.value;
    }
    const s = () => {
      assert.ok(state.current);
      return state.current;
    };
    function act(action: Parameters<typeof reduce>[1]) {
      state.current = reduce(s(), action);
    }
    async function requestRewrite(clientRequestId: string) {
      act({ type: 'rewrite.request', clientRequestId });
      const request = rewriteRequest(s());
      assert.ok(request, 'the reducer allowed the request');
      return api.rewrite(request);
    }
    return { clock, copied, sent, api, main, fixture, start, s, act, requestRewrite };
  }

  test('a typed session completes with a synthetic, copyable draft', async () => {
    const a = app();
    const opened = await a.start();
    a.act({ type: 'edit.transcript', text: 'Meet  on Thursday at noon.' });
    assert.equal((await a.requestRewrite('r1')).ok, true);
    assert.equal(a.s().pending?.jobId, 'id-2', 'accepted arrived through events');
    await a.clock.advance(300);
    assert.equal(a.s().draft?.text, FIXTURE_TEXT);
    assert.equal(a.s().draft?.identity, 'fixture-v1');
    assert.equal(a.s().draft?.mode, 'fixture');
    assert.equal(a.fixture.calls, 1);
    const eligibility = copyEligibility(a.s());
    assert.ok(eligibility.allowed && eligibility.draftHandle);
    const copy = await a.api.copyDraft({ v: 1, sessionId: opened.sessionId, epoch: opened.epoch, draftHandle: eligibility.draftHandle });
    assert.deepEqual(copy, { ok: true, value: { status: 'copied' } });
    assert.deepEqual(a.copied, [FIXTURE_TEXT]);
  });

  test('Thursday → Friday during a delayed rewrite keeps the edit; regenerating uses it', async () => {
    const a = app();
    await a.start();
    a.act({ type: 'edit.transcript', text: 'Meet on Thursday at noon.' });
    await a.requestRewrite('r1');
    await a.clock.advance(100);
    a.act({ type: 'edit.transcript', text: 'Meet on Friday at noon.' });
    await a.clock.advance(200);
    assert.equal(a.s().transcript, 'Meet on Friday at noon.');
    assert.equal(a.s().draft, null);
    assert.equal(a.s().notice, 'result_outdated');
    await a.requestRewrite('r2');
    await a.clock.advance(300);
    assert.equal(a.s().draft?.text, 'Meet on Friday at noon.');
    assert.equal(a.fixture.calls, 2);
  });

  test('an identical retry reaches the fixture once', async () => {
    const a = app();
    await a.start();
    a.act({ type: 'edit.transcript', text: 'Meet at noon.' });
    a.act({ type: 'rewrite.request', clientRequestId: 'r1' });
    const request = rewriteRequest(a.s());
    assert.ok(request);
    const [first, second] = await Promise.all([a.api.rewrite(request), a.api.rewrite(request)]);
    assert.deepEqual(first, second);
    await a.clock.advance(300);
    assert.equal(a.fixture.calls, 1);
    assert.equal(a.sent.filter((e) => e.type === 'rewrite.succeeded').length, 1);
  });

  test('cancel mid-flight keeps edits and the previous draft, then allows a new rewrite', async () => {
    const a = app();
    const opened = await a.start();
    a.act({ type: 'edit.transcript', text: 'Meet at noon.' });
    await a.requestRewrite('r1');
    await a.clock.advance(300);
    a.act({ type: 'edit.transcript', text: 'Meet at one.' });
    await a.requestRewrite('r2');
    a.act({ type: 'rewrite.cancel', clientRequestId: 'r2' });
    assert.deepEqual(await a.api.cancel({ v: 1, sessionId: opened.sessionId, epoch: opened.epoch, clientRequestId: 'r2' }), {
      ok: true,
      value: { disposition: 'cancel_requested' },
    });
    await a.clock.advance(FIXTURE_JOB_TIMEOUT_MS * 2);
    assert.equal(a.s().draft?.text, 'Meet at noon.', 'previous draft kept');
    assert.equal(a.s().transcript, 'Meet at one.');
    assert.deepEqual(a.s().abandoned, [], 'main reported the cancelled outcome');
    assert.equal((await a.requestRewrite('r3')).ok, true);
    await a.clock.advance(300);
    assert.equal(a.s().draft?.text, 'Meet at one.');
    assert.equal(a.fixture.calls, 3);
  });

  test('a fixture timeout is a known failure, not an unknown outcome', async () => {
    const a = app({ delayMs: FIXTURE_JOB_TIMEOUT_MS + 5_000 });
    await a.start();
    a.act({ type: 'edit.transcript', text: 'Meet at noon.' });
    await a.requestRewrite('r1');
    await a.clock.advance(FIXTURE_JOB_TIMEOUT_MS);
    assert.equal(a.s().notice, 'timed_out');
    assert.deepEqual(a.s().unresolved, []);
    assert.equal((await a.requestRewrite('r2')).ok, true, 'a retry is allowed');
  });

  test('closing the session in flight cancels the job and delivers nothing more', async () => {
    const a = app();
    const opened = await a.start();
    a.act({ type: 'edit.transcript', text: 'Meet at noon.' });
    await a.requestRewrite('r1');
    await a.api.closeSession({ v: 1, sessionId: opened.sessionId, epoch: opened.epoch });
    const sentBefore = a.sent.length;
    await a.clock.advance(FIXTURE_JOB_TIMEOUT_MS * 2);
    assert.equal(a.sent.length, sentBefore);
    await a.start();
    a.act({ type: 'edit.transcript', text: 'Meet at noon.' });
    assert.equal((await a.requestRewrite('r1')).ok, true, 'the cancelled job no longer blocks');
  });

  test('an unknown outcome from a dispatching adapter gates main until reconciled', async () => {
    const clock = fakeClock();
    const sends: string[] = [];
    const listeners = new Set<(payload: unknown) => void>();
    let next = 0;
    const adapter = remoteLikeProvider((control) => {
      control.dispatched();
      sends.push('sent');
      return new Promise<never>(() => {}); // the remote side never answers
    });
    const policy = createRoutePolicy([FIXTURE_REWRITE_ROUTE]);
    const main = createDesktopMain({
      policy,
      jobs: createJobRunner({ routes: policy.routes, providers: [adapter], clock }),
      clipboard: { writeText() {} },
      newId: () => `id-${++next}`,
      send: (_windowId, _channel, event) => listeners.forEach((listener) => listener(structuredClone(event))),
    });
    main.registerWindow(1, TRUSTED_URL);
    const api = createDesktopApi({
      invoke: async (channel, payload) => main.handle(channel, caller, structuredClone(payload)),
      subscribe: (_channel, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const opened = await api.createSession();
    assert.ok(opened.ok);
    let state = createSession({ sessionId: opened.value.sessionId, epoch: opened.value.epoch, route: opened.value.capabilities.routes[0] ?? null });
    api.onEvent((event) => {
      state = reduce(state, event);
    });
    state = reduce(state, { type: 'edit.transcript', text: 'Meet at noon.' });
    state = reduce(state, { type: 'rewrite.request', clientRequestId: 'r1' });
    const first = rewriteRequest(state);
    assert.ok(first);
    const accepted = await api.rewrite(first);
    assert.ok(accepted.ok);
    await clock.advance(FIXTURE_JOB_TIMEOUT_MS);
    assert.equal(state.notice, 'unknown_outcome');
    assert.equal(rewriteBlocker(state), 'unresolved_outcome');

    // Even a renderer that ignores its own gate is refused by main.
    const sneaky = { ...first, clientRequestId: 'r2' };
    assert.deepEqual(await api.rewrite(sneaky), { ok: false, code: 'denied' });
    assert.deepEqual(sends, ['sent'], 'one dispatch only');

    assert.equal(main.reconcile(accepted.value.jobId), true);
    assert.equal(rewriteBlocker(state), null, 'the reconcile event cleared the renderer gate');
    state = reduce(state, { type: 'rewrite.request', clientRequestId: 'r3' });
    const retry = rewriteRequest(state);
    assert.ok(retry);
    assert.equal((await api.rewrite(retry)).ok, true);
    assert.deepEqual(sends, ['sent', 'sent']);
  });

  test('a full session with copy touches no network entry point', async () => {
    const a = app();
    const opened = await a.start();
    a.act({ type: 'edit.transcript', text: 'Meet on Thursday at noon.' });
    await a.requestRewrite('r1');
    await a.clock.advance(300);
    const eligibility = copyEligibility(a.s());
    assert.ok(eligibility.allowed && eligibility.draftHandle);
    await a.api.copyDraft({ v: 1, sessionId: opened.sessionId, epoch: opened.epoch, draftHandle: eligibility.draftHandle });
    assert.equal(a.s().draft?.text, FIXTURE_TEXT);
  });
});
