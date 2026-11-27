// Synthetic contract tests for Packet E2: the transcribe intent in main, the
// transcription runner and fixture, and the full offline journey
// choose audio → transcribe → Replace/Keep → rewrite. Generated tones only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CHANNELS } from '../../src/contracts/ipc.ts';
import type { ChooseAudioResult, IpcResult, SessionOpened } from '../../src/contracts/ipc.ts';
import type { MainEvent, TranscribeAccepted } from '../../src/contracts/session.ts';
import { createDesktopMain } from '../../src/main/ipc.ts';
import type { JobSink, TranscribeJob } from '../../src/main/ipc.ts';
import { FIXTURE_JOB_TIMEOUT_MS, createJobRunner, createTranscribeRunner } from '../../src/main/jobs.ts';
import type { TranscribeProvider } from '../../src/main/jobs.ts';
import type { AudioChooserPort, ChooserResult } from '../../src/main/platform/media.ts';
import { FIXTURE_TRANSCRIPT, createFixtureRewriteProvider, createFixtureTranscriber } from '../../src/main/providers/fixture.ts';
import { FIXTURE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE, createRoutePolicy } from '../../src/main/routePolicy.ts';
import type { Caller } from '../../src/main/sessionRegistry.ts';
import { createSyntheticMain } from '../../src/main/synthetic.ts';
import { createDesktopApi } from '../../src/preload/desktop.ts';
import { createSession, reduce, rewriteRequest, transcribeRequest } from '../../src/renderer/session.ts';
import type { SessionState } from '../../src/renderer/session.ts';
import { fakeClock, settle } from '../fixtures/clock.ts';
import { noonWav, synthWav } from '../fixtures/wav.ts';

const TRUSTED_URL = 'file:///app/renderer/index.html';
const caller: Caller = { windowId: 1, frameUrl: TRUSTED_URL, isTopFrame: true };

/** Answers each chooser call with the next queued result. */
function queuedChooser(...results: ChooserResult[]): AudioChooserPort {
  return { pickAudio: async () => results.shift() ?? { status: 'cancelled' } };
}

function harness(options: { transcriber?: boolean; chooser?: AudioChooserPort; onSubmit?: (job: TranscribeJob, sink: JobSink) => void } = {}) {
  const sent: MainEvent[] = [];
  const submitted: { job: TranscribeJob; sink: JobSink }[] = [];
  const transcriberCancels: string[] = [];
  let next = 0;
  const policy = createRoutePolicy([FIXTURE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE]);
  const main = createDesktopMain({
    policy,
    jobs: createJobRunner({ routes: policy.routes, providers: [createFixtureRewriteProvider()] }),
    transcriber: options.transcriber === false ? undefined : {
      submit(job, sink) {
        submitted.push({ job, sink });
        options.onSubmit?.(job, sink);
      },
      cancel: (jobId) => transcriberCancels.push(jobId),
    },
    chooser: options.chooser ?? queuedChooser({ status: 'picked', bytes: noonWav() }),
    clipboard: { writeText() {} },
    send: (_windowId, _channel, event) => sent.push(event),
    newId: () => `id-${++next}`,
  });
  main.registerWindow(1, TRUSTED_URL);
  const opened = main.handle(CHANNELS.createSession, caller, { v: 1 });
  assert.ok(opened.ok);
  const session = opened.value as SessionOpened;
  const envelope = { v: 1, sessionId: session.sessionId, epoch: session.epoch };
  const choose = async () => {
    const result = (await main.invoke(CHANNELS.chooseAudio, caller, envelope)) as IpcResult<ChooseAudioResult>;
    assert.ok(result.ok && result.value.status === 'chosen', JSON.stringify(result));
    return result.value.assetToken;
  };
  const transcribe = (assetToken: string, overrides: Record<string, unknown> = {}) =>
    main.handle(CHANNELS.transcribe, caller, { ...envelope, clientRequestId: 't1', routeKey: 'fixture-transcribe', assetToken, sourceRevision: 0, ...overrides });
  return { main, sent, submitted, transcriberCancels, session, envelope, choose, transcribe };
}

