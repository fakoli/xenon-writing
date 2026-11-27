// Synthetic contract tests for the Inspect step (route card 07):
// the acknowledgeOutcome intent in main, the outcome reports that let a
// reload or later session reach Inspect, the preload façade, and the full
// journey through the real job runner, chat provider and reducer with a
// throwaway in-memory transport. Fictional text only; nothing leaves the
// process and no live model is called.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CHANNELS, OUTCOME_REPORT_SCHEMA, readOutcomeReport } from '../../src/contracts/ipc.ts';
import type { ChooseAudioResult, IpcResult, PublishedRoute, SessionOpened } from '../../src/contracts/ipc.ts';
import type { FailureCode, MainEvent, OutcomeReport, RewriteAccepted, TranscribeAccepted } from '../../src/contracts/session.ts';
import { acknowledgmentRefusal, createDesktopMain } from '../../src/main/ipc.ts';
import type { JobSink, RewriteJob, TranscribeJob } from '../../src/main/ipc.ts';
import { BASE_REWRITE_ROUTE, BASE_REWRITE_SETTINGS, baseRewriteAcknowledgeable } from '../../src/main/providers/baseRewriteRoute.ts';
import { MAX_REQUEST_RECORDS } from '../../src/main/sessionRegistry.ts';
import type { ChatReply, ChatRequest, ChatTransport } from '../../src/main/providers/chatRewrite.ts';
import { FIXTURE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE, createRoutePolicy } from '../../src/main/routePolicy.ts';
import type { Caller } from '../../src/main/sessionRegistry.ts';
import { createSyntheticMain } from '../../src/main/synthetic.ts';
import { createDesktopApi, filterEvent } from '../../src/preload/desktop.ts';
import type { PreloadTransport } from '../../src/preload/desktop.ts';
import { createSession, reduce, rewriteBlocker, rewriteRequest } from '../../src/renderer/session.ts';
import type { SessionState } from '../../src/renderer/session.ts';
import { settle } from '../fixtures/clock.ts';
import { noonWav } from '../fixtures/wav.ts';

const TRUSTED_URL = 'file:///app/renderer/index.html';
const NOW = 1_790_000_000_000;
const SYNTHETIC = 'Synthetic test: meet on Thursday at noon.';

interface Sent {
  readonly windowId: number;
  readonly event: MainEvent;
}

const caller = (windowId = 1, overrides: Partial<Caller> = {}): Caller => ({ windowId, frameUrl: TRUSTED_URL, isTopFrame: true, ...overrides });

/**
 * Main with route card 07's rewrite route (acknowledgeable), a fixture
 * rewrite route and the fixture transcription route (neither is), and job
 * ports that only record what they are given, so each test settles jobs itself.
 */
