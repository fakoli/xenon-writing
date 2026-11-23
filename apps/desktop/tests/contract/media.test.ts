// Synthetic contract tests for Packet E part 1: WAV inspection against the
// fixture limits and the chooseAudio intent. Generated tones only; the
// chooser is an in-memory fake, and no file, microphone or network is used.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CHANNELS } from '../../src/contracts/ipc.ts';
import type { ChooseAudioResult, IpcResult, SessionOpened } from '../../src/contracts/ipc.ts';
import type { FailureCode } from '../../src/contracts/session.ts';
import { createDesktopMain } from '../../src/main/ipc.ts';
import { FIXTURE_AUDIO, inspectWav } from '../../src/main/platform/media.ts';
import type { AudioChooserPort, ChooserResult } from '../../src/main/platform/media.ts';
import { createRoutePolicy } from '../../src/main/routePolicy.ts';
import type { Caller } from '../../src/main/sessionRegistry.ts';
import { noonWav, synthWav } from '../fixtures/wav.ts';

const FRAMES_30S = 30 * 16_000;

function verdictCode(bytes: Uint8Array): FailureCode | 'ok' {
  const verdict = inspectWav(bytes);
  return verdict.ok ? 'ok' : verdict.code;
}

function withRiffSize(bytes: Uint8Array, size: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(4, size, true);
  return copy;
}

