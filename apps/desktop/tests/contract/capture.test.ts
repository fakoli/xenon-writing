// Synthetic contract tests for Packet E part 3: microphone permission states
// and the capture lifecycle (platform and component designs). Fake OS ports, a
// fake clock and generated tones only; no microphone, prompt or device.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CHANNELS } from '../../src/contracts/ipc.ts';
import type { CaptureEndReason, ChooseAudioResult, IpcResult, MicrophoneState, SessionOpened, StartCaptureResult } from '../../src/contracts/ipc.ts';
import type { MainEvent } from '../../src/contracts/session.ts';
import { createDesktopMain } from '../../src/main/ipc.ts';
import { createJobRunner } from '../../src/main/jobs.ts';
import { CaptureUnavailable } from '../../src/main/platform/capture.ts';
import type { CapturePort, CaptureStream, MicrophonePort } from '../../src/main/platform/capture.ts';
import { FIXTURE_AUDIO } from '../../src/main/platform/media.ts';
import { createFixtureRewriteProvider } from '../../src/main/providers/fixture.ts';
import { FIXTURE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE, createRoutePolicy } from '../../src/main/routePolicy.ts';
import type { Caller } from '../../src/main/sessionRegistry.ts';
import { fakeClock, settle } from '../fixtures/clock.ts';
import { noonWav, synthWav } from '../fixtures/wav.ts';

const TRUSTED_URL = 'file:///app/renderer/index.html';
const caller = (windowId = 1): Caller => ({ windowId, frameUrl: TRUSTED_URL, isTopFrame: true });

/** An OS permission that answers the prompt with `answer`, and can be changed (revoked) later. */
function fakeMicrophone(initial: string, answer: MicrophoneState = 'granted') {
  let state: string = initial;
  let prompts = 0;
  let release: (() => void) | null = null;
  let hold = false;
  let failStatus = false;
  let failRequest = false;
  const port: MicrophonePort = {
    status: () => {
      if (failStatus) throw new Error('synthetic OS query failure');
      return state as MicrophoneState;
    },
    request: async () => {
      prompts += 1;
      if (failRequest) throw new Error('synthetic prompt failure');
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      state = answer;
      return answer;
    },
  };
  return {
    port,
    get prompts() { return prompts; },
    set: (next: string) => { state = next; },
    holdPrompt: () => { hold = true; },
    answerPrompt: () => release?.(),
    failStatus: () => { failStatus = true; },
    failRequest: () => { failRequest = true; },
  };
}

interface FakeStream {
  stopped: number;
  discarded: number;
  readonly live: boolean;
  end(reason: CaptureEndReason): void;
}

/** A capture device whose stop can succeed, fail, hang, or be held until released. */
function fakeCapture(bytes: () => Uint8Array = noonWav) {
  const streams: FakeStream[] = [];
  let failNext: Error | null = null;
  let holdStart: (() => void) | null = null;
  let holdNextStart = false;
  let stopMode: 'ok' | 'fail' | 'hang' | 'hold' = 'ok';
  let releaseStop: (() => void) | null = null;
  let discardThrows = false;
  const port: CapturePort = {
    async start() {
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      if (holdNextStart) {
        holdNextStart = false;
        await new Promise<void>((resolve) => (holdStart = resolve));
      }
      let listener: ((reason: CaptureEndReason) => void) | null = null;
      let ended = false;
      const record: FakeStream = {
        stopped: 0,
        discarded: 0,
        get live() { return !ended && record.discarded === 0 && record.stopped === 0; },
        end(reason) {
          ended = true;
          listener?.(reason);
        },
      };
      streams.push(record);
      const stream: CaptureStream = {
        stop: () => {
          record.stopped += 1;
          if (stopMode === 'fail') return Promise.reject(new Error('synthetic: device lost during stop'));
          if (stopMode === 'hang') return new Promise<Uint8Array>(() => {});
          if (stopMode === 'hold') return new Promise<Uint8Array>((resolve) => (releaseStop = () => resolve(bytes())));
          return Promise.resolve(bytes());
        },
        discard: () => {
          record.discarded += 1;
          if (discardThrows) throw new Error('synthetic discard failure');
        },
        onEnded: (fn) => { listener = fn; },
      };
      return stream;
    },
  };
  return {
    port,
    streams,
    failNext: (error: Error) => { failNext = error; },
    holdNextStart: () => { holdNextStart = true; },
    releaseStart: () => holdStart?.(),
    stopMode: (mode: 'ok' | 'fail' | 'hang' | 'hold') => { stopMode = mode; },
    releaseStop: () => releaseStop?.(),
    discardThrows: () => { discardThrows = true; },
  };
}

