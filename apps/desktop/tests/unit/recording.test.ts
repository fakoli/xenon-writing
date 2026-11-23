// Packet B part 3: the recorder's UI state (interaction and platform designs).
// Pure transitions only; no microphone, device or DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRecorder, elapsedMs, recorderBusy, reduceRecorder } from '../../src/renderer/recording.ts';
import type { RecorderAction, RecorderState } from '../../src/renderer/recording.ts';
import type { MicrophoneState } from '../../src/contracts/ipc.ts';

function run(state: RecorderState, ...actions: RecorderAction[]): RecorderState {
  for (const action of actions) state = reduceRecorder(Object.freeze(state), action);
  return state;
}

const RECORDING = { ok: true, value: { status: 'recording', captureHandle: 'c1', maxDurationMs: 30_000 } } as const;
/** Record, then the fresh permission read it triggers. */
const record = (microphone: MicrophoneState | null = 'granted'): RecorderAction[] => [
  { type: 'record' },
  { type: 'mic.checked', microphone },
];

test('Record always re-reads the permission state before anything else', () => {
  for (const remembered of [null, 'granted', 'not_requested'] as const) {
    const checking = run(createRecorder(remembered), { type: 'record' });
    assert.equal(checking.phase, 'checking', String(remembered));
    assert.equal(recorderBusy(checking), false);
  }
});

test('the explanation comes first unless the fresh read says permission is decided', () => {
  // Never asked, unreadable or a failed read: main may still prompt, so explain.
  for (const microphone of ['not_requested', 'unknown', null] as const) {
    assert.equal(run(createRecorder('granted'), ...record(microphone)).phase, 'explaining', String(microphone));
  }
  // A stale remembered "granted" never skips the explanation when the fresh read says otherwise.
  assert.equal(run(createRecorder('granted'), ...record('not_requested')).microphone, 'not_requested');
});

test('the first Record explains before the OS prompt; Not now sends nothing', () => {
  const fresh = createRecorder('not_requested');
  const explaining = run(fresh, ...record('not_requested'));
  assert.equal(explaining.phase, 'explaining');
  assert.equal(run(explaining, { type: 'explain.dismiss' }).phase, 'idle');
  assert.equal(run(explaining, { type: 'explain.continue' }).phase, 'starting');
});

test('with permission already decided, Record starts at once and never explains again', () => {
  for (const microphone of ['granted', 'denied', 'restricted', 'unsupported'] as const) {
    const starting = run(createRecorder(null), ...record(microphone));
    assert.equal(starting.phase, 'starting', microphone);
    assert.equal(recorderBusy(starting), false, 'a start waiting for the OS does not block Import');
  }
});

test('a started recording keeps its handle, limit and start time', () => {
  const s = run(createRecorder('not_requested'), ...record('not_requested'), { type: 'explain.continue' }, { type: 'start.result', result: RECORDING, now: 1_000 });
  assert.equal(s.phase, 'recording');
  assert.equal(s.handle, 'c1');
  assert.equal(s.microphone, 'granted');
  assert.equal(elapsedMs(s, 4_000), 3_000);
  assert.equal(elapsedMs(s, 99_000), 30_000, 'the timer stops at the limit');
  assert.equal(recorderBusy(s), true);
});

test('blocked, unavailable and busy starts return to idle with a reason', () => {
  const start = (result: Parameters<typeof reduceRecorder>[1] & { type: 'start.result' }) => run(createRecorder('granted'), ...record(), result);
  const denied = start({ type: 'start.result', result: { ok: true, value: { status: 'blocked', microphone: 'denied' } }, now: 0 });
  assert.deepEqual([denied.phase, denied.microphone, denied.note], ['idle', 'denied', { kind: 'blocked', microphone: 'denied' }]);
  const inUse = start({ type: 'start.result', result: { ok: true, value: { status: 'unavailable', reason: 'in_use' } }, now: 0 });
  assert.deepEqual([inUse.phase, inUse.note], ['idle', { kind: 'unavailable', reason: 'in_use' }]);
  const busy = start({ type: 'start.result', result: { ok: true, value: { status: 'already_recording' } }, now: 0 });
  assert.deepEqual(busy.note, { kind: 'busy' });
  const refused = start({ type: 'start.result', result: { ok: false, code: 'denied' }, now: 0 });
  assert.deepEqual([refused.phase, refused.note], ['idle', { kind: 'failed', code: 'denied' }]);
  assert.equal(recorderBusy(refused), false);
});

test('a recheck that finds access possible clears the refusal; one that does not keeps it', () => {
  const blocked = run(createRecorder('granted'), ...record(), { type: 'start.result', result: { ok: true, value: { status: 'blocked', microphone: 'denied' } }, now: 0 });
  assert.notEqual(run(blocked, { type: 'mic.status', microphone: 'restricted' }).note, null);
  assert.equal(run(blocked, { type: 'mic.status', microphone: 'granted' }).note, null);
});