describe('WAV inspection', () => {
  test('the generated noon fixture is accepted with a safe summary', () => {
    const verdict = inspectWav(noonWav());
    assert.ok(verdict.ok);
    assert.deepEqual(verdict.summary, { format: 'wav-pcm16-mono-16k', durationMs: 1000, bytes: 44 + 32_000 });
  });

  test('only samples are kept: metadata chunks are dropped and memory is never shared', () => {
    const tagged = synthWav({ extraChunks: [{ id: 'LIST', size: 501 }, { id: 'iXML', size: 64, afterData: true }] });
    const source = Buffer.from(tagged); // what fs reads return; Buffer.slice would share memory
    const verdict = inspectWav(source);
    assert.ok(verdict.ok);
    assert.equal(verdict.canonical.byteLength, 44 + 32_000);
    assert.deepEqual(verdict.canonical, noonWav(), 'exactly the canonical fmt + data layout');
    assert.notEqual(verdict.canonical.buffer, source.buffer);
    source.fill(0xff);
    assert.deepEqual(verdict.canonical, noonWav(), 'changing the input later changes nothing');
    assert.deepEqual(inspectWav(verdict.canonical).ok, true, 'the canonical copy is itself valid');
  });

  test('a view into a larger buffer is read at its own offset', () => {
    const bytes = noonWav();
    const host = new Uint8Array(bytes.byteLength + 7);
    host.set(bytes, 3);
    assert.equal(verdictCode(host.subarray(3, 3 + bytes.byteLength)), 'ok');
  });

  test('any non-empty audio reports at least 1 ms', () => {
    const verdict = inspectWav(synthWav({ frames: 1 }));
    assert.ok(verdict.ok);
    assert.equal(verdict.summary.durationMs, 1);
  });

  test('duration: exactly 30 s passes, one frame more fails', () => {
    assert.equal(verdictCode(synthWav({ frames: FRAMES_30S - 1 })), 'ok');
    assert.equal(verdictCode(synthWav({ frames: FRAMES_30S })), 'ok');
    assert.equal(verdictCode(synthWav({ frames: FRAMES_30S + 1 })), 'invalid_input');
  });

  test('size: max-1, max and max+1 bytes, padded with a skipped chunk', () => {
    const base = synthWav({ frames: 16_000 }).byteLength;
    /** A file of exactly `total` bytes; odd totals use a final odd chunk without its pad byte. */
    const sized = (total: number) => {
      const size = total - base - 8;
      if (size % 2 === 0) return synthWav({ frames: 16_000, extraChunks: [{ id: 'LIST', size }] });
      const padded = synthWav({ frames: 16_000, extraChunks: [{ id: 'LIST', size, afterData: true }] });
      return withRiffSize(padded.slice(0, padded.byteLength - 1), padded.byteLength - 9);
    };
    for (const [total, expected] of [[FIXTURE_AUDIO.maxBytes - 1, 'ok'], [FIXTURE_AUDIO.maxBytes, 'ok'], [FIXTURE_AUDIO.maxBytes + 1, 'invalid_input']] as const) {
      const bytes = sized(total);
      assert.equal(bytes.byteLength, total);
      assert.equal(verdictCode(bytes), expected, `${total} bytes`);
    }
  });

  test('odd-sized unknown chunks are skipped with their pad byte', () => {
    assert.equal(verdictCode(synthWav({ extraChunks: [{ id: 'LIST', size: 7 }, { id: 'junk', size: 0 }] })), 'ok');
  });

  test('a missing pad byte after the final chunk is tolerated', () => {
    const padded = synthWav({ frames: 10, extraChunks: [{ id: 'LIST', size: 7, afterData: true }] });
    const trimmed = withRiffSize(padded.slice(0, padded.byteLength - 1), padded.byteLength - 9);
    assert.equal(verdictCode(padded), 'ok');
    assert.equal(verdictCode(trimmed), 'ok');
  });

  test('a well-formed WAV in another sample format is unsupported', () => {
    const cases = {
      stereo: synthWav({ channels: 2 }),
      '44.1 kHz': synthWav({ sampleRate: 44_100 }),
      '8-bit': synthWav({ bitsPerSample: 8 }),
      float: synthWav({ audioFormat: 3 }),
      extensible: synthWav({ audioFormat: 0xfffe }),
      'channel field only': synthWav({ channelsField: 2 }),
      'block align only': synthWav({ blockAlignField: 4 }),
      'byte rate only': synthWav({ byteRateField: 64_000 }),
    };
    for (const [label, bytes] of Object.entries(cases)) assert.equal(verdictCode(bytes), 'unsupported', label);
  });

  test('corrupted, empty or mislabeled media is invalid input', () => {
    const good = noonWav();
    const cases: Record<string, Uint8Array> = {
      empty: new Uint8Array(0),
      'no audio frames': synthWav({ frames: 0 }),
      'not RIFF (MP3 tag)': new TextEncoder().encode('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000 synthetic'),
      'RIFF size too small': withRiffSize(good, good.byteLength - 9),
      'RIFF size too large': withRiffSize(good, good.byteLength),
      truncated: withRiffSize(good.slice(0, good.byteLength - 100), good.byteLength - 108),
      'trailing bytes': (() => {
        const longer = new Uint8Array(good.byteLength + 3);
        longer.set(good);
        return withRiffSize(longer, longer.byteLength - 8);
      })(),
      'data before fmt': synthWav({ dataFirst: true }),
      'duplicate fmt': synthWav({ extraChunks: [{ id: 'fmt ', size: 16 }] }),
      'partial frame': synthWav({ frames: 10, extraDataBytes: 1 }),
      'zero-size fmt as the last chunk': (() => {
        const bytes = new Uint8Array(20);
        bytes.set(new TextEncoder().encode('RIFF'), 0);
        new DataView(bytes.buffer).setUint32(4, 12, true);
        bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
        return bytes; // fmt size 0: must be refused, not read past the end
      })(),
    };
    for (const [label, bytes] of Object.entries(cases)) assert.equal(verdictCode(bytes), 'invalid_input', label);
  });
});

