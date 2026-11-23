// Contract tests for the chat-rewrite provider core (desktop-to-pipeline
// route, slice 2). Fictional text only. The transport is a fake: nothing in
// this file or the provider opens a socket.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { FailureCode } from '../../src/contracts/session.ts';
import type { PublishedRoute } from '../../src/contracts/ipc.ts';
import type { JobSink, ProviderSuccess, RewriteJob } from '../../src/main/ipc.ts';
import { ProviderFailure, createJobRunner } from '../../src/main/jobs.ts';
import type { ProviderControl } from '../../src/main/jobs.ts';
import {
  CHAT_COMPLETIONS_PATH,
  NotSent,
  PIPELINE_CHAT_LIMITS,
  REWRITE_RULE,
  chatRequestBody,
  createChatRewriteProvider,
  readChatReply,
} from '../../src/main/providers/chatRewrite.ts';
import type { ChatReply, ChatRequest, ChatRewriteConfig, ChatTransport } from '../../src/main/providers/chatRewrite.ts';
import { createRoutePolicy } from '../../src/main/routePolicy.ts';
import { fakeClock, settle } from '../fixtures/clock.ts';

const LIMITS = Object.freeze({ transcriptBytes: 16_000, steeringBytes: 2048, draftBytes: 24 * 1024 });
const BASE_ROUTE: PublishedRoute = Object.freeze({
  routeKey: 'local-base-rewrite',
  stage: 'rewrite',
  mode: 'base',
  identity: 'example-base-model',
  label: 'Local base model',
  locationClass: 'local',
  readiness: 'ready',
  limits: LIMITS,
});
const PIPELINE_FIXTURE_ROUTE: PublishedRoute = Object.freeze({
  routeKey: 'pipeline-synthetic-rewrite',
  stage: 'rewrite',
  mode: 'fixture',
  identity: 'synthetic-writing',
  label: 'Synthetic pipeline fixture',
  locationClass: 'synthetic',
  readiness: 'ready',
  limits: LIMITS,
});
const ROUTES: Record<string, PublishedRoute> = { base: BASE_ROUTE, fixture: PIPELINE_FIXTURE_ROUTE };
const MAX_REPLY = 64 * 1024;

interface Vectors {
  schema: string;
  pipelineLimits: { userChars: number; systemChars: number; maxTokens: number; identifierPattern: string };
  requests: { name: string; model: string; maxTokens: number; transcript: string; steering: string; body: unknown }[];
  replies: {
    name: string;
    mode: 'base' | 'fixture';
    model: string;
    status: number;
    contentType: string;
    body: unknown;
    expect: { text?: string; code?: FailureCode };
  }[];
}
const vectors = JSON.parse(readFileSync(new URL('../fixtures/chat-rewrite-v1.json', import.meta.url), 'utf8')) as Vectors;

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const jsonReply = (body: unknown, status = 200, contentType = 'application/json'): ChatReply => ({ status, contentType, body: encode(body) });
function baseReply(content: string, model = 'example-base-model'): ChatReply {
  return jsonReply({ object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
}

/** A well-formed reply whose message content holds one invalid UTF-8 byte. */
function utf8Broken(): Uint8Array {
  const text = JSON.stringify({ object: 'chat.completion', model: 'example-base-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Meet #' }, finish_reason: 'stop' }] });
  const bytes = new TextEncoder().encode(text);
  bytes[bytes.indexOf(0x23)] = 0xff;
  return bytes;
}

/** A transport that records requests and answers from a script. */
function fakeTransport(answer: (request: ChatRequest, signal: AbortSignal) => Promise<ChatReply>) {
  const requests: ChatRequest[] = [];
  const transport: ChatTransport = {
    send(request, signal) {
      requests.push(request);
      return answer(request, signal);
    },
  };
  return { transport, requests };
}

