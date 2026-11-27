// Contract tests for the loopback transport (the local base rewrite route). Each test runs
// a throwaway HTTP server on 127.0.0.1 inside this process, so nothing leaves
// the machine. Fictional text only; no service, model or credential.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FailureCode } from '../../src/contracts/session.ts';
import type { PublishedRoute } from '../../src/contracts/ipc.ts';
import type { JobSink, ProviderSuccess } from '../../src/main/ipc.ts';
import { createJobRunner } from '../../src/main/jobs.ts';
import { CHAT_COMPLETIONS_PATH, NotSent, createChatRewriteProvider } from '../../src/main/providers/chatRewrite.ts';
import type { ChatRequest } from '../../src/main/providers/chatRewrite.ts';
import { LOOPBACK_HOST, createLoopbackTransport } from '../../src/main/providers/loopbackHttp.ts';

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
function runJob(port: number, timeoutMs = 2000) {
  const provider = createChatRewriteProvider({ route: ROUTE, maxTokens: 512, timeoutMs, maxReplyBytes: 64 * 1024, transport: createLoopbackTransport({ port }) });
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
