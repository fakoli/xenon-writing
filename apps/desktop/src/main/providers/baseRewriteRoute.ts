/**
 * The local base rewrite route's card, compiled in: a rewrite on an mlx-lm server the
 * owner runs at 127.0.0.1:30113, under the synthetic-text-only exception
 * (nothing yet proves which process answers on that port, so only text that
 * contains "synthetic" is sent).
 *
 * The destination, model, limits and timeout live here, in main, and nowhere
 * a renderer, a reply or the environment can change them. The environment
 * can only turn this one route on, with the exact switch below; it is off by
 * default, and then the app stays offline with the fixture routes.
 */
import type { PublishedRoute } from '../../contracts/ipc.ts';
import { createChatRewriteProvider } from './chatRewrite.ts';
import type { ChatRewriteProvider, ChatTransport } from './chatRewrite.ts';

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

export const BASE_REWRITE_SETTINGS = Object.freeze({
  maxTokens: 1_024,
  timeoutMs: 45_000,
  maxReplyBytes: 100_000,
  requireMarker: 'synthetic',
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

export function createBaseRewriteProvider(transport: ChatTransport): ChatRewriteProvider {
  return createChatRewriteProvider({ route: BASE_REWRITE_ROUTE, ...BASE_REWRITE_SETTINGS, transport });
}
