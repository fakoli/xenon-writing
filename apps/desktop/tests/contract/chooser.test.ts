// Packet B part 2: the audio chooser's rules with a fake platform. No dialog,
// file or Electron; the bytes are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChooser } from '../../src/main/platform/chooser.ts';
import type { ChooserPlatform } from '../../src/main/platform/chooser.ts';
import { fakeClock } from '../fixtures/clock.ts';

function platform(choice: Awaited<ReturnType<ChooserPlatform['showOpenDialog']>>, bytes = new Uint8Array([1, 2, 3])) {
  const calls: { dialogs: number[]; reads: [string, number][] } = { dialogs: [], reads: [] };
  const fake: ChooserPlatform = {
    async showOpenDialog(windowId) {
      calls.dialogs.push(windowId);
      return choice;
    },
    async readHead(file, limit) {
      calls.reads.push([file, limit]);
      return bytes;
    },
  };
  return { fake, calls };
}

test('one picked file is read up to one byte past the limit, over the caller window', async () => {
  const { fake, calls } = platform({ canceled: false, filePaths: ['/fictional/a.wav'] });
  const result = await createChooser(fake).pickAudio({ maxBytes: 100, windowId: 7 });
  assert.deepEqual(result, { status: 'picked', bytes: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(calls.dialogs, [7]);
  assert.deepEqual(calls.reads, [['/fictional/a.wav', 101]]);
  assert.equal(JSON.stringify(result).includes('fictional'), false, 'no path in the result');
});

for (const [name, choice] of [
  ['closed dialog', { canceled: true, filePaths: [] }],
  ['window gone', null],
  ['no file', { canceled: false, filePaths: [] }],
  ['several files', { canceled: false, filePaths: ['/fictional/a.wav', '/fictional/b.wav'] }],
] as const) {
  test(`${name} is a cancel and reads nothing`, async () => {
    const { fake, calls } = platform(choice);
    assert.deepEqual(await createChooser(fake).pickAudio({ maxBytes: 100, windowId: 7 }), { status: 'cancelled' });
    assert.deepEqual(calls.reads, []);
  });
}

test('a failed read rejects, so main reports a safe code', async () => {
  const fake: ChooserPlatform = {
    showOpenDialog: async () => ({ canceled: false, filePaths: ['/fictional/dir'] }),
    readHead: async () => {
      throw new Error('not a regular file');
    },
  };
  await assert.rejects(createChooser(fake).pickAudio({ maxBytes: 100, windowId: 7 }));
});

test('a read that hangs fails after the timeout, so the chooser is released', async () => {
  const clock = fakeClock();
  const fake: ChooserPlatform = {
    showOpenDialog: async () => ({ canceled: false, filePaths: ['/fictional/slow.wav'] }),
    readHead: () => new Promise(() => {}), // a hung mount or device never answers
  };
  let settled = false;
  const pick = createChooser(fake, { clock, readTimeoutMs: 1_000 })
    .pickAudio({ maxBytes: 100, windowId: 7 })
    .finally(() => (settled = true));
  const outcome = assert.rejects(pick, /timed out/);
  await clock.advance(999);
  assert.equal(settled, false);
  await clock.advance(1);
  await outcome;
  assert.equal(clock.pending, 0);
});

test('a read that finishes in time clears its timer', async () => {
  const clock = fakeClock();
  const { fake } = platform({ canceled: false, filePaths: ['/fictional/a.wav'] });
  await createChooser(fake, { clock, readTimeoutMs: 1_000 }).pickAudio({ maxBytes: 100, windowId: 7 });
  assert.equal(clock.pending, 0);
});
