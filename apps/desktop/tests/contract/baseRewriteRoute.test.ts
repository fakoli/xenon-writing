// Route card 07 wired into main's composition, against a fake transport:
// nothing here opens a socket. Fictional, synthetic text only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { MainEvent } from '../../src/contracts/session.ts';
import type { SessionOpened } from '../../src/contracts/ipc.ts';
import { ProviderFailure } from '../../src/main/jobs.ts';
import type { ProviderControl } from '../../src/main/jobs.ts';
import {
  BASE_REWRITE_PORT,
  BASE_REWRITE_ROUTE,
  BASE_REWRITE_SETTINGS,
  ROUTE_SWITCH,
  baseRewriteEnabled,
  createBaseRewriteProvider,
} from '../../src/main/providers/baseRewriteRoute.ts';
import { NotSent } from '../../src/main/providers/chatRewrite.ts';
import type { ChatReply, ChatRequest, ChatTransport } from '../../src/main/providers/chatRewrite.ts';
import { FIXTURE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE, createRoutePolicy } from '../../src/main/routePolicy.ts';
import { createSyntheticMain } from '../../src/main/synthetic.ts';
import type { Caller } from '../../src/main/sessionRegistry.ts';
import { createDesktopApi } from '../../src/preload/desktop.ts';
import type { PreloadTransport } from '../../src/preload/desktop.ts';
import { createSession, reduce, rewriteRequest } from '../../src/renderer/session.ts';
import type { SessionState } from '../../src/renderer/session.ts';
import { settle } from '../fixtures/clock.ts';

const MODEL = BASE_REWRITE_ROUTE.identity;