type Options = { mic?: ReturnType<typeof fakeMicrophone> | null; capture?: ReturnType<typeof fakeCapture> | null };

function app(options: Options = {}) {
  const mic = options.mic === undefined ? fakeMicrophone('not_requested') : options.mic;
  const capture = options.capture === undefined ? fakeCapture() : options.capture;
  const clock = fakeClock();
  const sent: MainEvent[] = [];
  const submitted: Uint8Array[] = [];
  const transcriberCancels: string[] = [];
  let next = 0;
  const policy = createRoutePolicy([FIXTURE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE]);
  const main = createDesktopMain({
    policy,
    jobs: createJobRunner({ routes: policy.routes, providers: [createFixtureRewriteProvider()] }),
    transcriber: { submit: (job) => submitted.push(job.audio), cancel: (jobId) => transcriberCancels.push(jobId) },
    microphone: mic?.port,
    capture: capture?.port,
    clock,
    chooser: { pickAudio: async () => ({ status: 'picked', bytes: synthWav({ durationMs: 500 }) }) },
    clipboard: { writeText() {} },
    send: (_windowId, _channel, event) => sent.push(event),
    newId: () => `id-${++next}`,
  });
  main.registerWindow(1, TRUSTED_URL);
  main.registerWindow(2, TRUSTED_URL);
  const sessions = new Map<number, SessionOpened>();
  const open = (windowId = 1) => {
    const opened = main.handle(CHANNELS.createSession, caller(windowId), { v: 1 });
    assert.ok(opened.ok);
    sessions.set(windowId, opened.value as SessionOpened);
    return opened.value as SessionOpened;
  };
  open(1);
  const env = (windowId = 1) => {
    const session = sessions.get(windowId);
    assert.ok(session);
    return { v: 1, sessionId: session.sessionId, epoch: session.epoch };
  };
  const start = (windowId = 1) => main.invoke(CHANNELS.startCapture, caller(windowId), env(windowId)) as Promise<IpcResult<StartCaptureResult>>;
  const stop = (captureHandle: string, windowId = 1) =>
    main.invoke(CHANNELS.stopCapture, caller(windowId), { ...env(windowId), captureHandle }) as Promise<IpcResult<ChooseAudioResult>>;
  const discard = (captureHandle: string, windowId = 1) => main.handle(CHANNELS.discardCapture, caller(windowId), { ...env(windowId), captureHandle });
  const status = () => main.handle(CHANNELS.microphoneStatus, caller(), env());
  const recording = async (windowId = 1) => {
    const started = await start(windowId);
    assert.ok(started.ok && started.value.status === 'recording', JSON.stringify(started));
    return started.value.captureHandle;
  };
  return { main, mic, capture, clock, sent, submitted, transcriberCancels, open, env, start, stop, discard, status, recording, sessions };
}

