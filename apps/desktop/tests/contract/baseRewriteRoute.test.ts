// The local base rewrite route wired into main's composition, against a fake transport:
// nothing here opens a socket. Fictional, synthetic text only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MainEvent } from '../../src/contracts/session.ts';
import type { SessionOpened } from '../../src/contracts/ipc.ts';
import { ProviderFailure } from '../../src/main/jobs.ts';
import type { ProviderControl } from '../../src/main/jobs.ts';
import {
  BASE_REWRITE_IDENTITY,
  BASE_REWRITE_PORT,
  BASE_REWRITE_ROUTE,
  BASE_REWRITE_SETTINGS,
  ROUTE_SWITCH,
  baseRewriteEnabled,
  baseRewriteTransportConfig,
  createBaseRewriteProvider,
} from '../../src/main/providers/baseRewriteRoute.ts';
import { IDENTITY_SCHEMA, base64url } from '../../src/main/providers/serverIdentity.ts';
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
/** The allowance's end: the end of 2026-12-31, Pacific time. Tests pin the clock before it. */
const ALLOWANCE_END = Date.parse('2027-01-01T08:00:00Z');
const BEFORE_END = Date.parse('2026-11-27T12:00:00Z');
const caller: Caller = { windowId: 1, frameUrl: TRUSTED_URL, isTopFrame: true };