function reply(content: string, model = MODEL): ChatReply {
  const body = JSON.stringify({ object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(body) };
}

function fakeTransport(answer: () => Promise<ChatReply>) {
  const requests: ChatRequest[] = [];
  const transport: ChatTransport = {
    send(request) {
      requests.push(request);
      return answer();
    },
  };
  return { transport, requests };
}

const TRUSTED_URL = 'file:///app/renderer/index.html';
const caller: Caller = { windowId: 1, frameUrl: TRUSTED_URL, isTopFrame: true };

/** Main with route card 07 on, through the preload façade and the reducer. */
function app(transport?: ChatTransport) {
  const sent: MainEvent[] = [];
  const listeners = new Set<(event: unknown) => void>();
  let next = 0;
  const { main, fixture } = createSyntheticMain({
    baseRewrite: transport,
    newId: () => `3f2a9c1e-0b7d-4e55-9a1c-${String(++next).padStart(12, '0')}`,
    clipboard: { writeText: () => {} },
    send: (_windowId, _channel, event) => {
      sent.push(event as MainEvent);
      listeners.forEach((listener) => listener(structuredClone(event)));
    },
  });
  main.registerWindow(1, TRUSTED_URL);
  const preload: PreloadTransport = {
    invoke: async (channel, payload) => main.handle(channel, caller, structuredClone(payload)),
    subscribe: (_channel, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const api = createDesktopApi(preload);
  const state: { current: SessionState | null } = { current: null };
  api.onEvent((event) => {
    if (state.current !== null) state.current = reduce(state.current, event);
  });
  async function start(): Promise<SessionOpened> {
    const opened = await api.createSession();
    assert.ok(opened.ok);
    const route = opened.value.capabilities.routes.find((r) => r.stage === 'rewrite') ?? null;
    state.current = createSession({ sessionId: opened.value.sessionId, epoch: opened.value.epoch, route });
    return opened.value;
  }
  const s = () => {
    assert.ok(state.current);
    return state.current;
  };
  async function rewrite(transcript: string) {
    state.current = reduce(s(), { type: 'edit.transcript', text: transcript });
    state.current = reduce(s(), { type: 'rewrite.request', clientRequestId: `r${++next}` });
    const request = rewriteRequest(s());
    assert.ok(request, 'the reducer allowed the request');
    const result = await api.rewrite(request);
    await settle();
    await settle();
    return result;
  }
  return { start, s, rewrite, sent, fixture };
}

describe('route card 07: the local base rewrite', () => {
  test('the compiled-in card is valid, labelled honestly, and pins the reference model and port', () => {
    assert.doesNotThrow(() => createRoutePolicy([BASE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE]));
    assert.equal(BASE_REWRITE_ROUTE.mode, 'base');
    assert.equal(BASE_REWRITE_ROUTE.locationClass, 'local');
    assert.match(BASE_REWRITE_ROUTE.label, /test text only/);
    // The same exact model and port as the Swift reference app's base rewrite client.
    assert.equal(MODEL, 'mlx-community/Qwen3-4B-Instruct-2507-4bit');
    assert.equal(BASE_REWRITE_PORT, 30113);
    assert.deepEqual({ ...BASE_REWRITE_SETTINGS }, { maxTokens: 1024, timeoutMs: 45_000, maxReplyBytes: 100_000, requireMarker: 'synthetic' });
    assert.deepEqual({ ...BASE_REWRITE_ROUTE.limits }, { transcriptBytes: 4_096, steeringBytes: 2_048, draftBytes: 8_192 }, 'the card 07 limits');
  });

  test('only the exact switch turns it on', () => {
    assert.equal(baseRewriteEnabled({}), false);
    assert.equal(baseRewriteEnabled({ [ROUTE_SWITCH.name]: 'local-base-rewrite' }), true);
    for (const value of ['', '1', 'true', 'LOCAL-BASE-REWRITE', ' local-base-rewrite', 'local-base-rewrite ', 'fixture-rewrite']) {
      assert.equal(baseRewriteEnabled({ [ROUTE_SWITCH.name]: value }), false, JSON.stringify(value));
    }
    assert.equal(baseRewriteEnabled({ XENON_REWRITE: 'local-base-rewrite' }), false);
  });

  test('a transcript without "synthetic" is unsupported before dispatch, in any case it is sent', async () => {
    const { transport, requests } = fakeTransport(async () => reply('Rewritten.'));
    const provider = createBaseRewriteProvider(transport);
    let dispatched = 0;
    const control: ProviderControl = { signal: new AbortController().signal, dispatched: () => void dispatched++ };
    await assert.rejects(
      provider.run({ jobId: 'job-1', transcript: 'Meet at noon.', steering: '' }, control),
      (e: unknown) => e instanceof ProviderFailure && e.code === 'unsupported',
    );
    assert.equal(dispatched, 0);
    assert.equal(requests.length, 0);
    await provider.run({ jobId: 'job-2', transcript: 'SYNTHETIC note: meet at noon.', steering: '' }, control);
    assert.equal(requests.length, 1);
  });

  test('steering is held to the same rule: empty, or containing "synthetic"', async () => {
    const { transport, requests } = fakeTransport(async () => reply('Rewritten.'));
    const provider = createBaseRewriteProvider(transport);
    const control: ProviderControl = { signal: new AbortController().signal, dispatched: () => {} };
    await assert.rejects(
      provider.run({ jobId: 'job-1', transcript: 'Synthetic note: meet at noon.', steering: 'Make it sound like my usual emails.' }, control),
      (e: unknown) => e instanceof ProviderFailure && e.code === 'unsupported',
    );
    assert.equal(requests.length, 0, 'unmarked steering is never sent');
    await provider.run({ jobId: 'job-2', transcript: 'Synthetic note: meet at noon.', steering: '' }, control);
    await provider.run({ jobId: 'job-3', transcript: 'Synthetic note: meet at noon.', steering: 'Synthetic test: use one sentence.' }, control);
    assert.equal(requests.length, 2);
  });

  test('switched on, main offers the base route instead of the fixture, and a rewrite goes through it once', async () => {
    const { transport, requests } = fakeTransport(async () => reply('Synthetic note: meet at noon, please.'));
    const a = app(transport);
    const opened = await a.start();
    const rewriteRoutes = opened.capabilities.routes.filter((r) => r.stage === 'rewrite');
    assert.deepEqual(rewriteRoutes.map((r) => r.routeKey), ['local-base-rewrite'], 'no fixture rewrite to fall back to');
    assert.ok(opened.capabilities.routes.some((r) => r.routeKey === FIXTURE_TRANSCRIBE_ROUTE.routeKey));
    assert.equal((await a.rewrite('Synthetic note: meet at noon.')).ok, true);
    assert.equal(requests.length, 1);
    const body = JSON.parse(new TextDecoder().decode(requests[0]?.body)) as { model: string; max_tokens: number };
    assert.equal(body.model, MODEL);
    assert.equal(body.max_tokens, 1024);
    assert.match(requests[0]?.headers['idempotency-key'] ?? '', /^3f2a9c1e-/);
    assert.equal(a.s().draft?.text, 'Synthetic note: meet at noon, please.');
    assert.equal(a.s().draft?.mode, 'base');
    assert.equal(a.s().draft?.identity, MODEL);
    assert.equal(a.fixture.calls, 0, 'the fixture never ran');
  });

  test('a stopped service is route_unavailable, with no fallback to the fixture', async () => {
    const { transport, requests } = fakeTransport(async () => {
      throw new NotSent();
    });
    const a = app(transport);
    await a.start();
    await a.rewrite('Synthetic note: meet at noon.');
    assert.equal(requests.length, 1);
    assert.equal(a.s().notice, 'route_unavailable');
    assert.equal(a.s().draft, null);
    assert.equal(a.fixture.calls, 0);
  });

  test('switched off (the default), main offers only the fixture routes', async () => {
    const a = app();
    const opened = await a.start();
    assert.deepEqual(
      opened.capabilities.routes.map((r) => r.routeKey).sort(),
      [FIXTURE_REWRITE_ROUTE.routeKey, FIXTURE_TRANSCRIBE_ROUTE.routeKey].sort(),
    );
  });
});