describe('microphone permission', () => {
  test('nothing prompts or records at launch, on capability queries or on status checks', () => {
    const a = app();
    assert.ok(a.sessions.get(1)?.capabilities.actions.includes('capture'));
    assert.deepEqual(a.status(), { ok: true, value: { microphone: 'not_requested' } });
    a.main.handle(CHANNELS.getCapabilities, caller(), a.env());
    assert.equal(a.mic?.prompts, 0);
    assert.equal(a.capture?.streams.length, 0);
  });

  test('the first deliberate Record prompts once, then records with the fixture limit', async () => {
    const a = app();
    assert.deepEqual(await a.start(), { ok: true, value: { status: 'recording', captureHandle: 'id-2', maxDurationMs: FIXTURE_AUDIO.maxDurationMs } });
    assert.equal(a.mic?.prompts, 1);
  });

  test('denial at the prompt blocks capture, and later attempts never prompt again', async () => {
    const a = app({ mic: fakeMicrophone('not_requested', 'denied') });
    assert.deepEqual(await a.start(), { ok: true, value: { status: 'blocked', microphone: 'denied' } });
    assert.deepEqual(await a.start(), { ok: true, value: { status: 'blocked', microphone: 'denied' } });
    assert.equal(a.mic?.prompts, 1, 'no prompt loop');
    assert.equal(a.capture?.streams.length, 0);
  });

  test('denied, restricted, unsupported, unknown and unrecognized states never prompt or record', async () => {
    for (const [state, reported] of [['denied', 'denied'], ['restricted', 'restricted'], ['unsupported', 'unsupported'], ['unknown', 'unknown'], ['not-determined', 'unknown']] as const) {
      const a = app({ mic: fakeMicrophone(state) });
      assert.deepEqual(await a.start(), { ok: true, value: { status: 'blocked', microphone: reported } }, state);
      assert.equal(a.mic?.prompts, 0, state);
      assert.equal(a.capture?.streams.length, 0, state);
      assert.deepEqual(a.status(), { ok: true, value: { microphone: reported } }, `status reports the same safe state for ${state}`);
    }
  });

  test('a failing OS query or prompt is unknown, never granted, and frees the app for a retry', async () => {
    const a = app();
    a.mic?.failStatus();
    assert.deepEqual(a.status(), { ok: true, value: { microphone: 'unknown' } });
    assert.deepEqual(await a.start(), { ok: true, value: { status: 'blocked', microphone: 'unknown' } });
    const b = app();
    b.mic?.failRequest();
    assert.deepEqual(await b.start(), { ok: true, value: { status: 'blocked', microphone: 'unknown' } });
    b.mic?.set('granted');
    const retry = await b.start();
    assert.ok(retry.ok && retry.value.status === 'recording', 'the failed attempt did not leave the app "already recording"');
  });

  test('a permission revoked in the OS blocks the next capture without prompting', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    await a.stop(await a.recording());
    a.mic?.set('denied');
    assert.deepEqual(await a.start(), { ok: true, value: { status: 'blocked', microphone: 'denied' } });
    assert.equal(a.mic?.prompts, 0);
  });

  test('capture needs both a microphone and a capture port', async () => {
    for (const options of [{ mic: null }, { capture: null }] as Options[]) {
      const a = app(options);
      assert.ok(!a.sessions.get(1)?.capabilities.actions.includes('capture'));
      assert.deepEqual(await a.start(), { ok: false, code: 'unsupported' });
    }
    assert.deepEqual(app({ mic: null }).status(), { ok: true, value: { microphone: 'unsupported' } });
  });
});

