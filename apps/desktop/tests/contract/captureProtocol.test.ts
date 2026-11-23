// Packet E, macOS capture: the pure rules main applies to macOS permission
// states and to messages from the hidden capture window. No Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_CHUNK_BYTES, chunkSamples, createMacMicrophone, macMicrophoneState, unavailableReason } from '../../src/main/platform/captureProtocol.ts';

test("macOS's microphone states map to the contract's; anything else is unknown, never granted", () => {
  assert.equal(macMicrophoneState('not-determined'), 'not_requested');
  assert.equal(macMicrophoneState('granted'), 'granted');
  assert.equal(macMicrophoneState('denied'), 'denied');
  assert.equal(macMicrophoneState('restricted'), 'restricted');
  for (const odd of ['unknown', 'authorized', 'Granted', '', undefined, null, 1]) assert.equal(macMicrophoneState(odd), 'unknown', String(odd));
});

test('status never prompts; request prompts once and re-reads the answer from macOS', async () => {
  let state = 'not-determined';
  const calls = { status: 0, ask: 0 };
  const microphone = createMacMicrophone({
    getMediaAccessStatus: () => (calls.status++, state),
    askForMediaAccess: async () => {
      calls.ask++;
      state = 'denied';
      return true; // a claimed grant the OS state does not back
    },
  });
  assert.equal(microphone.status(), 'not_requested');
  assert.equal(calls.ask, 0);
  assert.equal(await microphone.request(), 'denied');
  assert.equal(calls.ask, 1);
});

test('chunks from the page are bounded, even-length ArrayBuffers, copied out', () => {
  const buffer = new Int16Array([1, -2, 3]).buffer;
  const samples = chunkSamples(buffer);
  assert.deepEqual(Array.from(samples ?? []), [1, -2, 3]);
  new Int16Array(buffer)[0] = 99;
  assert.equal(samples?.[0], 1, 'a copy, not a view of the sender buffer');
  for (const bad of [new ArrayBuffer(0), new ArrayBuffer(3), new ArrayBuffer(MAX_CHUNK_BYTES + 2), new Int16Array(4), [1, 2], 'pcm', null]) {
    assert.equal(chunkSamples(bad), null);
  }
});

test('input failures say missing, busy or failed', () => {
  assert.equal(unavailableReason('NotFoundError'), 'no_input');
  assert.equal(unavailableReason('OverconstrainedError'), 'no_input');
  assert.equal(unavailableReason('NotReadableError'), 'in_use');
  assert.equal(unavailableReason('AbortError'), 'in_use');
  for (const other of ['NotAllowedError', 'SecurityError', 'Error', undefined]) assert.equal(unavailableReason(other), 'failed');
});
