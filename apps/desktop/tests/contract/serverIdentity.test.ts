// The local base rewrite route's server identity proof: the pure functions and the identity
// file reader. Temporary files only; no service, model or network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { readIdentitySecret } from '../../src/main/providers/identityFile.ts';
import {
  IDENTITY_SCHEMA,
  IdentityUnavailable,
  base64url,
  computeProof,
  decodeBase64urlExact,
  endpoint,
  newNonce,
  parseIdentityRecord,
  proofMatches,
  proofMessage,
} from '../../src/main/providers/serverIdentity.ts';

const MODEL = 'mlx-community/Qwen3-4B-Instruct-2507-4bit';
const EXPECTED = { model: MODEL, port: 30113 };
const bytes = (from: number) => Uint8Array.from({ length: 32 }, (_, i) => from + i);

// Shared with the service's own tests, outside this repository: the same
// inputs give the same proof.
const VECTOR = {
  secret: bytes(0),
  nonce: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  server: '127.0.0.1:30113',
  client: '127.0.0.1:54321',
  model: MODEL,
  proof: 'RwvVGTdZkkOB9tuM0pyNYq3R8rPTWWE4MwN6zU9ndiQ',
};

function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: IDENTITY_SCHEMA,
    label: 'com.example.model-server',
    model: MODEL,
    port: 30113,
    pid: 4242,
    started_at: '2026-11-27T09:00:00Z',
    secret: base64url(bytes(100)),
    ...overrides,
  });
}