describe('capture lifecycle', () => {
  test('stop keeps the audio as the session asset, ready to transcribe; the handle is single-use', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    const handle = await a.recording();
    const stopped = await a.stop(handle);
    assert.ok(stopped.ok && stopped.value.status === 'chosen');
    assert.deepEqual(stopped.value.summary, { format: 'wav-pcm16-mono-16k', durationMs: 1000, bytes: 44 + 32_000 });
    assert.deepEqual(await a.stop(handle), { ok: false, code: 'denied' });
    const transcribed = a.main.handle(CHANNELS.transcribe, caller(), { ...a.env(), clientRequestId: 't1', routeKey: 'fixture-transcribe', assetToken: stopped.value.assetToken, sourceRevision: 0 });
    assert.ok(transcribed.ok);
    assert.deepEqual(a.submitted[0], noonWav());
  });

  test('a new recording replaces the asset and stops a transcription of the previous audio', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    const first = await a.stop(await a.recording());
    assert.ok(first.ok && first.value.status === 'chosen');
    const accepted = a.main.handle(CHANNELS.transcribe, caller(), { ...a.env(), clientRequestId: 't1', routeKey: 'fixture-transcribe', assetToken: first.value.assetToken, sourceRevision: 0 });
    assert.ok(accepted.ok);
    await a.stop(await a.recording());
    assert.deepEqual(a.transcriberCancels, [(accepted.value as { jobId: string }).jobId]);
  });

  test('discard drops the recording and keeps no asset', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    const handle = await a.recording();
    assert.deepEqual(a.discard(handle), { ok: true, value: { status: 'discarded' } });
    assert.equal(a.capture?.streams[0]?.discarded, 1);
    assert.equal(a.capture?.streams[0]?.stopped, 0);
    assert.deepEqual(a.discard(handle), { ok: false, code: 'denied' });
    assert.deepEqual(await a.stop(handle), { ok: false, code: 'denied' });
  });

  test('one capture in the whole app, including while a prompt is open or a stop is settling', async () => {
    const mic = fakeMicrophone('not_requested');
    mic.holdPrompt();
    const a = app({ mic });
    a.open(2);
    const first = a.start();
    assert.deepEqual(await a.start(2), { ok: true, value: { status: 'already_recording' } }, 'another window waits too');
    a.open(1);
    assert.deepEqual(await a.start(), { ok: true, value: { status: 'already_recording' } }, 'a replaced session cannot prompt twice');
    assert.equal(mic.prompts, 1);
    mic.answerPrompt();
    assert.deepEqual(await first, { ok: false, code: 'denied' }, 'its session was replaced while prompting');

    const b = app({ mic: fakeMicrophone('granted') });
    b.capture?.stopMode('hold');
    const handle = await b.recording();
    const stopping = b.stop(handle);
    assert.deepEqual(await b.start(), { ok: true, value: { status: 'already_recording' } }, 'no second capture while the stop settles');
    b.capture?.releaseStop();
    assert.ok((await stopping).ok);
    assert.ok((await b.start()).ok);
    assert.equal(b.capture?.streams.filter((s) => s.live).length, 1);
  });

  test('Discard during a settling stop wins: nothing is kept', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    a.capture?.stopMode('hold');
    const handle = await a.recording();
    const stopping = a.stop(handle);
    assert.deepEqual(a.discard(handle), { ok: true, value: { status: 'discarded' } });
    assert.deepEqual(await a.start(), { ok: true, value: { status: 'already_recording' } }, 'still reserved until the stop settles');
    a.capture?.releaseStop();
    assert.deepEqual(await stopping, { ok: false, code: 'cancelled' });
    const after = await a.start();
    assert.ok(after.ok && after.value.status === 'recording', 'released once the stop settled');
    const refused = a.main.handle(CHANNELS.transcribe, caller(), { ...a.env(), clientRequestId: 't1', routeKey: 'fixture-transcribe', assetToken: 'id-3', sourceRevision: 0 });
    assert.deepEqual(refused, { ok: false, code: 'denied' }, 'no asset was created');
  });

  test('a failed or hung stop never leaves the device recording', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    a.capture?.stopMode('fail');
    assert.deepEqual(await a.stop(await a.recording()), { ok: false, code: 'route_unavailable' });
    assert.equal(a.capture?.streams[0]?.discarded, 1);
    a.capture?.stopMode('ok');
    assert.ok((await a.start()).ok, 'the app is free again');

    const b = app({ mic: fakeMicrophone('granted') });
    b.capture?.stopMode('hang');
    const stopping = b.stop(await b.recording());
    await b.clock.advance(5_000);
    assert.deepEqual(await stopping, { ok: false, code: 'route_unavailable' });
    assert.equal(b.capture?.streams[0]?.discarded, 1, 'a stop that never settles is bounded and discarded');
  });

  test('closing or navigating during a settling stop keeps nothing', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    a.capture?.stopMode('hold');
    const stopping = a.stop(await a.recording());
    a.main.windowNavigated(1);
    assert.equal(a.capture?.streams[0]?.discarded, 1);
    a.capture?.releaseStop();
    assert.equal((await stopping).ok, false);
    a.open();
    assert.ok((await a.start()).ok, 'released for the next session');
  });

  test('closing, navigating, replacing or destroying stops the recording', async () => {
    for (const end of ['close', 'navigate', 'replace', 'destroy'] as const) {
      const a = app({ mic: fakeMicrophone('granted') });
      const handle = await a.recording();
      if (end === 'close') a.main.handle(CHANNELS.closeSession, caller(), a.env());
      if (end === 'navigate') a.main.windowNavigated(1);
      if (end === 'replace') a.open();
      if (end === 'destroy') a.main.windowClosed(1);
      assert.equal(a.capture?.streams[0]?.discarded, 1, end);
      if (end !== 'destroy') {
        if (end !== 'replace') a.open();
        assert.deepEqual(await a.stop(handle), { ok: false, code: 'denied' }, end);
        assert.ok((await a.start()).ok, `${end}: the app is free again`);
      }
    }
  });

  test('a throwing discard never blocks closing the session', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    await a.recording();
    a.capture?.discardThrows();
    assert.deepEqual(a.main.handle(CHANNELS.closeSession, caller(), a.env()), { ok: true, value: { closed: true } });
    assert.deepEqual(a.main.handle(CHANNELS.getCapabilities, caller(), a.env()), { ok: false, code: 'denied' }, 'the session did close');
  });

  test('a session closed while the prompt or the device is starting never records', async () => {
    const mic = fakeMicrophone('not_requested');
    mic.holdPrompt();
    const a = app({ mic });
    const prompting = a.start();
    a.main.windowNavigated(1);
    mic.answerPrompt();
    assert.deepEqual(await prompting, { ok: false, code: 'denied' });
    assert.equal(a.capture?.streams.length, 0);

    const capture = fakeCapture();
    capture.holdNextStart();
    const b = app({ mic: fakeMicrophone('granted'), capture });
    const starting = b.start();
    await settle();
    b.main.handle(CHANNELS.closeSession, caller(), b.env());
    capture.releaseStart();
    assert.deepEqual(await starting, { ok: false, code: 'denied' });
    assert.equal(capture.streams[0]?.discarded, 1, 'a stream that started late is stopped at once');
  });

  test('start failures say why: no input, in use, or failed, and free the app', async () => {
    for (const [error, reason] of [[new CaptureUnavailable('no_input'), 'no_input'], [new CaptureUnavailable('in_use'), 'in_use'], [new Error('driver crash'), 'failed']] as const) {
      const a = app({ mic: fakeMicrophone('granted') });
      a.capture?.failNext(error);
      assert.deepEqual(await a.start(), { ok: true, value: { status: 'unavailable', reason } });
      const retry = await a.start();
      assert.ok(retry.ok && retry.value.status === 'recording', `${reason}: the app was released`);
    }
  });
});

