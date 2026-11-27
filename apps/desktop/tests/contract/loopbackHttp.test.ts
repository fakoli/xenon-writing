// Contract tests for the loopback transport (the local base rewrite route). Each test runs
// a throwaway HTTP server on 127.0.0.1 inside this process, so nothing leaves
// the machine. Fictional text only; no service, model or credential.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import type { FailureCode } from '../../src/contracts/session.ts';
import type { PublishedRoute } from '../../src/contracts/ipc.ts';
import type { JobSink, ProviderSuccess } from '../../src/main/ipc.ts';
import { createJobRunner } from '../../src/main/jobs.ts';
import { CHAT_COMPLETIONS_PATH, NotSent, createChatRewriteProvider } from '../../src/main/providers/chatRewrite.ts';
import type { ChatRequest } from '../../src/main/providers/chatRewrite.ts';
import { LOOPBACK_HOST, createLoopbackTransport } from '../../src/main/providers/loopbackHttp.ts';
import type { ServerIdentityCheck } from '../../src/main/providers/loopbackHttp.ts';
import { NONCE_HEADER, PROOF_HEADER, computeProof, endpoint } from '../../src/main/providers/serverIdentity.ts';

const MODEL = 'example-base-model';
const ROUTE: PublishedRoute = Object.freeze({
  routeKey: 'local-base-rewrite',
  stage: 'rewrite',
  mode: 'base',
  identity: MODEL,
  label: 'Local base model',
  locationClass: 'local',
  readiness: 'ready',
  limits: Object.freeze({ transcriptBytes: 16_000, steeringBytes: 2048, draftBytes: 24 * 1024 }),
});

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  remoteAddress: string;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void;

const servers: http.Server[] = [];
after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

/** Starts a server on 127.0.0.1 with an OS-chosen port and records every request. */
async function serve(handler: Handler) {
  const seen: Seen[] = [];
  const closed: number[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), remoteAddress: req.socket.remoteAddress ?? '' };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  server.on('connection', (socket) => socket.on('close', () => closed.push(Date.now())));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  return { port: (server.address() as AddressInfo).port, seen, closed, server };
}

/** A port that nothing listens on: bind, note the port, close. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function chatReply(content: string, model = MODEL) {
  return JSON.stringify({ object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
}

const okHandler: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(chatReply('Meet at noon.'));
};

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    path: CHAT_COMPLETIONS_PATH,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': 'job-1' },
    body: new TextEncoder().encode('{"model":"example-base-model"}'),
    maxReplyBytes: 64 * 1024,
    ...overrides,
  };
}

type Outcome = { ok: true; result: ProviderSuccess } | { ok: false; code: FailureCode };

/** Runs one rewrite through the real runner, the chat core and this transport. */
function runJob(port: number, timeoutMs = 2000, identity?: ServerIdentityCheck) {
  const provider = createChatRewriteProvider({ route: ROUTE, maxTokens: 512, timeoutMs, maxReplyBytes: 64 * 1024, transport: createLoopbackTransport({ port, identity }) });
  const runner = createJobRunner({ routes: [ROUTE], providers: [provider] });
  let resolveOutcome: (outcome: Outcome) => void = () => {};
  const outcome = new Promise<Outcome>((resolve) => (resolveOutcome = resolve));
  const sink: JobSink = {
    succeeded: (result) => resolveOutcome({ ok: true, result }),
    failed: (code) => resolveOutcome({ ok: false, code }),
  };
  runner.submit({ jobId: '3f2a9c1e-0b7d-4e55-9a1c-2d4e6f8a0b1c', route: ROUTE, transcript: 'Synthetic note: meet at noon.', steering: 'Use one sentence.' }, sink);
  return { outcome, runner };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls a condition for up to two seconds. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await delay(20);
  assert.ok(condition(), 'condition never became true');
}