/** Main with the local base rewrite route on, through the preload façade and the reducer. */
/** `now` null: no clock injected, as `main.ts` builds it. */
function app(transport?: ChatTransport, now: (() => number) | null = () => BEFORE_END) {
  const sent: MainEvent[] = [];
  const listeners = new Set<(event: unknown) => void>();
  let next = 0;
  const { main, fixture } = createSyntheticMain({
    baseRewrite: transport,
    now: now ?? undefined,
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

describe('the local base rewrite route', () => {
  test('the compiled-in card is valid, labelled honestly, and pins the reference model and port', () => {
    assert.doesNotThrow(() => createRoutePolicy([BASE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE]));
    assert.equal(BASE_REWRITE_ROUTE.mode, 'base');
    assert.equal(BASE_REWRITE_ROUTE.locationClass, 'local');
    assert.match(BASE_REWRITE_ROUTE.label, /test text only/);
    // The same exact model and port as the Swift reference app's base rewrite client.
    assert.equal(MODEL, 'mlx-community/Qwen3-4B-Instruct-2507-4bit');
    assert.equal(BASE_REWRITE_PORT, 30113);
    assert.deepEqual({ ...BASE_REWRITE_SETTINGS }, { maxTokens: 1024, timeoutMs: 45_000, maxReplyBytes: 100_000, requireMarker: 'synthetic', allowedUntil: ALLOWANCE_END });
    assert.equal(new Date(BASE_REWRITE_SETTINGS.allowedUntil).toISOString(), '2027-01-01T08:00:00.000Z', 'midnight at the end of 2026-12-31 in Pacific standard time');
    assert.deepEqual({ ...BASE_REWRITE_ROUTE.limits }, { transcriptBytes: 4_096, steeringBytes: 2_048, draftBytes: 8_192 }, "the card's limits");
  });

  test('its transport always requires the identity proof, from the compiled-in file under the home directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'xenon-home-'));
    try {
      for (const given of [home, `${home}/`]) {
        const config = baseRewriteTransportConfig(given);
        assert.equal(config.port, 30113);
        assert.equal(config.identity.model, MODEL);
        assert.equal(config.identity.proofTimeoutMs, 5_000);
        assert.ok(config.identity.proofTimeoutMs < BASE_REWRITE_SETTINGS.timeoutMs, 'the proof resolves well before the job timeout');
        await assert.rejects(config.identity.readSecret(), 'no file yet');
      }
      assert.equal(BASE_REWRITE_IDENTITY.file, ['voice', 'llm', 'identity', 'identity.json'].join('/'));
      const dir = join(home, 'voice', 'llm', 'identity');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const secret = Uint8Array.from({ length: 32 }, (_, i) => 3 * i);
      const file = join(dir, 'identity.json');
      writeFileSync(file, JSON.stringify({ schema: IDENTITY_SCHEMA, model: MODEL, port: 30113, secret: base64url(secret) }), { mode: 0o600 });
      assert.deepEqual(await baseRewriteTransportConfig(home).identity.readSecret(), secret);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    const main = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
    assert.match(main, /createBaseRewriteTransport\(app\.getPath\('home'\)\)/, 'main builds the route with the identity check');
    assert.doesNotMatch(main, /createLoopbackTransport/, 'and never a bare loopback transport');
    // No other source file may build a loopback transport, with or without the proof.
    const src = new URL('../../src/', import.meta.url).pathname;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
    const builders = walk(src).filter((file) => /createLoopbackTransport\(/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(src.length));
    assert.deepEqual(builders.sort(), ['main/providers/baseRewriteRoute.ts', 'main/providers/loopbackHttp.ts'], 'only the card builds one (and the transport defines it)');
    // An aliased import would slip past the name check: only the card may import the transport at all.
    const importers = walk(src).filter((file) => /from\s+'[^']*loopbackHttp\.ts'/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(src.length));
    assert.deepEqual(importers, ['main/providers/baseRewriteRoute.ts'], 'only the card imports the loopback transport');
    const card = readFileSync(new URL('../../src/main/providers/baseRewriteRoute.ts', import.meta.url), 'utf8');
    assert.equal(card.match(/createLoopbackTransport\(/g)?.length, 1, 'the card builds one transport');
    assert.match(card, /return createLoopbackTransport\(baseRewriteTransportConfig\(homeDirectory\)\);/, 'from this checked configuration');
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
    const provider = createBaseRewriteProvider(transport, () => BEFORE_END);
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
    const provider = createBaseRewriteProvider(transport, () => BEFORE_END);
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

  test('the allowance ends at a fixed instant, checked at every job: from then on nothing is sent', async () => {
    const { transport, requests } = fakeTransport(async () => reply('Rewritten.'));
    let now = ALLOWANCE_END - 1;
    const provider = createBaseRewriteProvider(transport, () => now);
    let dispatched = 0;
    const control: ProviderControl = { signal: new AbortController().signal, dispatched: () => void dispatched++ };
    await provider.run({ jobId: 'job-1', transcript: 'Synthetic note: meet at noon.', steering: '' }, control);
    assert.equal(requests.length, 1, 'sent up to the last millisecond');
    for (const [jobId, at] of [['job-2', ALLOWANCE_END], ['job-3', ALLOWANCE_END + 86_400_000]] as const) {
      now = at;
      await assert.rejects(
        provider.run({ jobId, transcript: 'Synthetic note: meet at noon.', steering: '' }, control),
        (e: unknown) => e instanceof ProviderFailure && e.code === 'route_unavailable',
        'the same provider, so an app left running past the end refuses too',
      );
    }
    assert.equal(dispatched, 1, 'refused before dispatch');
    assert.equal(requests.length, 1);
    assert.equal(provider.sends, 1);
  });

  test("main's clock reaches the route: past the end, a rewrite is route_unavailable and never sent", async () => {
    const { transport, requests } = fakeTransport(async () => reply('Synthetic note: meet at noon, please.'));
    const a = app(transport, () => ALLOWANCE_END);
    await a.start();
    assert.equal((await a.rewrite('Synthetic note: meet at noon.')).ok, true, 'accepted, then refused by the route');
    assert.equal(requests.length, 0);
    assert.equal(a.s().notice, 'route_unavailable');
    assert.equal(a.s().draft, null);
    assert.equal(a.fixture.calls, 0, 'no fallback');
  });

  test('without an injected clock (as main.ts builds it) the route reads the real one', async (t) => {
    const { transport, requests } = fakeTransport(async () => reply('Synthetic note: meet at noon, please.'));
    // Date alone is mocked, so only the wall clock moves; timers are untouched.
    t.mock.timers.enable({ apis: ['Date'], now: ALLOWANCE_END - 1 });
    const a = app(transport, null);
    await a.start();
    assert.equal((await a.rewrite('Synthetic note: meet at noon.')).ok, true);
    assert.equal(requests.length, 1, 'sent in the allowance’s last millisecond');
    assert.equal(a.s().draft?.text, 'Synthetic note: meet at noon, please.');
    t.mock.timers.setTime(ALLOWANCE_END);
    assert.equal((await a.rewrite('Synthetic note: meet at one.')).ok, true, 'accepted by main, then refused by the route');
    assert.equal(requests.length, 1, 'never sent once it ended');
    assert.equal(a.s().notice, 'route_unavailable');
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