describe('recordings that end by themselves', () => {
  test('device loss tells the renderer at once and keeps what was captured until Stop', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    const handle = await a.recording();
    a.capture?.streams[0]?.end('device_lost');
    assert.deepEqual(a.sent.at(-1), { ...a.env(), type: 'capture.ended', captureHandle: handle, reason: 'device_lost' });
    assert.equal(a.capture?.streams[0]?.stopped, 1, 'main collected the audio');
    const stopped = await a.stop(handle);
    assert.ok(stopped.ok && stopped.value.status === 'chosen', 'completed material is preserved');
    assert.equal(a.capture?.streams[0]?.stopped, 1, 'not stopped twice');
  });

  test('a revoked permission mid-recording ends it the same way; Discard drops it', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    const handle = await a.recording();
    a.capture?.streams[0]?.end('revoked');
    assert.equal((a.sent.at(-1) as { reason?: string }).reason, 'revoked');
    assert.deepEqual(a.discard(handle), { ok: true, value: { status: 'discarded' } });
    assert.ok((await a.start()).ok);
  });

  test('main ends a recording that outlives the limit, and an overshoot keeps its first 30 s', async () => {
    const long = () => synthWav({ frames: 30 * 16_000 + 800 });
    const a = app({ mic: fakeMicrophone('granted'), capture: fakeCapture(long) });
    const handle = await a.recording();
    await a.clock.advance(FIXTURE_AUDIO.maxDurationMs + 999);
    assert.equal(a.sent.filter((e) => e.type === 'capture.ended').length, 0, 'the port gets its grace period');
    await a.clock.advance(1);
    assert.deepEqual(a.sent.at(-1), { ...a.env(), type: 'capture.ended', captureHandle: handle, reason: 'max_duration' });
    const stopped = await a.stop(handle);
    assert.ok(stopped.ok && stopped.value.status === 'chosen');
    assert.equal(stopped.value.summary.durationMs, FIXTURE_AUDIO.maxDurationMs, 'trimmed, not lost');
  });

  test('a stop before the limit cancels the backstop', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    await a.stop(await a.recording());
    await a.clock.advance(FIXTURE_AUDIO.maxDurationMs * 2);
    assert.equal(a.sent.filter((e) => e.type === 'capture.ended').length, 0);
    assert.equal(a.clock.pending, 0);
  });

  test('recorded audio in the wrong format is refused like a chosen file', async () => {
    const a = app({ mic: fakeMicrophone('granted'), capture: fakeCapture(() => synthWav({ channels: 2 })) });
    assert.deepEqual(await a.stop(await a.recording()), { ok: false, code: 'unsupported' });
    const b = app({ mic: fakeMicrophone('granted'), capture: fakeCapture(() => 'not bytes' as unknown as Uint8Array) });
    assert.deepEqual(await b.stop(await b.recording()), { ok: false, code: 'invalid_response' });
  });

  test('stale envelopes, foreign handles and untrusted callers start or stop nothing', async () => {
    const a = app({ mic: fakeMicrophone('granted') });
    assert.deepEqual(await a.main.invoke(CHANNELS.startCapture, caller(), { ...a.env(), epoch: 99 }), { ok: false, code: 'denied' });
    assert.deepEqual(await a.main.invoke(CHANNELS.startCapture, { ...caller(), isTopFrame: false }, a.env()), { ok: false, code: 'denied' });
    assert.equal(a.capture?.streams.length, 0);
    const handle = await a.recording();
    a.open(2);
    assert.deepEqual(await a.stop(handle, 2), { ok: false, code: 'denied' }, 'another window cannot stop it');
    assert.deepEqual(await a.stop('someone-elses-handle'), { ok: false, code: 'denied' });
    assert.deepEqual(a.main.handle(CHANNELS.startCapture, caller(), a.env()), { ok: false, code: 'unsupported' }, 'async: invoke only');
    assert.ok((await a.stop(handle)).ok);
  });
});