describe('loopback transport', () => {
  test('posts the request to 127.0.0.1 and the configured port only, on its own connection', async () => {
    const { port, seen } = await serve(okHandler);
    const reply = await createLoopbackTransport({ port }).send(request(), new AbortController().signal);
    assert.equal(reply.status, 200);
    assert.equal(reply.contentType, 'application/json');
    assert.equal(new TextDecoder().decode(reply.body), chatReply('Meet at noon.'));
    assert.equal(seen.length, 1);
    const [entry] = seen;
    assert.equal(entry?.method, 'POST');
    assert.equal(entry?.url, CHAT_COMPLETIONS_PATH);
    assert.equal(entry?.headers.host, `127.0.0.1:${port}`);
    assert.equal(entry?.headers.connection, 'close');
    assert.equal(entry?.headers['content-length'], String(request().body.byteLength));
    assert.equal(entry?.headers['idempotency-key'], 'job-1');
    assert.equal(entry?.body, '{"model":"example-base-model"}');
    assert.equal(entry?.remoteAddress, '127.0.0.1');
  });

  test('end to end through the runner and the chat core: one request, the route identity, the job ID as the key', async () => {
    const { port, seen } = await serve(okHandler);
    const { outcome } = runJob(port);
    assert.deepEqual(await outcome, { ok: true, result: { actualMode: 'base', actualIdentity: MODEL, text: 'Meet at noon.' } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.headers['idempotency-key'], '3f2a9c1e-0b7d-4e55-9a1c-2d4e6f8a0b1c');
    const body = JSON.parse(seen[0]?.body ?? '{}') as { model: string; messages: { role: string; content: string }[] };
    assert.equal(body.model, MODEL);
    assert.equal(body.messages[1]?.content, 'Synthetic note: meet at noon.');
  });

  test('a stopped service is "not sent", so the job is route_unavailable, not an unknown outcome', async () => {
    const port = await closedPort();
    await assert.rejects(createLoopbackTransport({ port }).send(request(), new AbortController().signal), NotSent);
    assert.deepEqual(await runJob(port).outcome, { ok: false, code: 'route_unavailable' });
  });

  test('stops reading a reply past the cap and delivers cap + 1 bytes, which the core refuses', async () => {
    const big = 'x'.repeat(200_000);
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(chatReply(big));
    });
    const reply = await createLoopbackTransport({ port }).send(request({ maxReplyBytes: 1000 }), new AbortController().signal);
    assert.equal(reply.body.byteLength, 1001);
    assert.deepEqual(await runJob(port).outcome, { ok: false, code: 'invalid_response' });
  });

  test('stops at the cap even when the reply never ends, and closes the connection', async () => {
    const { port, closed } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('x'.repeat(4000)); // and never end
    });
    const started = Date.now();
    const reply = await createLoopbackTransport({ port }).send(request({ maxReplyBytes: 1000 }), new AbortController().signal);
    assert.equal(reply.body.byteLength, 1001);
    assert.ok(Date.now() - started < 1000, 'it did not wait for the end');
    await until(() => closed.length === 1);
  });

  test('a reply of exactly the cap is delivered whole', async () => {
    const body = 'y'.repeat(1000);
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    const reply = await createLoopbackTransport({ port }).send(request({ maxReplyBytes: 1000 }), new AbortController().signal);
    assert.equal(reply.body.byteLength, 1000);
  });

  test('a reply that reaches the cap and then sends more is delivered as over the cap', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('y'.repeat(1000));
      setTimeout(() => res.end('z'.repeat(10)), 50);
    });
    const reply = await createLoopbackTransport({ port }).send(request({ maxReplyBytes: 1000 }), new AbortController().signal);
    assert.equal(reply.body.byteLength, 1001);
  });

  test('the reply content type is passed through as sent', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<p>not json</p>');
    });
    const reply = await createLoopbackTransport({ port }).send(request(), new AbortController().signal);
    assert.equal(reply.contentType, 'text/html; charset=utf-8');
    assert.deepEqual(await runJob(port).outcome, { ok: false, code: 'invalid_response' });
  });

  test('a redirect is not followed', async () => {
    const elsewhere = await serve(okHandler);
    const { port } = await serve((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}${CHAT_COMPLETIONS_PATH}` });
      res.end();
    });
    assert.deepEqual(await runJob(port).outcome, { ok: false, code: 'unknown_outcome' });
    assert.equal(elsewhere.seen.length, 0, 'the redirect target never heard from us');
  });

  test('a service that hangs: the timeout aborts the connection and the outcome is unknown', async () => {
    const { port, seen, closed } = await serve(() => {
      /* never answers */
    });
    const started = Date.now();
    assert.deepEqual(await runJob(port, 300).outcome, { ok: false, code: 'unknown_outcome' });
    assert.ok(Date.now() - started < 2000);
    await delay(100);
    assert.equal(seen.length, 1, 'the request was received');
    assert.equal(closed.length, 1, 'and its connection was closed by the abort');
  });

  test('cancel after dispatch aborts the connection and the outcome is unknown', async () => {
    const { port, closed } = await serve(() => {
      /* never answers */
    });
    const { outcome, runner } = runJob(port, 10_000);
    await delay(150);
    runner.cancel('3f2a9c1e-0b7d-4e55-9a1c-2d4e6f8a0b1c');
    assert.deepEqual(await outcome, { ok: false, code: 'unknown_outcome' });
    await delay(100);
    assert.equal(closed.length, 1);
  });

  test('a reply cut off mid-body rejects at once, and the job is an unknown outcome', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
      res.write('{"object":"chat.');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const started = Date.now();
    await assert.rejects(createLoopbackTransport({ port }).send(request(), new AbortController().signal));
    assert.ok(Date.now() - started < 500, 'the transport itself noticed, not a timeout');
    assert.deepEqual(await runJob(port).outcome, { ok: false, code: 'unknown_outcome' });
  });

  test('an abort before sending sends nothing', async () => {
    const { port, seen } = await serve(okHandler);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createLoopbackTransport({ port }).send(request(), controller.signal), NotSent);
    await delay(50);
    assert.equal(seen.length, 0);
  });

  test('proxy environment variables do not reroute it', async () => {
    const { port, seen } = await serve(okHandler);
    const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy };
    const decoy = await closedPort();
    process.env.HTTP_PROXY = `http://127.0.0.1:${decoy}`;
    process.env.http_proxy = `http://127.0.0.1:${decoy}`;
    try {
      const reply = await createLoopbackTransport({ port }).send(request(), new AbortController().signal);
      assert.equal(reply.status, 200);
      assert.equal(seen.length, 1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // Node 24+ (and Electron 45's Node 24) can route the global agent through
  // HTTP_PROXY; the transport's own agent must not follow it.
  const setGlobalProxy = (http as unknown as { setGlobalProxyFromEnv?: (env: Record<string, string>) => () => void }).setGlobalProxyFromEnv;
  test('a global proxy agent does not reroute it', { skip: typeof setGlobalProxy !== 'function' && 'this Node has no global proxy support, so there is nothing to reroute' }, async () => {
    const { port, seen } = await serve(okHandler);
    const decoy = await serve(okHandler);
    const restore = setGlobalProxy!({ HTTP_PROXY: `http://127.0.0.1:${decoy.port}` });
    try {
      const reply = await createLoopbackTransport({ port }).send(request(), new AbortController().signal);
      assert.equal(reply.status, 200);
      assert.equal(seen.length, 1);
      assert.equal(decoy.seen.length, 0, 'nothing went to the proxy');
    } finally {
      restore();
    }
  });

  test('a port it cannot use fails at startup', () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) assert.throws(() => createLoopbackTransport({ port }), Error, String(port));
  });
});

// The identity proof (the local base rewrite route, loopback-model-identity/v1).
// Node's own HTTP server cannot put headers on a 100 Continue, so this stand-in
// for the model service's launcher speaks raw HTTP over node:net: it answers the
// headers with a 100 (or misbehaves, per mode), then reads the body and
// replies the way mlx_lm.server does (HTTP/1.0, then close).
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const OTHER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i);