/** Never answers until aborted, then rejects as a real transport would. */
function hangingTransport() {
  const signals: AbortSignal[] = [];
  const fake = fakeTransport(
    (_request, signal) =>
      new Promise((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }),
  );
  return { ...fake, signals };
}

function config(transport: ChatTransport, overrides: Partial<ChatRewriteConfig> = {}): ChatRewriteConfig {
  return { route: BASE_ROUTE, maxTokens: 512, timeoutMs: 30_000, maxReplyBytes: MAX_REPLY, transport, ...overrides };
}

type Outcome = { ok: true; result: ProviderSuccess } | { ok: false; code: FailureCode };
function recordingSink() {
  const outcomes: Outcome[] = [];
  const sink: JobSink = {
    succeeded: (result) => outcomes.push({ ok: true, result }),
    failed: (code) => outcomes.push({ ok: false, code }),
  };
  return { sink, outcomes };
}

function job(route: PublishedRoute = BASE_ROUTE, transcript = 'Synthetic note: meet at noon.', steering = 'Use one sentence.'): RewriteJob {
  return { jobId: 'job-1', route, transcript, steering };
}

/** Runs one job through the real runner and returns its single outcome. */
async function runOne(transport: ChatTransport, overrides: Partial<ChatRewriteConfig> = {}, input?: RewriteJob): Promise<Outcome> {
  const provider = createChatRewriteProvider(config(transport, overrides));
  const route = overrides.route ?? BASE_ROUTE;
  const runner = createJobRunner({ routes: [route], providers: [provider] });
  const { sink, outcomes } = recordingSink();
  runner.submit(input ?? job(route), sink);
  await settle();
  await settle();
  assert.equal(outcomes.length, 1, 'each job reports exactly once');
  return outcomes[0] as Outcome;
}