function harness(options: { routes?: readonly PublishedRoute[]; acknowledgeRoutes?: readonly string[] } = {}) {
  const sent: Sent[] = [];
  const rewrites: { job: RewriteJob; sink: JobSink }[] = [];
  const transcriptions: { job: TranscribeJob; sink: JobSink }[] = [];
  let next = 0;
  const policy = createRoutePolicy(options.routes ?? [BASE_REWRITE_ROUTE, FIXTURE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE]);
  const main = createDesktopMain({
    policy,
    jobs: { submit: (job, sink) => rewrites.push({ job, sink }), cancel() {} },
    transcriber: { submit: (job, sink) => transcriptions.push({ job, sink }), cancel() {} },
    chooser: { pickAudio: async () => ({ status: 'picked', bytes: noonWav() }) },
    clipboard: { writeText() {} },
    send: (windowId, _channel, event) => sent.push({ windowId, event }),
    newId: () => `id-${++next}`,
    now: () => NOW,
    acknowledgeRoutes: options.acknowledgeRoutes ?? [BASE_REWRITE_ROUTE.routeKey],
  });
  main.registerWindow(1, TRUSTED_URL);
  main.registerWindow(2, TRUSTED_URL);

  const open = (windowId = 1) => {
    const result = main.handle(CHANNELS.createSession, caller(windowId), { v: 1 });
    assert.ok(result.ok, JSON.stringify(result));
    return result.value as SessionOpened;
  };
  const envelope = (s: SessionOpened) => ({ v: 1, sessionId: s.sessionId, epoch: s.epoch });
  const rewrite = (s: SessionOpened, overrides: Record<string, unknown> = {}, windowId = 1) =>
    main.handle(CHANNELS.rewrite, caller(windowId), {
      ...envelope(s),
      clientRequestId: 'r1',
      routeKey: BASE_REWRITE_ROUTE.routeKey,
      sourceRevision: 1,
      steeringRevision: 0,
      transcript: SYNTHETIC,
      steering: '',
      ...overrides,
    });
  const acknowledge = (s: SessionOpened, jobId: string, clientRequestId = 'ack1', from: Caller | null = caller()) =>
    main.handle(CHANNELS.acknowledgeOutcome, from, { ...envelope(s), clientRequestId, jobId });
  /** A rewrite on `routeKey` whose outcome becomes unknown. Returns its job ID. */
  const unknownRewrite = (s: SessionOpened, clientRequestId = 'r1', routeKey = BASE_REWRITE_ROUTE.routeKey, windowId = 1) => {
    const accepted = rewrite(s, { clientRequestId, routeKey }, windowId);
    assert.ok(accepted.ok, JSON.stringify(accepted));
    rewrites.at(-1)?.sink.failed('unknown_outcome');
    return (accepted.value as RewriteAccepted).jobId;
  };
  /** Whether main would admit a new rewrite now, probed in a throwaway window so no session sees the probe. */
  let probes = 0;
  const gateOpen = () => {
    const id = 100 + ++probes;
    main.registerWindow(id, TRUSTED_URL);
    const probe = open(id);
    const sentBefore = sent.length;
    const verdict = rewrite(probe, { clientRequestId: `probe-${probes}` }, id);
    main.windowClosed(id);
    if (verdict.ok) {
      // Leave no job behind: the probe's job finishes as a known failure (a refusal before dispatch).
      rewrites.at(-1)?.sink.failed('route_unavailable');
    }
    sent.splice(sentBefore);
    return verdict.ok;
  };
  const eventsFor = (s: SessionOpened) => sent.filter((x) => x.event.sessionId === s.sessionId).map((x) => x.event);
  const value = <T,>(result: IpcResult<unknown>): T => {
    assert.equal(result.ok, true, JSON.stringify(result));
    return (result as { value: T }).value;
  };
  const code = (result: IpcResult<unknown>): FailureCode => {
    assert.equal(result.ok, false, JSON.stringify(result));
    return (result as { code: FailureCode }).code;
  };
  return { main, sent, rewrites, transcriptions, open, envelope, rewrite, acknowledge, unknownRewrite, gateOpen, eventsFor, value, code };
}

const report = (jobId: string, overrides: Partial<OutcomeReport> = {}): OutcomeReport => ({
  kind: 'rewrite',
  jobId,
  routeKey: BASE_REWRITE_ROUTE.routeKey,
  sentAt: NOW,
  clearance: 'acknowledge',
  ...overrides,
});