test('an ending reported by main holds the audio until Keep or Discard; other handles are ignored', () => {
  const recording = run(createRecorder('granted'), ...record(), { type: 'start.result', result: RECORDING, now: 0 });
  assert.equal(run(recording, { type: 'ended', handle: 'other', reason: 'max_duration', now: 5 }).phase, 'recording');
  const ended = run(recording, { type: 'ended', handle: 'c1', reason: 'device_lost', now: 5_000 });
  assert.deepEqual([ended.phase, ended.endReason], ['ended', 'device_lost']);
  assert.equal(elapsedMs(ended, 60_000), 5_000, 'the timer freezes when the recording ends');
  assert.equal(run(ended, { type: 'stop' }).phase, 'stopping');
  assert.equal(run(ended, { type: 'discard' }).phase, 'discarding');
});

test('an ending after Stop was pressed changes nothing', () => {
  const stopping = run(createRecorder('granted'), ...record(), { type: 'start.result', result: RECORDING, now: 0 }, { type: 'stop' });
  assert.equal(run(stopping, { type: 'ended', handle: 'c1', reason: 'max_duration', now: 1 }).phase, 'stopping');
});

test('Stop keeps, a Discard that won the race reports discarded, a failed stop keeps nothing', () => {
  const stopping = run(createRecorder('granted'), ...record(), { type: 'start.result', result: RECORDING, now: 0 }, { type: 'stop' });
  const chosen = { ok: true, value: { status: 'chosen', assetToken: 'a2', summary: { format: 'wav-pcm16-mono-16k', durationMs: 4_000, bytes: 128_044 } } } as const;
  // Without transcription on offer, Stop simply keeps the recording.
  const kept = run(stopping, { type: 'stop.result', result: chosen, ask: false });
  assert.deepEqual([kept.phase, kept.handle, kept.note, kept.keptAsset], ['idle', null, { kind: 'kept' }, null]);
  assert.deepEqual(run(stopping, { type: 'stop.result', result: { ok: false, code: 'cancelled' }, ask: true }).note, { kind: 'discarded' });
  assert.deepEqual(run(stopping, { type: 'stop.result', result: { ok: false, code: 'route_unavailable' }, ask: true }).note, { kind: 'failed', code: 'route_unavailable' });
});

test('Discard keeps nothing either way', () => {
  const discarding = run(createRecorder('granted'), ...record(), { type: 'start.result', result: RECORDING, now: 0 }, { type: 'discard' });
  assert.deepEqual(run(discarding, { type: 'discard.result', result: { ok: true, value: { status: 'discarded' } } }).note, { kind: 'discarded' });
  const gone = run(discarding, { type: 'discard.result', result: { ok: false, code: 'denied' } });
  assert.deepEqual([gone.phase, gone.note], ['idle', { kind: 'failed', code: 'denied' }]);
});

test('results for a phase that has moved on are ignored', () => {
  const idle = createRecorder('granted');
  assert.equal(run(idle, { type: 'start.result', result: RECORDING, now: 0 }), idle);
  assert.equal(run(idle, { type: 'stop.result', result: { ok: false, code: 'denied' }, ask: true }), idle);
  assert.equal(run(idle, { type: 'discard.result', result: { ok: true, value: { status: 'discarded' } } }), idle);
  assert.equal(run(idle, { type: 'stop' }), idle);
  // Record cannot start a second capture while one is on screen.
  const recording = run(idle, ...record(), { type: 'start.result', result: RECORDING, now: 0 });
  assert.equal(run(recording, { type: 'record' }), recording);
});

test('Stop never transcribes by itself: a kept recording waits for a second click', () => {
  const chosen = { ok: true, value: { status: 'chosen', assetToken: 'a2', summary: { format: 'wav-pcm16-mono-16k', durationMs: 4_000, bytes: 128_044 } } } as const;
  const stopping = run(createRecorder('granted'), ...record(), { type: 'start.result', result: RECORDING, now: 0 }, { type: 'stop' });
  const confirming = run(stopping, { type: 'stop.result', result: chosen, ask: true });
  assert.deepEqual([confirming.phase, confirming.keptAsset, confirming.handle], ['confirming', 'a2', null]);
  assert.equal(recorderBusy(confirming), false, 'Import and Transcribe stay usable while it waits');
  assert.deepEqual(run(confirming, { type: 'confirm.transcribe' }), { ...confirming, phase: 'idle', keptAsset: null, note: { kind: 'kept' } });
  const waiting = run(confirming, { type: 'confirm.dismiss' });
  assert.deepEqual([waiting.phase, waiting.note, waiting.keptAsset], ['idle', { kind: 'waiting' }, 'a2']);
  // Once that recording is sent or replaced, "nothing was sent" is cleared.
  const cleared = run(waiting, { type: 'note.clear' });
  assert.deepEqual([cleared.note, cleared.keptAsset], [null, null]);
  assert.equal(run(confirming, { type: 'note.clear' }), confirming, 'only a waiting note is cleared');
  const dropped = run(confirming, { type: 'confirm.drop' });
  assert.deepEqual([dropped.phase, dropped.keptAsset, dropped.note], ['idle', null, null]);
  // Recording again drops the confirmation; confirm actions outside it do nothing.
  const again = run(confirming, { type: 'record' });
  assert.deepEqual([again.phase, again.keptAsset], ['checking', null]);
  const idle = createRecorder('granted');
  for (const type of ['confirm.transcribe', 'confirm.dismiss', 'confirm.drop'] as const) assert.equal(run(idle, { type }), idle);
});