type ProofMode =
  | 'valid'
  | 'valid-slow-reply'
  | 'double-continue'
  | 'processing'
  | 'wrong-secret'
  | 'plain-continue'
  | 'silent'
  | 'final-first'
  | 'other-model'
  | 'duplicate'
  | 'swapped-ends'
  | 'late'
  | 'valid-then-hang'
  | 'valid-then-reset';

interface IdentitySeen {
  headers: Record<string, string>;
  body: string | undefined;
  /** Bytes after the headers that arrived before this server's 100 (or with none sent). Must stay 0. */
  early: number;
  /** All bytes after the headers. */
  received: number;
  continued: boolean;
}

function identityCheck(overrides: Partial<ServerIdentityCheck> = {}): ServerIdentityCheck {
  return { model: MODEL, proofTimeoutMs: 1000, readSecret: async () => SECRET, ...overrides };
}

const identityServers: net.Server[] = [];
after(() => {
  for (const server of identityServers) server.close();
});

function parseHead(head: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of head.split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

async function identityServe(mode: ProofMode) {
  const seen: IdentitySeen[] = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let entry: IdentitySeen | undefined;
    let length = 0;
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      if (entry !== undefined) {
        if (!entry.continued) entry.early += chunk.byteLength;
        entry.received += chunk.byteLength;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (entry === undefined) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headers = parseHead(buffer.subarray(0, end).toString('latin1'));
        buffer = buffer.subarray(end + 4);
        // Whatever came in the same chunk as the headers was sent before any 100.
        entry = { headers, body: undefined, early: buffer.byteLength, received: buffer.byteLength, continued: false };
        seen.push(entry);
        const current = entry;
        length = Number(headers['content-length'] ?? 0);
        const nonce = headers[NONCE_HEADER] ?? '';
        const server = endpoint(socket.localAddress ?? '', socket.localPort ?? 0);
        const client = endpoint(socket.remoteAddress ?? '', socket.remotePort ?? 0);
        const proof = (secret = SECRET, model = MODEL, ends = [server, client]) => computeProof(secret, nonce, ends[0] ?? '', ends[1] ?? '', model);
        const proofLine = (value: string) => {
          current.continued = true;
          return `HTTP/1.1 100 Continue\r\n${PROOF_HEADER}: ${value}\r\n\r\n`;
        };
        if (mode === 'valid' || mode === 'valid-slow-reply' || mode === 'valid-then-hang' || mode === 'valid-then-reset') socket.write(proofLine(proof()));
        else if (mode === 'double-continue') socket.write(proofLine(proof()) + proofLine(proof()));
        else if (mode === 'processing') socket.write(`HTTP/1.1 102 Processing\r\n${PROOF_HEADER}: ${proof()}\r\n\r\n`);
        else if (mode === 'wrong-secret') socket.write(proofLine(proof(OTHER_SECRET)));
        else if (mode === 'other-model') socket.write(proofLine(proof(SECRET, 'mlx-community/other')));
        else if (mode === 'swapped-ends') socket.write(proofLine(proof(SECRET, MODEL, [client, server])));
        else if (mode === 'duplicate') socket.write(`HTTP/1.1 100 Continue\r\n${PROOF_HEADER}: ${proof()}\r\n${PROOF_HEADER}: ${proof()}\r\n\r\n`);
        else if (mode === 'plain-continue') {
          current.continued = true;
          socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        }
        else if (mode === 'late') setTimeout(() => socket.writable && socket.write(proofLine(proof())), 400);
        else if (mode === 'final-first') socket.end(`HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n${chatReply('Answered without the text.')}`);
        // 'silent' waits for a body, like mlx_lm.server without the launcher.
      }
      if (entry !== undefined && entry.body === undefined && buffer.byteLength >= length && length > 0) {
        entry.body = buffer.subarray(0, length).toString('utf8');
        const answer = () => socket.end(`HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n${chatReply('Meet at noon.')}`);
        if (mode === 'valid-slow-reply') setTimeout(answer, 400);
        else if (mode === 'valid-then-reset') socket.resetAndDestroy();
        else if (mode !== 'valid-then-hang') answer();
      }
    });
  });
  identityServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