describe('transcribe intent', () => {
  test('a chosen asset is transcribed once, with accepted sent first', async () => {
    const h = harness();
    assert.ok(h.session.capabilities.actions.includes('transcribe'));
    const token = await h.choose();
    const result = h.transcribe(token);
    assert.ok(result.ok);
    const accepted = result.value as TranscribeAccepted;
    assert.deepEqual(h.sent, [accepted]);
    assert.equal(h.submitted.length, 1);
    assert.equal(h.transcribe(token), result, 'an identical retry replays');
    assert.deepEqual(h.transcribe(token, { sourceRevision: 3 }), { ok: false, code: 'invalid_input' }, 'same ID, new body');
    assert.equal(h.submitted.length, 1);
    h.submitted[0]?.sink.succeeded({ actualMode: 'fixture', actualIdentity: 'fixture-asr-v1', text: FIXTURE_TRANSCRIPT });
    assert.deepEqual(h.sent.at(-1), { ...h.envelope, type: 'transcribe.succeeded', clientRequestId: 't1', jobId: accepted.jobId,
      sourceRevision: 0, actualMode: 'fixture', actualIdentity: 'fixture-asr-v1', text: FIXTURE_TRANSCRIPT });
  });

  test('the transcriber receives only canonical samples, as its own copy', async () => {
    const tagged = synthWav({ extraChunks: [{ id: 'LIST', size: 101 }] });
    const h = harness({ chooser: queuedChooser({ status: 'picked', bytes: tagged }) });
    h.transcribe(await h.choose());
    const token = 'id-2';
    const audio = h.submitted[0]?.job.audio;
    assert.ok(audio);
    assert.deepEqual(audio, noonWav(), 'fmt + data only');
    audio.fill(0); // an adapter scribbling on its copy
    h.transcribe(token, { clientRequestId: 't2' });
    assert.equal(h.submitted.length, 1, 'one job at a time');
    h.submitted[0]?.sink.failed('timed_out');
    h.transcribe(token, { clientRequestId: 't3' });
    assert.deepEqual(h.submitted[1]?.job.audio, noonWav(), 'the stored asset is untouched');
  });

  test('a session keeps one asset: a new choice revokes the old token', async () => {
    const h = harness({ chooser: queuedChooser({ status: 'picked', bytes: noonWav() }, { status: 'picked', bytes: synthWav({ durationMs: 500 }) }) });
    const first = await h.choose();
    const second = await h.choose();
    assert.notEqual(first, second);
    assert.deepEqual(h.transcribe(first), { ok: false, code: 'denied' });
    assert.ok(h.transcribe(second, { clientRequestId: 't2' }).ok);
  });

  test('refusals are announced with jobId null and never dispatch', async () => {
    const h = harness();
    const token = await h.choose();
    const cases: [Record<string, unknown>, string][] = [
      [{ clientRequestId: 'a', assetToken: 'not-a-token-of-ours' }, 'denied'],
      [{ clientRequestId: 'b', routeKey: 'fixture-rewrite' }, 'unsupported'],
      [{ clientRequestId: 'c', routeKey: 'personal-asr' }, 'denied'],
    ];
    for (const [overrides, code] of cases) assert.deepEqual(h.transcribe(token, overrides), { ok: false, code });
    assert.equal(h.submitted.length, 0);
    assert.deepEqual(h.sent.map((e) => (e.type === 'transcribe.failed' ? [e.clientRequestId, e.jobId, e.code] : e.type)),
      [['a', null, 'denied'], ['b', null, 'unsupported'], ['c', null, 'denied']]);
  });

  test('without a transcriber the intent is not offered', async () => {
    const h = harness({ transcriber: false });
    assert.ok(!h.session.capabilities.actions.includes('transcribe'));
    assert.deepEqual(h.transcribe(await h.choose()), { ok: false, code: 'unsupported' });
  });

  test('a running transcription blocks rewrites; an unknown outcome gates both until reconciled', async () => {
    const h = harness();
    const token = await h.choose();
    const accepted = h.transcribe(token);
    assert.ok(accepted.ok);
    const rewrite = { ...h.envelope, clientRequestId: 'r1', routeKey: 'fixture-rewrite', sourceRevision: 0, steeringRevision: 0, transcript: 'Meet at noon.', steering: '' };
    assert.deepEqual(h.main.handle(CHANNELS.rewrite, caller, rewrite), { ok: false, code: 'denied' });
    h.submitted[0]?.sink.failed('unknown_outcome');
    assert.deepEqual(h.main.handle(CHANNELS.rewrite, caller, { ...rewrite, clientRequestId: 'r2' }), { ok: false, code: 'denied' });
    assert.equal(h.main.reconcile((accepted.value as TranscribeAccepted).jobId), true);
    assert.deepEqual(h.sent.slice(-2).map((e) => e.type), ['transcribe.reconciled', 'outcome.cleared']);
    assert.ok(h.main.handle(CHANNELS.rewrite, caller, { ...rewrite, clientRequestId: 'r3' }).ok);
  });

  test('an unknown transcription outcome refuses further transcriptions too', async () => {
    const h = harness({ chooser: queuedChooser({ status: 'picked', bytes: noonWav() }, { status: 'picked', bytes: noonWav() }) });
    h.transcribe(await h.choose());
    h.submitted[0]?.sink.failed('unknown_outcome');
    assert.deepEqual(h.transcribe(await h.choose(), { clientRequestId: 't2' }), { ok: false, code: 'denied' });
    assert.equal(h.submitted.length, 1);
  });

  test('cancel, close, navigation and new audio all reach the transcription runner', async () => {
    for (const end of ['cancel', 'close', 'navigate', 'new-audio'] as const) {
      const h = harness({ chooser: queuedChooser({ status: 'picked', bytes: noonWav() }, { status: 'picked', bytes: noonWav() }) });
      const accepted = h.transcribe(await h.choose());
      assert.ok(accepted.ok);
      const jobId = (accepted.value as TranscribeAccepted).jobId;
      if (end === 'cancel') assert.deepEqual(h.main.handle(CHANNELS.cancel, caller, { ...h.envelope, clientRequestId: 't1' }), { ok: true, value: { disposition: 'cancel_requested' } });
      if (end === 'close') h.main.handle(CHANNELS.closeSession, caller, h.envelope);
      if (end === 'navigate') h.main.windowNavigated(1);
      if (end === 'new-audio') await h.choose();
      assert.deepEqual(h.transcriberCancels, [jobId], end);
    }
  });

  test('a throwing transcriber is an unknown outcome; refusals are replayed, not re-sent', async () => {
    const h = harness({ onSubmit: () => { throw new Error('synthetic adapter crash'); } });
    const token = await h.choose();
    assert.ok(h.transcribe(token).ok);
    const [last, report] = h.sent.slice(-2);
    assert.equal(last?.type === 'transcribe.failed' ? last.code : last?.type, 'unknown_outcome');
    assert.equal(report?.type, 'outcome.unresolved');
    const refusal = h.transcribe('not-ours', { clientRequestId: 'r-refused' });
    const sentBefore = h.sent.length;
    assert.equal(h.transcribe('not-ours', { clientRequestId: 'r-refused' }), refusal, 'the same refusal object, replayed');
    assert.equal(h.sent.length, sentBefore, 'no second announcement');
  });

  test('transcribe is offered only with a ready transcription route', () => {
    let next = 0;
    const policy = createRoutePolicy([FIXTURE_REWRITE_ROUTE, { ...FIXTURE_TRANSCRIBE_ROUTE, readiness: 'disabled' }]);
    const main = createDesktopMain({
      policy,
      jobs: createJobRunner({ routes: policy.routes, providers: [createFixtureRewriteProvider()] }),
      transcriber: { submit() {}, cancel() {} },
      clipboard: { writeText() {} },
      send() {},
      newId: () => `id-${++next}`,
    });
    main.registerWindow(1, TRUSTED_URL);
    const opened = main.handle(CHANNELS.createSession, caller, { v: 1 });
    assert.ok(opened.ok && !(opened.value as SessionOpened).capabilities.actions.includes('transcribe'));
  });

  test('main checks the transcriber’s result before the renderer sees it', async () => {
    for (const [result, code] of [
      [{ actualMode: 'fixture', actualIdentity: 'fixture-v1', text: 'Meet at noon.' }, 'provider_mismatch'],
      [{ actualMode: 'fixture', actualIdentity: 'fixture-asr-v1', text: 'a'.repeat(16 * 1024 + 1) }, 'invalid_response'],
      [{ actualMode: 'fixture', actualIdentity: 'fixture-asr-v1', text: ' ' }, 'invalid_response'],
    ] as const) {
      const h = harness();
      h.transcribe(await h.choose());
      h.submitted[0]?.sink.succeeded(result);
      const last = h.sent.at(-1);
      assert.equal(last?.type === 'transcribe.failed' ? last.code : last?.type, code);
    }
  });
});