// A missing guard must fail fast rather than leave a chooser promise hanging.
describe('chooseAudio intent', { timeout: 5_000 }, () => {
  const TRUSTED_URL = 'file:///app/renderer/index.html';
  const caller: Caller = { windowId: 1, frameUrl: TRUSTED_URL, isTopFrame: true };

  /** A chooser the test resolves by hand, counting how often it opened. */
  function fakeChooser() {
    const opened: ((result: ChooserResult) => void)[] = [];
    let failNext = false;
    const port: AudioChooserPort = {
      pickAudio(options) {
        assert.equal(options.maxBytes, FIXTURE_AUDIO.maxBytes);
        // The dialog must be parented to the calling window, or the binding finds none and cancels.
        assert.equal(options.windowId, caller.windowId);
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('synthetic dialog failure'));
        }
        return new Promise((resolve) => opened.push(resolve));
      },
    };
    return {
      port,
      opened,
      answer: (result: ChooserResult) => opened.shift()?.(result),
      failNext: () => {
        failNext = true;
      },
    };
  }

  function app(withChooser = true) {
    const chooser = fakeChooser();
    let next = 0;
    const main = createDesktopMain({
      policy: createRoutePolicy(),
      jobs: { submit() {}, cancel() {} },
      clipboard: { writeText() {} },
      send() {},
      newId: () => `id-${++next}`,
      chooser: withChooser ? chooser.port : undefined,
    });
    main.registerWindow(1, TRUSTED_URL);
    const opened = main.handle(CHANNELS.createSession, caller, { v: 1 });
    assert.ok(opened.ok);
    const session = opened.value as SessionOpened;
    const envelope = { v: 1, sessionId: session.sessionId, epoch: session.epoch };
    const choose = (who: Caller = caller) => main.invoke(CHANNELS.chooseAudio, who, envelope) as Promise<IpcResult<ChooseAudioResult>>;
    return { main, chooser, session, envelope, choose };
  }

  test('opening a session never opens the chooser; the capability is offered', () => {
    const a = app();
    assert.ok(a.session.capabilities.actions.includes('chooseAudio'));
    assert.equal(a.chooser.opened.length, 0);
    assert.equal(a.main.handle(CHANNELS.getCapabilities, caller, a.envelope).ok, true);
    assert.equal(a.chooser.opened.length, 0);
  });

  test('closing the chooser changes nothing', async () => {
    const a = app();
    const pending = a.choose();
    a.chooser.answer({ status: 'cancelled' });
    assert.deepEqual(await pending, { ok: true, value: { status: 'cancelled' } });
  });

  test('a valid file becomes an opaque token with a safe summary, never a path', async () => {
    const a = app();
    const pending = a.choose();
    const bytes = noonWav();
    a.chooser.answer({ status: 'picked', bytes });
    const result = await pending;
    assert.deepEqual(result, {
      ok: true,
      value: { status: 'chosen', assetToken: 'id-2', summary: { format: 'wav-pcm16-mono-16k', durationMs: 1000, bytes: bytes.byteLength } },
    });
    assert.ok(JSON.stringify(result).length < 200, 'no sample data crosses the bridge');
  });

  test('a mismatched or oversized file is refused, and the user can choose another', async () => {
    const a = app();
    for (const [bytes, expected] of [[synthWav({ channels: 2 }), 'unsupported'], [synthWav({ frames: FRAMES_30S + 1 }), 'invalid_input']] as const) {
      const pending = a.choose();
      a.chooser.answer({ status: 'picked', bytes });
      assert.deepEqual(await pending, { ok: false, code: expected });
    }
    const retry = a.choose();
    a.chooser.answer({ status: 'picked', bytes: noonWav() });
    assert.equal((await retry).ok, true);
  });

  test('only one chooser per window at a time, even across new sessions', async () => {
    const a = app();
    const first = a.choose();
    const second = await Promise.race([a.choose(), new Promise((resolve) => setTimeout(() => resolve('still open'), 50))]);
    assert.deepEqual(second, { ok: true, value: { status: 'already_open' } });
    // A renderer that opens a new session still cannot stack a second dialog.
    const reopened = a.main.handle(CHANNELS.createSession, caller, { v: 1 });
    assert.ok(reopened.ok);
    const fresh = reopened.value as SessionOpened;
    const third = await a.main.invoke(CHANNELS.chooseAudio, caller, { v: 1, sessionId: fresh.sessionId, epoch: fresh.epoch });
    assert.deepEqual(third, { ok: true, value: { status: 'already_open' } });
    assert.equal(a.chooser.opened.length, 1);
    a.chooser.answer({ status: 'picked', bytes: noonWav() });
    assert.deepEqual(await first, { ok: false, code: 'denied' }, 'the replaced session gets nothing');
    const next = a.main.invoke(CHANNELS.chooseAudio, caller, { v: 1, sessionId: fresh.sessionId, epoch: fresh.epoch });
    assert.equal(a.chooser.opened.length, 1, 'a new chooser opens once the first closed');
    a.chooser.answer({ status: 'cancelled' });
    await next;
  });

  test('after a chooser closes, the next one can open', async () => {
    const a = app();
    const first = a.choose();
    assert.deepEqual(await a.choose(), { ok: true, value: { status: 'already_open' } });
    assert.equal(a.chooser.opened.length, 1);
    a.chooser.answer({ status: 'cancelled' });
    assert.equal((await first).ok, true);
    const again = a.choose();
    assert.equal(a.chooser.opened.length, 1, 'a new chooser opens after the first closes');
    a.chooser.answer({ status: 'cancelled' });
    await again;
  });

  test('a session closed while the chooser is open gets nothing', async () => {
    const a = app();
    const pending = a.choose();
    a.main.handle(CHANNELS.closeSession, caller, a.envelope);
    a.chooser.answer({ status: 'picked', bytes: noonWav() });
    assert.deepEqual(await pending, { ok: false, code: 'denied' });
  });

  test('a chooser failure or malformed answer is a safe code', async () => {
    const a = app();
    a.chooser.failNext();
    assert.deepEqual(await a.choose(), { ok: false, code: 'route_unavailable' }, 'a failed dialog can be retried');
    const pending = a.choose();
    a.chooser.answer({ status: 'picked', bytes: 'not bytes' } as unknown as ChooserResult);
    assert.deepEqual(await pending, { ok: false, code: 'invalid_response' });
  });

  test('stale or foreign envelopes never open the chooser', async () => {
    const a = app();
    assert.deepEqual(await a.main.invoke(CHANNELS.chooseAudio, caller, { ...a.envelope, epoch: a.envelope.epoch + 1 }), { ok: false, code: 'denied' });
    assert.deepEqual(await a.main.invoke(CHANNELS.chooseAudio, caller, { ...a.envelope, sessionId: 'someone-else' }), { ok: false, code: 'denied' });
    assert.deepEqual(await a.main.invoke(CHANNELS.chooseAudio, caller, { ...a.envelope, path: '/tmp/x.wav' }), { ok: false, code: 'invalid_input' });
    assert.equal(a.chooser.opened.length, 0);
  });

  test('untrusted callers never open the chooser', async () => {
    const a = app();
    assert.deepEqual(await a.choose({ ...caller, isTopFrame: false }), { ok: false, code: 'denied' });
    assert.deepEqual(await a.choose({ ...caller, frameUrl: 'https://example.invalid/' }), { ok: false, code: 'denied' });
    assert.equal(a.chooser.opened.length, 0);
  });

  test('without a platform chooser the intent is not offered', async () => {
    const a = app(false);
    assert.ok(!a.session.capabilities.actions.includes('chooseAudio'));
    assert.deepEqual(await a.choose(), { ok: false, code: 'unsupported' });
  });

  test('the synchronous core refuses the async intent; invoke serves the rest', async () => {
    const a = app();
    assert.deepEqual(a.main.handle(CHANNELS.chooseAudio, caller, a.envelope), { ok: false, code: 'unsupported' });
    assert.equal(a.chooser.opened.length, 0);
    assert.equal((await a.main.invoke(CHANNELS.getCapabilities, caller, a.envelope)).ok, true);
    assert.deepEqual(await a.main.invoke('xenon:v1:shell.open', caller, a.envelope), { ok: false, code: 'unsupported' });
  });
});