describe('loopback transport with the identity proof', { timeout: 10_000 }, () => {
  test('a valid proof: headers first, the body only after the 100, on the same connection', async () => {
    const { port, seen } = await identityServe('valid');
    const reply = await createLoopbackTransport({ port, identity: identityCheck() }).send(request(), new AbortController().signal);
    assert.equal(reply.status, 200);
    assert.equal(new TextDecoder().decode(reply.body), chatReply('Meet at noon.'));
    assert.equal(seen.length, 1, 'one connection');
    assert.equal(seen[0]?.headers.expect, '100-continue');
    assert.match(seen[0]?.headers[NONCE_HEADER] ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal(seen[0]?.headers['idempotency-key'], 'job-1');
    assert.equal(seen[0]?.body, '{"model":"example-base-model"}');
    assert.equal(seen[0]?.early, 0, 'not one byte of the body before the 100');
  });

  test('end to end through the runner and the chat core', async () => {
    const { port, seen } = await identityServe('valid');
    assert.deepEqual(await runJob(port, 2000, identityCheck()).outcome, { ok: true, result: { actualMode: 'base', actualIdentity: MODEL, text: 'Meet at noon.' } });
    assert.equal(JSON.parse(seen[0]?.body ?? '{}').messages[1].content, 'Synthetic note: meet at noon.');
  });

  test('a reply slower than the proof timeout still arrives: the timeout covers the proof only', async () => {
    const { port, seen } = await identityServe('valid-slow-reply');
    const reply = await createLoopbackTransport({ port, identity: identityCheck({ proofTimeoutMs: 150 }) }).send(request(), new AbortController().signal);
    assert.equal(reply.status, 200);
    assert.equal(seen[0]?.early, 0);
  });

  test('a second 100 after the body is ignored', async () => {
    const { port, seen } = await identityServe('double-continue');
    const reply = await createLoopbackTransport({ port, identity: identityCheck() }).send(request(), new AbortController().signal);
    assert.equal(reply.status, 200);
    assert.equal(seen[0]?.body, '{"model":"example-base-model"}');
    assert.equal(seen[0]?.early, 0);
  });

  test('a proof on another 1xx is not a 100: nothing is sent', async () => {
    const { port, seen } = await identityServe('processing');
    await assert.rejects(createLoopbackTransport({ port, identity: identityCheck({ proofTimeoutMs: 200 }) }).send(request(), new AbortController().signal), NotSent);
    assert.equal(seen[0]?.received, 0);
  });

  test('after a valid proof the body may have left: a cancel is an unknown outcome', async () => {
    const { port, seen } = await identityServe('valid-then-hang');
    const { outcome, runner } = runJob(port, 10_000, identityCheck());
    await until(() => seen[0]?.body !== undefined);
    runner.cancel('3f2a9c1e-0b7d-4e55-9a1c-2d4e6f8a0b1c');
    assert.deepEqual(await outcome, { ok: false, code: 'unknown_outcome' });
    assert.equal(seen[0]?.early, 0);
  });

  test('after a valid proof the body may have left: a reset is an unknown outcome', async () => {
    const { port, seen } = await identityServe('valid-then-reset');
    assert.deepEqual(await runJob(port, 2000, identityCheck()).outcome, { ok: false, code: 'unknown_outcome' });
    assert.equal(JSON.parse(seen[0]?.body ?? '{}').messages[1].content, 'Synthetic note: meet at noon.', 'the whole body arrived before the reset');
    assert.equal(seen[0]?.early, 0);
  });

  test('a cancel while waiting for the proof: nothing was sent, so the job is route_unavailable', async () => {
    const { port, seen } = await identityServe('silent');
    const { outcome, runner } = runJob(port, 10_000, identityCheck({ proofTimeoutMs: 5000 }));
    await until(() => seen.length === 1);
    runner.cancel('3f2a9c1e-0b7d-4e55-9a1c-2d4e6f8a0b1c');
    assert.deepEqual(await outcome, { ok: false, code: 'route_unavailable' });
    await delay(50);
    assert.equal(seen[0]?.received, 0);
  });

  test('a fresh nonce for every request', async () => {
    const { port, seen } = await identityServe('valid');
    const transport = createLoopbackTransport({ port, identity: identityCheck() });
    await transport.send(request(), new AbortController().signal);
    await transport.send(request(), new AbortController().signal);
    assert.notEqual(seen[0]?.headers[NONCE_HEADER], seen[1]?.headers[NONCE_HEADER]);
  });

  for (const mode of ['wrong-secret', 'other-model', 'swapped-ends', 'duplicate', 'plain-continue', 'final-first'] as const) {
    test(`${mode}: the body is never sent, and the job is route_unavailable, not an unknown outcome`, async () => {
      const { port, seen } = await identityServe(mode);
      await assert.rejects(createLoopbackTransport({ port, identity: identityCheck() }).send(request(), new AbortController().signal), NotSent);
      assert.deepEqual(await runJob(port, 2000, identityCheck()).outcome, { ok: false, code: 'route_unavailable' });
      await delay(50);
      assert.equal(seen.length, 2, 'the headers arrived');
      assert.ok(seen.every((entry) => entry.received === 0), 'not one byte of the body ever did');
    });
  }

  test('no 100 at all (a service without the proof waits for the body): refused once the proof timeout passes', async () => {
    const { port, seen } = await identityServe('silent');
    const started = Date.now();
    await assert.rejects(createLoopbackTransport({ port, identity: identityCheck({ proofTimeoutMs: 200 }) }).send(request(), new AbortController().signal), NotSent);
    const took = Date.now() - started;
    assert.ok(took >= 190 && took < 1000, `refused after the proof timeout (${took} ms)`);
    assert.equal(seen[0]?.received, 0);
  });

  test('a proof later than the timeout is refused even though it is valid', async () => {
    const { port, seen } = await identityServe('late');
    await assert.rejects(createLoopbackTransport({ port, identity: identityCheck({ proofTimeoutMs: 150 }) }).send(request(), new AbortController().signal), NotSent);
    await delay(400);
    assert.equal(seen[0]?.received, 0);
  });

  test('a relay that forwards the nonce to the real service gets a proof for its own connection, which is refused', async () => {
    const real = await identityServe('valid');
    // The shadowing process: accepts our connection, opens its own to the real
    // service, and pipes bytes both ways.
    let relayed = 0;
    const relay = net.createServer((inbound) => {
      relayed += 1;
      const outbound = net.connect(real.port, LOOPBACK_HOST);
      inbound.on('error', () => {}).pipe(outbound.on('error', () => {})).pipe(inbound);
    });
    identityServers.push(relay);
    await new Promise<void>((resolve) => relay.listen(0, LOOPBACK_HOST, resolve));
    const port = (relay.address() as AddressInfo).port;
    // The relay's port stands in for the card's port: the client checks the proof against that one.
    await assert.rejects(createLoopbackTransport({ port, identity: identityCheck() }).send(request(), new AbortController().signal), NotSent);
    await delay(50);
    assert.equal(relayed, 1);
    assert.equal(real.seen.length, 1, 'the real service saw the headers through the relay');
    assert.equal(real.seen[0]?.received, 0, 'and never a byte of the body');
  });

  test('an unreadable identity sends nothing at all: no connection is opened', async () => {
    const { port, seen } = await identityServe('valid');
    const identity = identityCheck({ readSecret: async () => Promise.reject(new Error('missing')) });
    await assert.rejects(createLoopbackTransport({ port, identity }).send(request(), new AbortController().signal), NotSent);
    assert.deepEqual(await runJob(port, 2000, identity).outcome, { ok: false, code: 'route_unavailable' });
    await delay(50);
    assert.equal(seen.length, 0);
  });

  test('an abort while waiting for the proof leaves the body unsent', async () => {
    const { port, seen } = await identityServe('silent');
    const controller = new AbortController();
    const sending = createLoopbackTransport({ port, identity: identityCheck({ proofTimeoutMs: 5000 }) }).send(request(), controller.signal);
    await until(() => seen.length === 1);
    controller.abort();
    await assert.rejects(sending, NotSent);
    await delay(50);
    assert.equal(seen[0]?.received, 0);
  });

  test('an abort before the identity is read sends nothing', async () => {
    const { port, seen } = await identityServe('valid');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createLoopbackTransport({ port, identity: identityCheck() }).send(request(), controller.signal), NotSent);
    await delay(50);
    assert.equal(seen.length, 0);
  });

  test('a stopped service with a readable identity is still "not sent"', async () => {
    const port = await closedPort();
    await assert.rejects(createLoopbackTransport({ port, identity: identityCheck() }).send(request(), new AbortController().signal), NotSent);
  });

  test('an identity check needs a positive proof timeout', () => {
    for (const proofTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => createLoopbackTransport({ port: 30113, identity: identityCheck({ proofTimeoutMs }) }), Error, String(proofTimeoutMs));
    }
  });
});