describe('acknowledging an unknown outcome', () => {
  test('the exact reported job, acknowledged, reopens the gate and nothing is resent', () => {
    const h = harness();
    const s = h.open();
    const jobId = h.unknownRewrite(s);
    assert.deepEqual(h.eventsFor(s).slice(-2).map((e) => e.type), ['rewrite.failed', 'outcome.unresolved']);
    assert.deepEqual(h.eventsFor(s).at(-1), { ...h.envelope(s), type: 'outcome.unresolved', ...report(jobId) });
    assert.equal(h.code(h.rewrite(s, { clientRequestId: 'r2' })), 'denied', 'gated');

    const sentBefore = h.sent.length;
    assert.deepEqual(h.acknowledge(s, jobId), { ok: true, value: { status: 'acknowledged' } });
    assert.deepEqual(h.sent.slice(sentBefore).map((x) => x.event), [
      { ...h.envelope(s), type: 'rewrite.reconciled', clientRequestId: 'r1', jobId },
      { ...h.envelope(s), type: 'outcome.cleared', kind: 'rewrite', jobId },
    ]);
    assert.equal(h.rewrites.length, 1, 'acknowledging sends nothing');
    assert.equal(h.rewrite(s, { clientRequestId: 'r3' }).ok, true, 'a new rewrite is admitted');
    assert.equal(h.rewrites.length, 2);
  });

  test('a reload learns of the outcome from SessionOpened and can acknowledge it', () => {
    const h = harness();
    const first = h.open();
    const jobId = h.unknownRewrite(first);
    const reloaded = h.open();
    assert.deepEqual(reloaded.unresolved, [report(jobId)]);
    assert.ok(Object.keys(reloaded.unresolved[0] ?? {}).every((key) => Object.hasOwn(OUTCOME_REPORT_SCHEMA, key)), 'only the report fields');
    const sentBefore = h.sent.length;
    assert.ok(h.acknowledge(reloaded, jobId).ok);
    assert.deepEqual(
      h.sent.slice(sentBefore).map((x) => x.event),
      [{ ...h.envelope(reloaded), type: 'outcome.cleared', kind: 'rewrite', jobId }],
      'the closed session gets nothing; the open one hears the gate cleared',
    );
    assert.deepEqual(h.open().unresolved, [], 'a later session starts ungated');
  });

  test('an outcome that becomes unknown after a reload is reported to the open session', () => {
    const h = harness();
    const first = h.open();
    const accepted = h.rewrite(first);
    assert.ok(accepted.ok);
    const reloaded = h.open(); // the job is still running and keeps the gate shut
    assert.deepEqual(reloaded.unresolved, []);
    const sentBefore = h.sent.length;
    h.rewrites[0]?.sink.failed('unknown_outcome');
    const jobId = (accepted.value as RewriteAccepted).jobId;
    assert.deepEqual(h.sent.slice(sentBefore).map((x) => x.event), [{ ...h.envelope(reloaded), type: 'outcome.unresolved', ...report(jobId) }]);
    assert.ok(h.acknowledge(reloaded, jobId).ok);
    assert.equal(h.gateOpen(), true);
  });

  test('every open window hears of the outcome and of its clearing; another window may acknowledge it', () => {
    const h = harness();
    const one = h.open(1);
    const two = h.open(2);
    const jobId = h.unknownRewrite(one);
    assert.deepEqual(h.eventsFor(two).map((e) => e.type), ['outcome.unresolved']);
    assert.ok(h.acknowledge(two, jobId, 'ack-two', caller(2)).ok);
    assert.deepEqual(h.eventsFor(one).slice(-2).map((e) => e.type), ['rewrite.reconciled', 'outcome.cleared']);
    assert.deepEqual(h.eventsFor(two).map((e) => e.type), ['outcome.unresolved', 'outcome.cleared']);
  });

  test('an outcome acknowledged while its failure is being delivered is not reported afterwards', () => {
    // A renderer that answers inside the delivery itself (re-entrant send): the report must not resurrect a cleared gate.
    const sent: MainEvent[] = [];
    let sink: JobSink | null = null;
    let next = 0;
    const main = createDesktopMain({
      policy: createRoutePolicy([BASE_REWRITE_ROUTE]),
      jobs: { submit: (_job, s) => (sink = s), cancel() {} },
      clipboard: { writeText() {} },
      newId: () => `id-${++next}`,
      acknowledgeRoutes: [BASE_REWRITE_ROUTE.routeKey],
      send(_windowId, _channel, event) {
        sent.push(event);
        if (event.type === 'rewrite.failed' && event.jobId !== null) {
          main.handle(CHANNELS.acknowledgeOutcome, caller(), { v: 1, sessionId: event.sessionId, epoch: event.epoch, clientRequestId: 'ack1', jobId: event.jobId });
        }
      },
    });
    main.registerWindow(1, TRUSTED_URL);
    const opened = main.handle(CHANNELS.createSession, caller(), { v: 1 });
    assert.ok(opened.ok);
    const s = opened.value as SessionOpened;
    const accepted = main.handle(CHANNELS.rewrite, caller(), {
      v: 1, sessionId: s.sessionId, epoch: s.epoch, clientRequestId: 'r1', routeKey: BASE_REWRITE_ROUTE.routeKey,
      sourceRevision: 1, steeringRevision: 0, transcript: SYNTHETIC, steering: '',
    });
    assert.ok(accepted.ok);
    (sink as JobSink | null)?.failed('unknown_outcome');
    assert.deepEqual(sent.map((e) => e.type), ['rewrite.accepted', 'rewrite.failed', 'rewrite.reconciled', 'outcome.cleared']);
  });

  test('a clock that is not a whole, non-negative millisecond count is stamped as 0, so the report still crosses the bridge', () => {
    for (const bad of [-5, 1.5, Number.NaN]) {
      const sent: MainEvent[] = [];
      let next = 0;
      const main = createDesktopMain({
        policy: createRoutePolicy([BASE_REWRITE_ROUTE]),
        jobs: { submit: (_job, sink) => sink.failed('unknown_outcome'), cancel() {} },
        clipboard: { writeText() {} },
        newId: () => `id-${++next}`,
        now: () => bad,
        send: (_windowId, _channel, event) => sent.push(event),
      });
      main.registerWindow(1, TRUSTED_URL);
      const opened = main.handle(CHANNELS.createSession, caller(), { v: 1 });
      assert.ok(opened.ok);
      const s = opened.value as SessionOpened;
      main.handle(CHANNELS.rewrite, caller(), {
        v: 1, sessionId: s.sessionId, epoch: s.epoch, clientRequestId: 'r1', routeKey: BASE_REWRITE_ROUTE.routeKey,
        sourceRevision: 1, steeringRevision: 0, transcript: SYNTHETIC, steering: '',
      });
      const report = sent.at(-1);
      assert.equal(report?.type === 'outcome.unresolved' ? report.sentAt : null, 0, String(bad));
      assert.notEqual(filterEvent(report), null, 'the preload lets it through');
    }
  });

  test('main-side reconcile still clears any route, and says so to every open session', () => {
    const h = harness();
    const s = h.open();
    const jobId = h.unknownRewrite(s, 'r1', FIXTURE_REWRITE_ROUTE.routeKey);
    assert.equal(h.main.reconcile(jobId), true);
    assert.deepEqual(h.eventsFor(s).slice(-2).map((e) => e.type), ['rewrite.reconciled', 'outcome.cleared']);
    assert.equal(h.gateOpen(), true);
  });
});

