// Packet E, macOS capture: the recording rules with a fake input and clock.
// Synthetic samples only; no microphone, device or Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CaptureUnavailable } from '../../src/main/platform/capture.ts';
import type { CaptureEndReason } from '../../src/contracts/ipc.ts';
import { FLUSH_MS, LIMIT_GRACE_MS, createCapturePort, pcm16Wav } from '../../src/main/platform/captureCore.ts';
import type { CaptureDriver, CaptureListener } from '../../src/main/platform/captureCore.ts';
import { inspectWav } from '../../src/main/platform/media.ts';
import { fakeClock } from '../fixtures/clock.ts';

/** A fake input the test feeds by hand. */
function fakeDriver(options: { fail?: Error; flushTail?: Int16Array } = {}) {
  const calls = { opened: 0, flushed: [] as number[], closed: 0 };
  let listener: CaptureListener | null = null;
  const driver: CaptureDriver = {
    async open(l) {
      calls.opened++;
      if (options.fail) throw options.fail;
      listener = l;
    },
    async flush(ms) {
      calls.flushed.push(ms);
      if (options.flushTail) listener?.chunk(options.flushTail);
    },
    close() {
      calls.closed++;
    },
  };
  return { driver, calls, feed: (samples: unknown) => listener?.chunk(samples as Int16Array), end: (reason: string) => listener?.ended(reason as CaptureEndReason) };
}

const tone = (n: number) => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 8) * 8000));

test('kept samples become a WAV that intake accepts, with the tail flushed on Stop', async () => {
  const input = fakeDriver({ flushTail: tone(1_600) });
  const stream = await createCapturePort(() => input.driver, fakeClock()).start({ maxDurationMs: 30_000 });
  input.feed(tone(16_000));
  const bytes = await stream.stop();
  assert.deepEqual(input.calls.flushed, [FLUSH_MS]);
  assert.ok(input.calls.closed >= 1, 'the input is released');
  const verdict = inspectWav(bytes);
  assert.ok(verdict.ok);
  assert.equal(verdict.summary.durationMs, 1_100); // one second plus the flushed tenth
});

test('samples past the limit are dropped and the recording ends by itself', async () => {
  const input = fakeDriver();
  const stream = await createCapturePort(() => input.driver, fakeClock()).start({ maxDurationMs: 1_000 });
  input.feed(tone(12_000));
  input.feed(tone(12_000)); // crosses the 16 000-sample limit
  input.feed(tone(5_000)); // after the end: ignored
  const ended: string[] = [];
  stream.onEnded((reason) => ended.push(reason)); // registered after the end: still told
  assert.deepEqual(ended, ['max_duration']);
  const verdict = inspectWav(await stream.stop());
  assert.ok(verdict.ok);
  assert.equal(verdict.summary.durationMs, 1_000);
  assert.deepEqual(input.calls.flushed, [], 'an ended recording has nothing left to flush');
});

test('the time limit applies even when no samples arrive, counted from when the input opened', async () => {
  const clock = fakeClock();
  const input = fakeDriver();
  let opened!: () => void;
  input.driver.open = () => new Promise<void>((resolve) => (opened = resolve)); // a slow device start
  const starting = createCapturePort(() => input.driver, clock).start({ maxDurationMs: 2_000 });
  await clock.advance(5_000); // opening time does not count against the limit
  opened();
  const stream = await starting;
  const ended: string[] = [];
  stream.onEnded((reason) => ended.push(reason));
  await clock.advance(2_000 + LIMIT_GRACE_MS - 1);
  assert.deepEqual(ended, []);
  await clock.advance(1);
  assert.deepEqual(ended, ['max_duration']);
  assert.equal(input.calls.closed, 1);
});

test('a full-length recording keeps exactly the limit, ended by the sample count before the timer', async () => {
  const clock = fakeClock();
  const input = fakeDriver();
  const stream = await createCapturePort(() => input.driver, clock).start({ maxDurationMs: 30_000 });
  await clock.advance(300); // pipeline delay before the first samples
  for (let i = 0; i < 300; i++) input.feed(tone(1_600)); // 30 s of samples
  const ended: string[] = [];
  stream.onEnded((reason) => ended.push(reason));
  assert.deepEqual(ended, ['max_duration']);
  const verdict = inspectWav(await stream.stop());
  assert.ok(verdict.ok);
  assert.equal(verdict.summary.durationMs, 30_000);
  assert.equal(clock.pending, 0);
});

test('a lost device or revoked permission ends the recording once, keeping what was captured', async () => {
  for (const [reported, expected] of [['revoked', 'revoked'], ['device_lost', 'device_lost'], ['something else', 'device_lost']]) {
    const input = fakeDriver();
    const stream = await createCapturePort(() => input.driver, fakeClock()).start({ maxDurationMs: 30_000 });
    const ended: string[] = [];
    stream.onEnded((reason) => ended.push(reason));
    input.feed(tone(8_000));
    input.end(reported as string);
    input.end('revoked'); // only the first ending counts
    assert.deepEqual(ended, [expected]);
    const verdict = inspectWav(await stream.stop());
    assert.ok(verdict.ok);
    assert.equal(verdict.summary.durationMs, 500);
  }
});

test('Discard keeps nothing, is safe to repeat, and a closed stream cannot be stopped', async () => {
  const input = fakeDriver();
  const stream = await createCapturePort(() => input.driver, fakeClock()).start({ maxDurationMs: 30_000 });
  input.feed(tone(8_000));
  stream.discard();
  stream.discard();
  input.feed(tone(8_000));
  assert.ok(input.calls.closed >= 1);
  await assert.rejects(stream.stop(), /closed/);
});

test('a refused input rejects the start, releases the input and leaves no timer', async () => {
  const clock = fakeClock();
  const input = fakeDriver({ fail: new CaptureUnavailable('in_use') });
  await assert.rejects(createCapturePort(() => input.driver, clock).start({ maxDurationMs: 30_000 }), (error) => error instanceof CaptureUnavailable && error.reason === 'in_use');
  assert.equal(input.calls.closed, 1);
  assert.equal(clock.pending, 0);
});

test('anything but 16-bit sample arrays is ignored', async () => {
  const input = fakeDriver();
  const stream = await createCapturePort(() => input.driver, fakeClock()).start({ maxDurationMs: 30_000 });
  input.feed(new Float32Array(16_000));
  input.feed([1, 2, 3]);
  input.feed(tone(1_600));
  const verdict = inspectWav(await stream.stop());
  assert.ok(verdict.ok);
  assert.equal(verdict.summary.durationMs, 100);
});

test('the WAV header is canonical 16 kHz mono 16-bit PCM', () => {
  const bytes = pcm16Wav(Int16Array.of(1, -1, 32767, -32768));
  const view = new DataView(bytes.buffer);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)], [1, -1, 32767, -32768]);
});