describe('transcription runner and fixture', () => {
  test('the fixture transcriber stops on cancel', async () => {
    const clock = fakeClock();
    const fixture = createFixtureTranscriber({ clock, delayMs: 200 });
    const runner = createTranscribeRunner({ routes: [FIXTURE_TRANSCRIBE_ROUTE], providers: [fixture], clock });
    const outcomes: unknown[] = [];
    runner.submit({ jobId: 'j1', route: FIXTURE_TRANSCRIBE_ROUTE, audio: noonWav() }, { succeeded: (r) => outcomes.push(r), failed: (c) => outcomes.push(c) });
    runner.cancel('j1');
    assert.equal(clock.pending, 0, 'its own timer stopped too');
    await clock.advance(1_000);
    assert.deepEqual(outcomes, ['cancelled']);
  });

  test('the fixture transcribes only fixture-format audio, after its delay', async () => {
    const clock = fakeClock();
    const fixture = createFixtureTranscriber({ clock, delayMs: 200 });
    const runner = createTranscribeRunner({ routes: [FIXTURE_TRANSCRIBE_ROUTE], providers: [fixture], clock });
    const outcomes: unknown[] = [];
    const sink: JobSink = { succeeded: (r) => outcomes.push(r), failed: (c) => outcomes.push(c) };
    runner.submit({ jobId: 'j1', route: FIXTURE_TRANSCRIBE_ROUTE, audio: noonWav() }, sink);
    await clock.advance(199);
    assert.deepEqual(outcomes, []);
    await clock.advance(1);
    assert.deepEqual(outcomes, [{ actualMode: 'fixture', actualIdentity: 'fixture-asr-v1', text: FIXTURE_TRANSCRIPT }]);
    runner.submit({ jobId: 'j2', route: FIXTURE_TRANSCRIBE_ROUTE, audio: synthWav({ channels: 2 }) }, sink);
    await settle();
    assert.equal(outcomes.at(-1), 'invalid_input');
  });

  test('a transcription adapter must match a transcribe route', () => {
    const fixture = createFixtureTranscriber();
    assert.throws(() => createTranscribeRunner({ routes: [FIXTURE_REWRITE_ROUTE], providers: [fixture] }), /no published transcribe route/);
    const wrong: TranscribeProvider = { ...fixture, run: fixture.run, identity: 'fixture-asr-v9' };
    assert.throws(() => createTranscribeRunner({ routes: [FIXTURE_TRANSCRIBE_ROUTE], providers: [wrong] }), /identity/);
  });
});