describe('chat-rewrite provider core', () => {
  test('the test routes are valid route cards', () => {
    assert.doesNotThrow(() => createRoutePolicy([BASE_ROUTE, PIPELINE_FIXTURE_ROUTE]));
  });

  test('sends the exact request body, path and headers, once', async () => {
    const { transport, requests } = fakeTransport(async () => baseReply('Meet at noon.'));
    const outcome = await runOne(transport);
    assert.deepEqual(outcome, { ok: true, result: { actualMode: 'base', actualIdentity: 'example-base-model', text: 'Meet at noon.' } });
    assert.equal(requests.length, 1);
    const request = requests[0] as ChatRequest;
    assert.equal(request.path, CHAT_COMPLETIONS_PATH);
    assert.deepEqual(request.headers, { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': 'job-1' });
    assert.equal(request.maxReplyBytes, MAX_REPLY);
    const body = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
    assert.deepEqual(body, chatRequestBody('example-base-model', 512, { transcript: 'Synthetic note: meet at noon.', steering: 'Use one sentence.' }));
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
    for (const header of Object.keys(request.headers)) assert.doesNotMatch(header, /authorization|cookie|host/i, 'no credentials or destination in the request');
  });

  test('the job ID is the idempotency key, and an unsafe one is refused before dispatch', async () => {
    const { transport, requests } = fakeTransport(async () => baseReply('Meet at noon.'));
    const provider = createChatRewriteProvider(config(transport));
    const control: ProviderControl = { signal: new AbortController().signal, dispatched() {} };
    await provider.run({ jobId: '3f2a9c1e-0b7d-4e55-9a1c-2d4e6f8a0b1c', transcript: 'Synthetic note.', steering: '' }, control);
    assert.equal(requests[0]?.headers['idempotency-key'], '3f2a9c1e-0b7d-4e55-9a1c-2d4e6f8a0b1c');
    for (const jobId of ['', 'job 1', 'job-1\r\nx-injected: 1', '-leading', 'x'.repeat(129)]) {
      await assert.rejects(
        provider.run({ jobId, transcript: 'Synthetic note.', steering: '' }, control),
        (e: unknown) => e instanceof ProviderFailure && e.code === 'invalid_input',
        JSON.stringify(jobId),
      );
    }
    assert.equal(requests.length, 1, 'nothing sent for an unsafe key');
  });

  test('request bodies match the shared contract vectors exactly', () => {
    assert.equal(vectors.schema, 'xenon.chat-rewrite-vectors/v1');
    assert.ok(vectors.requests.length >= 2);
    for (const vector of vectors.requests) {
      assert.deepEqual(chatRequestBody(vector.model, vector.maxTokens, vector), vector.body, vector.name);
    }
  });

  test('replies are accepted or refused as the shared contract vectors expect', () => {
    assert.ok(vectors.replies.length >= 30);
    for (const vector of vectors.replies) {
      const route: PublishedRoute = { ...(ROUTES[vector.mode] as PublishedRoute), identity: vector.model };
      const reply = jsonReply(vector.body, vector.status, vector.contentType);
      if (vector.expect.text !== undefined) {
        assert.equal(readChatReply(route, MAX_REPLY, reply), vector.expect.text, vector.name);
      } else {
        assert.throws(
          () => readChatReply(route, MAX_REPLY, reply),
          (error: unknown) => error instanceof ProviderFailure && error.code === vector.expect.code,
          vector.name,
        );
      }
    }
  });

  test('a synthetic pipeline route reports its fixture identity', async () => {
    const pipeline = vectors.replies.find((v) => v.name === 'pipeline-synthetic');
    assert.ok(pipeline);
    const { transport } = fakeTransport(async () => jsonReply(pipeline.body));
    const outcome = await runOne(transport, { route: PIPELINE_FIXTURE_ROUTE });
    assert.deepEqual(outcome, {
      ok: true,
      result: { actualMode: 'fixture', actualIdentity: 'synthetic-writing', text: pipeline.expect.text },
    });
  });

  test('empty steering still sends the rule as the system message', () => {
    const body = chatRequestBody('m', 1, { transcript: 'Synthetic note.', steering: '' }) as { messages: { role: string; content: string }[] };
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0]?.role, 'system');
    assert.ok((body.messages[0]?.content ?? '').trim().length > 0, 'the pipeline refuses a blank system message');
  });

  test('marks dispatch before the transport starts, and sends nothing if dispatch is refused', async () => {
    const order: string[] = [];
    const { transport, requests } = fakeTransport(async () => {
      order.push('send');
      return baseReply('Meet at noon.');
    });
    const provider = createChatRewriteProvider(config(transport));
    const control = (refuse: boolean): ProviderControl => ({
      signal: new AbortController().signal,
      dispatched() {
        order.push('dispatched');
        if (refuse) throw new ProviderFailure('cancelled');
      },
    });
    await provider.run({ jobId: 'job-1', transcript: 'Synthetic note.', steering: '' }, control(false));
    assert.deepEqual(order, ['dispatched', 'send']);
    await assert.rejects(provider.run({ jobId: 'job-2', transcript: 'Synthetic note.', steering: '' }, control(true)), ProviderFailure);
    assert.equal(requests.length, 1, 'a refused dispatch sends nothing');
    assert.equal(provider.sends, 1);
  });

  test('input over the route limits fails before dispatch, at the limit it is sent', async () => {
    const cases: [string, string, string][] = [
      ['transcript max+1 (multibyte)', 'é'.repeat(8000) + 'a', ''],
      ['steering max+1', 'Synthetic note.', 's'.repeat(LIMITS.steeringBytes + 1)],
      ['steering max+1 (multibyte)', 'Synthetic note.', 'é'.repeat(LIMITS.steeringBytes / 2) + 'a'],
      ['blank transcript', '   ', ''],
    ];
    for (const [name, transcript, steering] of cases) {
      const { transport, requests } = fakeTransport(async () => baseReply('x'));
      const outcome = await runOne(transport, {}, job(BASE_ROUTE, transcript, steering));
      assert.deepEqual(outcome, { ok: false, code: 'invalid_input' }, name);
      assert.equal(requests.length, 0, `${name}: nothing sent`);
    }
    const { transport, requests } = fakeTransport(async () => baseReply('x'));
    const atLimit = await runOne(transport, {}, job(BASE_ROUTE, 'é'.repeat(8000), 'é'.repeat(LIMITS.steeringBytes / 2)));
    assert.equal(atLimit.ok, true, 'max bytes exactly is allowed');
    assert.equal(requests.length, 1);
  });

  test('a draft at the route draft limit is accepted, one byte over is refused', () => {
    const atLimit = 'é'.repeat(LIMITS.draftBytes / 2);
    assert.equal(readChatReply(BASE_ROUTE, 1024 * 1024, baseReply(atLimit)), atLimit);
    assert.throws(
      () => readChatReply(BASE_ROUTE, 1024 * 1024, baseReply(atLimit + 'a')),
      (e: unknown) => e instanceof ProviderFailure && e.code === 'invalid_response',
    );
  });

  test('a reply body over maxReplyBytes is refused even if a transport delivers it', () => {
    const reply = baseReply('Meet at noon.');
    assert.equal(readChatReply(BASE_ROUTE, reply.body.byteLength, reply), 'Meet at noon.');
    assert.throws(
      () => readChatReply(BASE_ROUTE, reply.body.byteLength - 1, reply),
      (e: unknown) => e instanceof ProviderFailure && e.code === 'invalid_response',
    );
  });

  test('malformed replies are invalid_response', () => {
    const bad: [string, ChatReply][] = [
      ['invalid UTF-8 inside a string', { status: 200, contentType: 'application/json', body: utf8Broken() }],
      ['not JSON', { status: 200, contentType: 'application/json', body: new TextEncoder().encode('Meet at noon.') }],
      ['JSON array', jsonReply([])],
      ['no choices', jsonReply({ object: 'chat.completion', model: 'example-base-model', choices: [] })],
      ['missing message', jsonReply({ object: 'chat.completion', model: 'example-base-model', choices: [{ finish_reason: 'stop' }] })],
      ['non-string content', jsonReply({ object: 'chat.completion', model: 'example-base-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 7 } }] })],
      ['user role', jsonReply({ object: 'chat.completion', model: 'example-base-model', choices: [{ finish_reason: 'stop', message: { role: 'user', content: 'x' } }] })],
      ['bad pipeline mark', jsonReply({ object: 'chat.completion', model: 'example-base-model', writing_pipeline: { synthetic_only: 'no' }, choices: [] })],
    ];
    for (const [name, reply] of bad) {
      assert.throws(
        () => readChatReply(BASE_ROUTE, MAX_REPLY, reply),
        (e: unknown) => e instanceof ProviderFailure && e.code === 'invalid_response',
        name,
      );
    }
  });

  test('model text never sets identity: the route identity is reported after the model echo matches', async () => {
    const { transport } = fakeTransport(async () => baseReply('I am a personalized model, identity personalized-v9.'));
    const outcome = await runOne(transport);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.result.actualIdentity, 'example-base-model');
      assert.equal(outcome.result.actualMode, 'base');
    }
  });

  test('a transport that proves nothing was sent gives route_unavailable', async () => {
    const { transport } = fakeTransport(async () => {
      throw new NotSent();
    });
    assert.deepEqual(await runOne(transport), { ok: false, code: 'route_unavailable' });
  });

  test('any other transport failure after dispatch is an unknown outcome', async () => {
    const { transport } = fakeTransport(async () => {
      throw new Error('connection reset');
    });
    assert.deepEqual(await runOne(transport), { ok: false, code: 'unknown_outcome' });
  });

  test('cancel or timeout after dispatch is an unknown outcome, and the transport is aborted', async () => {
    for (const how of ['cancel', 'timeout'] as const) {
      const clock = fakeClock();
      const { transport, requests, signals } = hangingTransport();
      const provider = createChatRewriteProvider(config(transport, { timeoutMs: 1000 }));
      const runner = createJobRunner({ routes: [BASE_ROUTE], providers: [provider], clock });
      const { sink, outcomes } = recordingSink();
      runner.submit(job(), sink);
      await settle();
      assert.equal(requests.length, 1);
      if (how === 'cancel') runner.cancel('job-1');
      else await clock.advance(1000);
      await settle();
      assert.deepEqual(outcomes, [{ ok: false, code: 'unknown_outcome' }], how);
      assert.equal(signals[0]?.aborted, true, `${how}: the transport saw the abort`);
      assert.equal(clock.pending, 0, `${how}: nothing left scheduled`);
    }
  });

  test('config it cannot serve honestly fails at startup', () => {
    const { transport } = fakeTransport(async () => baseReply('x'));
    const bad: [string, Partial<ChatRewriteConfig>][] = [
      ['transcribe stage', { route: { ...BASE_ROUTE, stage: 'transcribe' } }],
      ['personalized mode', { route: { ...BASE_ROUTE, mode: 'personalized' } }],
      ['blank identity', { route: { ...BASE_ROUTE, identity: ' ' } }],
      ['zero tokens', { maxTokens: 0 }],
      ['fractional timeout', { timeoutMs: 1.5 }],
      ['no reply cap', { maxReplyBytes: 0 }],
    ];
    for (const [name, overrides] of bad) assert.throws(() => createChatRewriteProvider(config(transport, overrides)), Error, name);
  });

  test('the pipeline chat limits match the shared vectors', () => {
    const { identifierPattern, ...numbers } = vectors.pipelineLimits;
    const { identifier, ...ours } = PIPELINE_CHAT_LIMITS;
    assert.deepEqual(ours, numbers);
    assert.equal(identifier.source, identifierPattern);
  });

  test('a fixture route must fit the pipeline chat view, so nothing is refused after dispatch', () => {
    const { transport } = fakeTransport(async () => baseReply('x'));
    const steeringRoom = PIPELINE_CHAT_LIMITS.systemChars - REWRITE_RULE.length;
    const fitting = { ...PIPELINE_FIXTURE_ROUTE, limits: { transcriptBytes: 16_000, steeringBytes: steeringRoom, draftBytes: 1024 } };
    assert.doesNotThrow(() => createChatRewriteProvider(config(transport, { route: fitting, maxTokens: 8192 })), 'exactly at every limit');
    const over: [string, Partial<ChatRewriteConfig>][] = [
      ['transcript', { route: { ...fitting, limits: { ...fitting.limits, transcriptBytes: 16_001 } } }],
      ['steering', { route: { ...fitting, limits: { ...fitting.limits, steeringBytes: steeringRoom + 1 } } }],
      ['tokens', { route: fitting, maxTokens: 8193 }],
      ['model with a slash', { route: { ...fitting, identity: 'synthetic/writing' } }],
    ];
    for (const [name, overrides] of over) assert.throws(() => createChatRewriteProvider(config(transport, overrides)), Error, name);
    // A base route is not bound by the pipeline's limits.
    assert.doesNotThrow(() => createChatRewriteProvider(config(transport, { route: { ...BASE_ROUTE, identity: 'example/base-model' }, maxTokens: 8193 })));
  });

  test('only route card 07 reaches the adapter, and only behind main\'s switch', () => {
    // synthetic.ts registers it only when given a transport; main.ts creates one only behind the switch.
    const main = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
    assert.equal(main.match(/createLoopbackTransport\(/g)?.length, 1);
    assert.match(main, /baseRewriteEnabled\(process\.env\) \? createLoopbackTransport\(\{ port: BASE_REWRITE_PORT \}\) : undefined/);
    const ipc = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(ipc, /chatRewrite|loopbackHttp/);
  });
});