describe('acknowledgment refusals have no side effect', () => {
  /** Runs a refused call and checks it changed nothing: no event, no dispatch, the gate still shut. */
  function refused(h: ReturnType<typeof harness>, call: () => IpcResult<unknown>, expected: FailureCode, why: string) {
    const sentBefore = h.sent.length;
    const dispatched = h.rewrites.length;
    assert.equal(h.code(call()), expected, why);
    assert.equal(h.sent.length, sentBefore, `${why}: no event`);
    assert.equal(h.rewrites.length, dispatched, `${why}: no dispatch`);
    assert.equal(h.gateOpen(), false, `${why}: the gate stays shut`);
  }

  test('a wrong job ID is denied', () => {
    const h = harness();
    const s = h.open();
    const jobId = h.unknownRewrite(s);
    refused(h, () => h.acknowledge(s, 'not-a-job'), 'denied', 'an ID main never issued');
    refused(h, () => h.acknowledge(s, 'r1'), 'denied', "the job's request ID instead of its job ID");
    refused(h, () => h.acknowledge(s, `${jobId} `), 'denied', 'a near miss');
    assert.ok(h.acknowledge(s, jobId).ok, 'the exact ID still works afterwards');
    assert.equal(h.code(h.acknowledge(s, jobId, 'ack2')), 'denied', 'a cleared job cannot be acknowledged again');
  });

  test('a job that is running, not unknown, is denied and keeps running', () => {
    const h = harness();
    const s = h.open();
    const accepted = h.value<RewriteAccepted>(h.rewrite(s));
    const sentBefore = h.sent.length;
    assert.equal(h.code(h.acknowledge(s, accepted.jobId)), 'denied');
    assert.equal(h.sent.length, sentBefore);
    h.rewrites[0]?.sink.succeeded({ actualMode: 'base', actualIdentity: BASE_REWRITE_ROUTE.identity, text: 'Synthetic draft.' });
    assert.equal(h.eventsFor(s).at(-1)?.type, 'rewrite.succeeded', 'the job finished normally');
  });

  test('another session, a stale epoch or a closed session is denied', () => {
    const h = harness();
    const s = h.open();
    const jobId = h.unknownRewrite(s);
    const other = h.open(2);
    const call = (fields: Record<string, unknown>, from = caller()) =>
      h.main.handle(CHANNELS.acknowledgeOutcome, from, { ...h.envelope(s), clientRequestId: 'ack1', jobId, ...fields });
    refused(h, () => call({ sessionId: 'not-a-session' }), 'denied', 'an unknown session');
    refused(h, () => call({ epoch: s.epoch + 1 }), 'denied', 'a future epoch');
    refused(h, () => call({ epoch: s.epoch - 1 }), 'denied', 'a past epoch');
    refused(h, () => call({ sessionId: other.sessionId, epoch: other.epoch }), 'denied', "window 2's session, called from window 1");
    const reloaded = h.open();
    refused(h, () => call({}), 'denied', 'the closed session from before the reload');
    assert.ok(h.acknowledge(reloaded, jobId).ok);
  });

  test('an untrusted caller is denied', () => {
    const h = harness();
    const s = h.open();
    const jobId = h.unknownRewrite(s);
    const untrusted: (Caller | null)[] = [
      null,
      caller(1, { isTopFrame: false }),
      caller(1, { frameUrl: 'https://example.invalid/' }),
      caller(1, { frameUrl: 'file:///app/renderer/other.html' }),
      caller(9),
    ];
    for (const from of untrusted) refused(h, () => h.acknowledge(s, jobId, 'ack1', from), 'denied', JSON.stringify(from));
  });

  test('a malformed request is refused before any check', () => {
    const h = harness();
    const s = h.open();
    const jobId = h.unknownRewrite(s);
    const good = { ...h.envelope(s), clientRequestId: 'ack1', jobId };
    const bad: [unknown, FailureCode][] = [
      [{ ...good, extra: true }, 'invalid_input'],
      [{ ...good, jobId: undefined }, 'invalid_input'],
      [{ ...good, jobId: '' }, 'invalid_input'],
      [{ ...good, clientRequestId: 7 }, 'invalid_input'],
      [{ ...good, routeKey: BASE_REWRITE_ROUTE.routeKey }, 'invalid_input'],
      [{ ...good, v: 2 }, 'unsupported'],
      [[good], 'invalid_input'],
    ];
    for (const [payload, expected] of bad) refused(h, () => h.main.handle(CHANNELS.acknowledgeOutcome, caller(), payload), expected, JSON.stringify(payload));
  });

  test('a route whose card does not allow acknowledgment is unsupported: fixture routes', async () => {
    const h = harness();
    const s = h.open();
    const jobId = h.unknownRewrite(s, 'r1', FIXTURE_REWRITE_ROUTE.routeKey);
    assert.deepEqual(h.eventsFor(s).at(-1), { ...h.envelope(s), type: 'outcome.unresolved', ...report(jobId, { routeKey: FIXTURE_REWRITE_ROUTE.routeKey, clearance: 'restart' }) });
    refused(h, () => h.acknowledge(s, jobId), 'unsupported', 'the fixture rewrite route');
    assert.equal(h.main.reconcile(jobId), true);

    const chosen = (await h.main.invoke(CHANNELS.chooseAudio, caller(), h.envelope(s))) as IpcResult<ChooseAudioResult>;
    assert.ok(chosen.ok && chosen.value.status === 'chosen');
    const transcribing = h.main.handle(CHANNELS.transcribe, caller(), {
      ...h.envelope(s),
      clientRequestId: 't1',
      routeKey: FIXTURE_TRANSCRIBE_ROUTE.routeKey,
      assetToken: chosen.value.assetToken,
      sourceRevision: 0,
    });
    const tJob = h.value<TranscribeAccepted>(transcribing).jobId;
    h.transcriptions[0]?.sink.failed('unknown_outcome');
    assert.deepEqual(h.eventsFor(s).at(-1), {
      ...h.envelope(s),
      type: 'outcome.unresolved',
      ...report(tJob, { kind: 'transcribe', routeKey: FIXTURE_TRANSCRIBE_ROUTE.routeKey, clearance: 'restart' }),
    });
    refused(h, () => h.acknowledge(s, tJob, 'ack2'), 'unsupported', 'the fixture transcription route');
  });

  test('a route left out of acknowledgeRoutes is unsupported, even route card 07', () => {
    const h = harness({ acknowledgeRoutes: [] });
    const s = h.open();
    const jobId = h.unknownRewrite(s);
    assert.equal(s.capabilities.routes.some((r) => r.routeKey === BASE_REWRITE_ROUTE.routeKey), true);
    refused(h, () => h.acknowledge(s, jobId), 'unsupported', 'no card allows it');
  });

  test('a replayed or reused request ID is denied', () => {
    const h = harness();
    const s = h.open();
    const first = h.unknownRewrite(s, 'r1');
    refused(h, () => h.acknowledge(s, first, 'r1'), 'denied', "the rewrite's own request ID");
    assert.ok(h.acknowledge(s, first, 'ack1').ok);

    const second = h.unknownRewrite(s, 'r2');
    refused(h, () => h.acknowledge(s, first, 'ack1'), 'denied', 'the identical acknowledgment, replayed');
    refused(h, () => h.acknowledge(s, second, 'ack1'), 'denied', 'the used ID for a new job');
    assert.ok(h.acknowledge(s, second, 'ack2').ok, 'a fresh ID works');

    const dispatched = h.rewrites.length;
    assert.equal(h.code(h.rewrite(s, { clientRequestId: 'ack1' })), 'invalid_input', 'a rewrite under a used acknowledgment ID is a conflict');
    assert.equal(h.rewrites.length, dispatched);
  });

  test("an unknown outcome's request record survives eviction, so after acknowledging an identical retry replays and never dispatches", () => {
    const h = harness();
    const s = h.open();
    const jobId = h.unknownRewrite(s, 'r1');
    for (let i = 0; i < MAX_REQUEST_RECORDS + 4; i++) assert.equal(h.code(h.rewrite(s, { clientRequestId: `refused-${i}` })), 'denied');
    assert.ok(h.acknowledge(s, jobId).ok);
    const replay = h.rewrite(s, { clientRequestId: 'r1' });
    assert.equal(h.value<RewriteAccepted>(replay).jobId, jobId, 'the first result, replayed');
    assert.equal(h.rewrites.length, 1, 'not dispatched again');
  });

  test('a refused acknowledgment leaves its request ID unused', () => {
    const h = harness();
    const s = h.open();
    const jobId = h.unknownRewrite(s);
    assert.equal(h.code(h.acknowledge(s, 'not-a-job', 'ack1')), 'denied');
    assert.ok(h.acknowledge(s, jobId, 'ack1').ok);
  });

  test('the refusal rule itself: a reused ID, an unknown job, a route without acknowledgment, a running job', () => {
    const fine = { requestIdUsed: false, unresolved: true, acknowledgeable: true, running: 0 };
    assert.equal(acknowledgmentRefusal(fine), null);
    assert.equal(acknowledgmentRefusal({ ...fine, requestIdUsed: true }), 'denied');
    assert.equal(acknowledgmentRefusal({ ...fine, unresolved: false }), 'denied');
    assert.equal(acknowledgmentRefusal({ ...fine, acknowledgeable: false }), 'unsupported');
    // One job runs at a time and none starts while an outcome is unknown, so no intent reaches this today.
    assert.equal(acknowledgmentRefusal({ ...fine, running: 1 }), 'denied');
  });
});