describe('server identity proof', () => {
  test('the shared vector gives the service its proof', () => {
    const { secret, nonce, server, client, model, proof } = VECTOR;
    assert.equal(nonce, base64url(bytes(32)));
    assert.equal(computeProof(secret, nonce, server, client, model), proof);
  });

  test('the message is exact, and every input changes the proof', () => {
    const { secret, nonce, server, client, model, proof } = VECTOR;
    assert.equal(
      new TextDecoder().decode(proofMessage(nonce, server, client, model)),
      `loopback-model-identity/v1\nnonce=${nonce}\nserver=127.0.0.1:30113\nclient=127.0.0.1:54321\nmodel=${MODEL}`,
    );
    const changed: [Uint8Array, string, string, string, string][] = [
      [bytes(1), nonce, server, client, model],
      [secret, base64url(bytes(33)), server, client, model],
      [secret, nonce, '127.0.0.1:30114', client, model],
      [secret, nonce, server, '127.0.0.1:54322', model],
      [secret, nonce, server, client, 'mlx-community/other'],
      [secret, nonce, client, server, model],
    ];
    for (const args of changed) assert.notEqual(computeProof(...args), proof);
  });

  test('a proof matches only the exact expected value', () => {
    const { proof } = VECTOR;
    assert.equal(proofMatches(proof, proof), true);
    const other = base64url(bytes(7));
    for (const received of [other, proof + 'A', proof.slice(1), `${proof}=`, '', undefined, [proof, proof], 42]) {
      assert.equal(proofMatches(proof, received), false, JSON.stringify(received));
    }
  });

  test('base64url is canonical and exactly sized', () => {
    assert.deepEqual(decodeBase64urlExact(VECTOR.nonce, 32), bytes(32));
    for (const bad of ['', `${VECTOR.nonce}=`, VECTOR.nonce.slice(0, -1), `${VECTOR.nonce}A`, VECTOR.nonce.replace('I', '+'), base64url(bytes(0).subarray(0, 31)), '*'.repeat(43), 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9']) {
      assert.equal(decodeBase64urlExact(bad, 32), undefined, bad);
    }
  });

  test('nonces are fresh 32-byte values; endpoints bracket IPv6', () => {
    const a = newNonce();
    assert.equal(decodeBase64urlExact(a, 32)?.byteLength, 32);
    assert.notEqual(a, newNonce());
    assert.equal(endpoint('127.0.0.1', 30113), '127.0.0.1:30113');
    assert.equal(endpoint('::1', 30113), '[::1]:30113');
  });

  test('the record must name this schema, model and port, with a 32-byte secret', () => {
    assert.deepEqual(parseIdentityRecord(record(), EXPECTED), bytes(100));
    for (const [text, why] of [
      ['not json', 'not JSON'],
      ['[]', 'array'],
      [record({ schema: 'loopback-model-identity/v2' }), 'schema'],
      [record({ model: 'mlx-community/other' }), 'model'],
      [record({ port: 30114 }), 'port'],
      [record({ port: '30113' }), 'port as text'],
      [record({ secret: base64url(bytes(0).subarray(0, 16)) }), 'short secret'],
      [record({ secret: 42 }), 'secret type'],
      [record({ secret: undefined }), 'no secret'],
    ] as const) {
      assert.throws(() => parseIdentityRecord(text, EXPECTED), IdentityUnavailable, why);
    }
  });
});

describe('the identity file', () => {
  const root = mkdtempSync(join(tmpdir(), 'xenon-identity-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  /** A fresh private directory holding one identity file. */
  function place(text = record(), { dirMode = 0o700, fileMode = 0o600 } = {}) {
    const dir = join(root, `d${++n}`);
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'identity.json');
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, fileMode);
    chmodSync(dir, dirMode);
    return file;
  }
  const refused = (promise: Promise<unknown>) => assert.rejects(promise, IdentityUnavailable);

  test('an owner-only file in an owner-only directory gives the secret', async () => {
    assert.deepEqual(await readIdentitySecret(place(), EXPECTED), bytes(100));
  });

  test('group or other bits on the file or the directory are refused', async () => {
    for (const fileMode of [0o640, 0o604, 0o660]) await refused(readIdentitySecret(place(record(), { fileMode }), EXPECTED));
    for (const dirMode of [0o750, 0o705, 0o755]) await refused(readIdentitySecret(place(record(), { dirMode }), EXPECTED));
  });

  test('a symlinked file or directory is refused, never followed', async () => {
    const real = place();
    const fileLink = join(root, `d${++n}`);
    mkdirSync(fileLink, { mode: 0o700 });
    symlinkSync(real, join(fileLink, 'identity.json'));
    await refused(readIdentitySecret(join(fileLink, 'identity.json'), EXPECTED));
    const dirLink = join(root, `link${++n}`);
    symlinkSync(join(real, '..'), dirLink);
    await refused(readIdentitySecret(join(dirLink, 'identity.json'), EXPECTED));
  });

  test('a missing, oversized, non-UTF-8 or mismatched file, or a relative path, is refused', async () => {
    await refused(readIdentitySecret(join(root, 'nowhere', 'identity.json'), EXPECTED));
    // Valid JSON followed by padding: only the size limit refuses it.
    await refused(readIdentitySecret(place(record() + ' '.repeat(5000)), EXPECTED));
    assert.deepEqual(await readIdentitySecret(place(record() + ' '.repeat(100)), EXPECTED), bytes(100), 'a little padding is fine');
    const binary = place();
    writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x7b]));
    await refused(readIdentitySecret(binary, EXPECTED));
    await refused(readIdentitySecret(place(), { model: MODEL, port: 30114 }));
    await refused(readIdentitySecret('identity.json', EXPECTED));
    const dir = join(root, `d${++n}`);
    mkdirSync(join(dir, 'identity.json'), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    await refused(readIdentitySecret(join(dir, 'identity.json'), EXPECTED));
  });

  test('a FIFO in the file\'s place is refused at once, not waited on', { timeout: 5000 }, async () => {
    const dir = join(root, `d${++n}`);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    const fifo = join(dir, 'identity.json');
    execFileSync('mkfifo', ['-m', '600', fifo]);
    await refused(readIdentitySecret(fifo, EXPECTED));
  });

  test('invalid UTF-8 is refused even inside an otherwise valid record', async () => {
    const text = Buffer.from(record({ label: 'LABEL' }), 'utf8');
    const at = text.indexOf('LABEL');
    text[at] = 0xff;
    const file = place();
    writeFileSync(file, text);
    await refused(readIdentitySecret(file, EXPECTED));
  });

  test('a relative path is refused even when it would resolve to a valid file', async () => {
    const file = place();
    assert.deepEqual(await readIdentitySecret(file, EXPECTED), bytes(100));
    const rel = relative(process.cwd(), file);
    assert.ok(!rel.startsWith('/') && rel.includes('/'));
    await refused(readIdentitySecret(rel, EXPECTED));
  });

  test('errors carry no path or contents', async () => {
    const file = place(record({ model: 'mlx-community/other' }));
    await assert.rejects(readIdentitySecret(file, EXPECTED), (error: unknown) => {
      assert.ok(error instanceof IdentityUnavailable);
      assert.ok(!error.message.includes(root), 'no path');
      assert.ok(!error.message.includes(base64url(bytes(100))), 'no secret');
      return true;
    });
  });
});
