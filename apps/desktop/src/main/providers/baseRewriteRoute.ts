/**
 * The local base rewrite route's card, compiled in: a rewrite on an mlx-lm server the
 * owner runs at 127.0.0.1:30113, under the synthetic-text-only exception: only
 * text that contains "synthetic" is sent, and only until the exception ends
 * (`BASE_REWRITE_SETTINGS.allowedUntil`, by this machine's clock). Real
 * samples need the owner's separate authorization.
 *
 * The destination, model, limits, timeout and identity file live here, in
 * main, and nowhere a renderer or a reply can change them. The environment
 * cannot change them either, with one exception: the identity file is found
 * under the home directory Electron reports, which on macOS follows
 * `CFFIXED_USER_HOME`. Whoever sets the app's environment runs as the owner
 * and could read the secret anyway: the app does not defend against the same user.
 * The environment can only turn this one route on, with the exact switch
 * below; it is off by default, and then the app stays offline with the
 * fixture routes. Its transport always checks the service's identity proof
 * before the transcript is sent (serverIdentity.ts).
 */
import type { PublishedRoute } from '../../contracts/ipc.ts';
import { createChatRewriteProvider } from './chatRewrite.ts';
import type { ChatRewriteProvider, ChatTransport } from './chatRewrite.ts';
import { readIdentitySecret } from './identityFile.ts';
import { createLoopbackTransport } from './loopbackHttp.ts';
import type { LoopbackConfig, ServerIdentityCheck } from './loopbackHttp.ts';

export const BASE_REWRITE_ROUTE: PublishedRoute = Object.freeze({
  routeKey: 'local-base-rewrite',
  stage: 'rewrite',
  mode: 'base',
  // The exact model string, sent and expected back (the Swift reference's model).
  identity: 'mlx-community/Qwen3-4B-Instruct-2507-4bit',
  label: 'Local base model (test text only)',
  locationClass: 'local',
  readiness: 'ready',
  // 1,024 tokens hold roughly 3–4 KB of English: these limits keep a rewrite within them.
  limits: Object.freeze({ transcriptBytes: 4_096, steeringBytes: 2_048, draftBytes: 8_192 }),
});

/** The card's only destination port, on 127.0.0.1. */
export const BASE_REWRITE_PORT = 30_113;

/**
 * The service's identity file, relative to the user's home directory (the
 * service writes it at each start), and how long the proof
 * may take once the connection opens: the service answers the headers at
 * once, so far less than the job timeout.
 */
export const BASE_REWRITE_IDENTITY = Object.freeze({
  // Written as segments: a path on the user's machine, not a file in this repository.
  file: ['voice', 'llm', 'identity', 'identity.json'].join('/'),
  proofTimeoutMs: 5_000,
});

export const BASE_REWRITE_SETTINGS = Object.freeze({
  maxTokens: 1_024,
  timeoutMs: 45_000,
  maxReplyBytes: 100_000,
  requireMarker: 'synthetic',
  // The owner renewed the synthetic-text-only exception until the end of
  // 2026-12-31, Pacific time. From then on every job is refused before it is
  // sent, until a reviewed change moves this date or retires the exception.
  allowedUntil: Date.parse('2027-01-01T08:00:00Z'),
});

/** The main-only switch. Only this exact name and value turn the route on. */
export const ROUTE_SWITCH = Object.freeze({ name: 'XENON_REWRITE_ROUTE', value: 'local-base-rewrite' });

export function baseRewriteEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[ROUTE_SWITCH.name] === ROUTE_SWITCH.value;
}

/**
 * The user may acknowledge this route's unknown outcomes (its card's choice) only
 * while the route accepts synthetic text alone (the threat model weighs why). Without
 * the marker, acknowledgment turns off and an unknown outcome waits for a restart.
 */
export function baseRewriteAcknowledgeable(settings: { readonly requireMarker?: string } = BASE_REWRITE_SETTINGS): boolean {
  return settings.requireMarker === 'synthetic';
}

/**
 * The local base rewrite route's only transport: 127.0.0.1 and the card's port, with the
 * identity proof required before every body. `homeDirectory` comes from
 * Electron (`app.getPath('home')`), never from a renderer.
 */
export function createBaseRewriteTransport(homeDirectory: string): ChatTransport {
  return createLoopbackTransport(baseRewriteTransportConfig(homeDirectory));
}

/** The transport's configuration, separate so tests can check it without a socket. */
export function baseRewriteTransportConfig(homeDirectory: string): LoopbackConfig & { readonly identity: ServerIdentityCheck } {
  const filePath = `${homeDirectory}/${BASE_REWRITE_IDENTITY.file}`;
  const expected = { model: BASE_REWRITE_ROUTE.identity, port: BASE_REWRITE_PORT };
  return {
    port: BASE_REWRITE_PORT,
    identity: { model: BASE_REWRITE_ROUTE.identity, proofTimeoutMs: BASE_REWRITE_IDENTITY.proofTimeoutMs, readSecret: () => readIdentitySecret(filePath, expected) },
  };
}

export function createBaseRewriteProvider(transport: ChatTransport, now: () => number = Date.now): ChatRewriteProvider {
  return createChatRewriteProvider({ route: BASE_REWRITE_ROUTE, ...BASE_REWRITE_SETTINGS, transport, now });
}