describe('route card 07 is acknowledgeable only while synthetic-only', () => {
  test('the marker decides it', () => {
    assert.equal(BASE_REWRITE_SETTINGS.requireMarker, 'synthetic');
    assert.equal(baseRewriteAcknowledgeable(), true);
    assert.equal(baseRewriteAcknowledgeable({}), false, 'no marker: real text could be sent, so no acknowledgment');
    assert.equal(baseRewriteAcknowledgeable({ requireMarker: 'test' }), false);
  });
});

describe('acknowledgeRoutes at startup', () => {
  test('only registered routes that are not fixtures may be acknowledgeable', () => {
    assert.throws(() => harness({ acknowledgeRoutes: [FIXTURE_REWRITE_ROUTE.routeKey] }), /non-fixture/);
    assert.throws(() => harness({ acknowledgeRoutes: [FIXTURE_TRANSCRIBE_ROUTE.routeKey] }), /non-fixture/);
    assert.throws(() => harness({ acknowledgeRoutes: ['not-a-route'] }), /registered/);
    assert.throws(() => harness({ routes: [FIXTURE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE] }), /registered/, 'route card 07 off, but named');
  });
});

describe('outcome reports across the bridge', () => {
  test('the façade sends exactly the acknowledgment fields on its own channel', async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    const api = createDesktopApi({
      invoke: async (channel, payload) => (calls.push({ channel, payload }), { ok: true, value: { status: 'acknowledged' } }),
      subscribe: () => () => {},
    });
    const sneaky = { v: 9, sessionId: 's1', epoch: 1, clientRequestId: 'ack1', jobId: 'j1', routeKey: 'elsewhere' } as never;
    assert.deepEqual(await api.acknowledgeOutcome(sneaky), { ok: true, value: { status: 'acknowledged' } });
    assert.deepEqual(calls, [{ channel: CHANNELS.acknowledgeOutcome, payload: { v: 1, sessionId: 's1', epoch: 1, clientRequestId: 'ack1', jobId: 'j1' } }]);
  });

  test('only well-formed outcome events pass the preload filter', () => {
    const envelope = { v: 1, sessionId: 's1', epoch: 1 };
    const unresolved = { ...envelope, type: 'outcome.unresolved', ...report('j1') };
    const cleared = { ...envelope, type: 'outcome.cleared', kind: 'rewrite', jobId: 'j1' };
    assert.deepEqual(filterEvent(unresolved), unresolved);
    assert.deepEqual(filterEvent(cleared), cleared);
    const bad = [
      { ...unresolved, clearance: 'auto' },
      { ...unresolved, kind: 'capture' },
      { ...unresolved, sentAt: -1 },
      { ...unresolved, sentAt: 1.5 },
      { ...unresolved, text: 'a draft' },
      { ...cleared, kind: 'copy' },
      { ...cleared, clientRequestId: 'r1' },
    ];
    for (const event of bad) assert.equal(filterEvent(event), null, JSON.stringify(event));
  });

  test('readOutcomeReport returns a frozen copy of exactly the report fields', () => {
    const copy = readOutcomeReport({ ...report('j1') });
    assert.deepEqual(copy, report('j1'));
    assert.ok(Object.isFrozen(copy));
    assert.equal(readOutcomeReport({ ...report('j1'), extra: 1 }), null);
    assert.equal(readOutcomeReport(null), null);
  });
});