describe('offline journey: choose → transcribe → Replace/Keep → rewrite', () => {
  function journey(chooser: AudioChooserPort, delayMs = 100) {
    const clock = fakeClock();
    const listeners = new Set<(payload: unknown) => void>();
    const { main, transcriber, fixture } = createSyntheticMain({
      clock,
      fixtureDelayMs: delayMs,
      chooser,
      clipboard: { writeText() {} },
      send: (_w, _c, event) => listeners.forEach((listener) => listener(structuredClone(event))),
    });
    main.registerWindow(1, TRUSTED_URL);
    const api = createDesktopApi({
      invoke: (channel, payload) => main.invoke(channel, caller, structuredClone(payload)),
      subscribe: (_channel, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const box: { s: SessionState | null } = { s: null };
    api.onEvent((event) => {
      if (box.s) box.s = reduce(box.s, event);
    });
    const state = () => {
      assert.ok(box.s);
      return box.s;
    };
    return { clock, api, transcriber, fixture, box, state };
  }

  async function start(j: ReturnType<typeof journey>) {
    const opened = await j.api.createSession();
    assert.ok(opened.ok);
    const routes = opened.value.capabilities.routes;
    j.box.s = createSession({ sessionId: opened.value.sessionId, epoch: opened.value.epoch,
      route: routes.find((r) => r.stage === 'rewrite') ?? null, transcribeRoute: routes.find((r) => r.stage === 'transcribe') ?? null });
    return opened.value;
  }

  async function transcribeChosen(j: ReturnType<typeof journey>, opened: SessionOpened, id: string) {
    const chosen = await j.api.chooseAudio({ v: 1, sessionId: opened.sessionId, epoch: opened.epoch });
    assert.ok(chosen.ok && chosen.value.status === 'chosen');
    j.box.s = reduce(j.state(), { type: 'audio.chosen', assetToken: chosen.value.assetToken });
    j.box.s = reduce(j.state(), { type: 'transcribe.request', clientRequestId: id, assetToken: chosen.value.assetToken });
    const request = transcribeRequest(j.state());
    assert.ok(request);
    assert.equal((await j.api.transcribe(request)).ok, true);
    await j.clock.advance(100);
  }

  test('audio into an empty editor, then a synthetic rewrite with visible identities', async () => {
    const j = journey(queuedChooser({ status: 'picked', bytes: noonWav() }));
    const opened = await start(j);
    await transcribeChosen(j, opened, 't1');
    assert.equal(j.state().transcript, FIXTURE_TRANSCRIPT);
    j.box.s = reduce(j.state(), { type: 'rewrite.request', clientRequestId: 'r1' });
    const request = rewriteRequest(j.state());
    assert.ok(request);
    await j.api.rewrite(request);
    await j.clock.advance(100);
    assert.equal(j.state().draft?.text, FIXTURE_TRANSCRIPT);
    assert.equal(j.state().draft?.identity, 'fixture-v1');
    assert.equal(j.transcriber.calls, 1);
    assert.equal(j.fixture.calls, 1);
  });

  test('audio over typed text waits for Replace or Keep', async () => {
    const j = journey(queuedChooser({ status: 'picked', bytes: noonWav() }, { status: 'picked', bytes: noonWav() }));
    const opened = await start(j);
    j.box.s = reduce(j.state(), { type: 'edit.transcript', text: 'Meet on Thursday.' });
    await transcribeChosen(j, opened, 't1');
    assert.equal(j.state().transcript, 'Meet on Thursday.');
    assert.equal(j.state().candidate?.identity, 'fixture-asr-v1');
    j.box.s = reduce(j.state(), { type: 'candidate.keep' });
    assert.equal(j.state().transcript, 'Meet on Thursday.');
    await transcribeChosen(j, opened, 't2');
    j.box.s = reduce(j.state(), { type: 'candidate.replace' });
    assert.equal(j.state().transcript, FIXTURE_TRANSCRIPT);
  });

  test('a fixture transcription times out as a known failure and can be retried', async () => {
    const j = journey(queuedChooser({ status: 'picked', bytes: noonWav() }), FIXTURE_JOB_TIMEOUT_MS + 1_000);
    const opened = await start(j);
    const chosen = await j.api.chooseAudio({ v: 1, sessionId: opened.sessionId, epoch: opened.epoch });
    assert.ok(chosen.ok && chosen.value.status === 'chosen');
    j.box.s = reduce(j.state(), { type: 'audio.chosen', assetToken: chosen.value.assetToken });
    j.box.s = reduce(j.state(), { type: 'transcribe.request', clientRequestId: 't1', assetToken: chosen.value.assetToken });
    const request = transcribeRequest(j.state());
    assert.ok(request);
    await j.api.transcribe(request);
    await j.clock.advance(FIXTURE_JOB_TIMEOUT_MS);
    assert.equal(j.state().notice, 'timed_out');
    assert.equal(j.state().transcript, '');
    assert.deepEqual(j.state().unresolved, [], 'nothing left the process, so the outcome is known');
    j.box.s = reduce(j.state(), { type: 'transcribe.request', clientRequestId: 't2', assetToken: chosen.value.assetToken });
    assert.ok(j.state().transcription, 'a retry is allowed');
  });
});