/** A throwaway transport for route card 07's chat provider: it never opens a socket and answers each send in turn. */
function scriptedTransport(...replies: ChatReply[]): ChatTransport & { readonly sends: ChatRequest[] } {
  const sends: ChatRequest[] = [];
  return {
    sends,
    async send(request) {
      sends.push(request);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('no scripted reply');
      return reply;
    },
  };
}

function chatReply(text: string): ChatReply {
  const body = { object: 'chat.completion', model: BASE_REWRITE_ROUTE.identity, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] };
  return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(body)) };
}

describe('the journey through the real composition', () => {
  test('route card 07 on: an unknown outcome, acknowledged, lets the next rewrite through; one send each', async () => {
    // A 500 after the request was sent is an unknown outcome under route card 07's outage rule.
    const transport = scriptedTransport({ status: 500, contentType: 'text/plain', body: new Uint8Array() }, chatReply('Synthetic test: meet Thursday at noon.'));
    const listeners = new Set<(payload: unknown) => void>();
    let next = 0;
    const { main } = createSyntheticMain({
      baseRewrite: transport,
      clipboard: { writeText() {} },
      newId: () => `id-${++next}`,
      now: () => NOW,
      send: (_windowId, _channel, event) => listeners.forEach((listener) => listener(structuredClone(event))),
    });
    main.registerWindow(1, TRUSTED_URL);
    const bridge: PreloadTransport = {
      invoke: async (channel, payload) => main.invoke(channel, caller(), structuredClone(payload)),
      subscribe: (_channel, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const api = createDesktopApi(bridge);
    const opened = await api.createSession();
    assert.ok(opened.ok);
    assert.deepEqual(opened.value.unresolved, []);
    const route = opened.value.capabilities.routes.find((r) => r.stage === 'rewrite') ?? null;
    assert.equal(route?.routeKey, BASE_REWRITE_ROUTE.routeKey);
    let state: SessionState = createSession({ sessionId: opened.value.sessionId, epoch: opened.value.epoch, route, outcomes: opened.value.unresolved });
    api.onEvent((event) => {
      state = reduce(state, event);
    });
    const envelope = { v: 1, sessionId: state.sessionId, epoch: state.epoch } as const;

    state = reduce(state, { type: 'edit.transcript', text: SYNTHETIC });
    state = reduce(state, { type: 'rewrite.request', clientRequestId: 'r1' });
    const first = rewriteRequest(state);
    assert.ok(first);
    assert.ok((await api.rewrite(first)).ok);
    await settle();
    await settle();
    assert.equal(state.notice, 'unknown_outcome');
    assert.equal(rewriteBlocker(state), 'unresolved_outcome');
    assert.equal(state.outcomes.length, 1);
    const reported = state.outcomes[0];
    assert.deepEqual(reported, report(reported?.jobId ?? '?'));
    assert.deepEqual(await api.rewrite({ ...first, clientRequestId: 'r-sneaky' }), { ok: false, code: 'denied' }, 'main refuses a renderer that ignores its gate');

    assert.deepEqual(await api.acknowledgeOutcome({ ...envelope, clientRequestId: 'ack1', jobId: reported?.jobId ?? '?' }), { ok: true, value: { status: 'acknowledged' } });
    assert.equal(rewriteBlocker(state), null, 'the events cleared the renderer gate');
    assert.equal(state.notice, 'outcome_cleared');
    assert.equal(transport.sends.length, 1, 'acknowledging resent nothing');

    state = reduce(state, { type: 'rewrite.request', clientRequestId: 'r2' });
    const second = rewriteRequest(state);
    assert.ok(second);
    assert.ok((await api.rewrite(second)).ok, 'main admits the new rewrite');
    await settle();
    await settle();
    assert.equal(transport.sends.length, 2);
    assert.equal(state.notice, null, String(state.notice));
    assert.equal(state.draft?.text, 'Synthetic test: meet Thursday at noon.');
  });

  test('route card 07 off: nothing is acknowledgeable', async () => {
    const { main } = createSyntheticMain({ clipboard: { writeText() {} }, send() {} });
    main.registerWindow(1, TRUSTED_URL);
    const opened = main.handle(CHANNELS.createSession, caller(), { v: 1 });
    assert.ok(opened.ok);
    const s = opened.value as SessionOpened;
    assert.deepEqual(s.unresolved, []);
    const result = main.handle(CHANNELS.acknowledgeOutcome, caller(), { v: 1, sessionId: s.sessionId, epoch: s.epoch, clientRequestId: 'ack1', jobId: 'any' });
    assert.deepEqual(result, { ok: false, code: 'denied' });
  });
});
