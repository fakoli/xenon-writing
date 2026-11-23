/**
 * Main-process route policy (Packet C).
 *
 * The registry of routes main is allowed to use, configured at startup and
 * published to the renderer as descriptors. A route that is not registered is
 * denied before anything is dispatched; there is no discovery, fallback or
 * substitute destination. Only the synthetic fixture route exists by default.
 */
import { FIXTURE_LIMITS, ROUTE_MODES, isToken } from '../contracts/session.ts';
import type { FailureCode } from '../contracts/session.ts';
import { LOCATION_CLASSES, ROUTE_READINESS, ROUTE_STAGES, isPlainRecord } from '../contracts/ipc.ts';
import type { PublishedRoute, RouteStage } from '../contracts/ipc.ts';

/** Fixture rewrite route: the component design's fixture limits, labeled "synthetic". */
export const FIXTURE_REWRITE_ROUTE: PublishedRoute = Object.freeze({
  routeKey: 'fixture-rewrite',
  stage: 'rewrite',
  mode: 'fixture',
  identity: 'fixture-v1',
  label: 'Synthetic fixture',
  locationClass: 'synthetic',
  readiness: 'ready',
  limits: FIXTURE_LIMITS,
});

/** Fixture transcription route: returns fixed synthetic text, labeled "synthetic". */
export const FIXTURE_TRANSCRIBE_ROUTE: PublishedRoute = Object.freeze({
  routeKey: 'fixture-transcribe',
  stage: 'transcribe',
  mode: 'fixture',
  identity: 'fixture-asr-v1',
  label: 'Synthetic fixture',
  locationClass: 'synthetic',
  readiness: 'ready',
  limits: FIXTURE_LIMITS,
});

export type RouteResolution =
  | { readonly ok: true; readonly route: PublishedRoute }
  | { readonly ok: false; readonly code: FailureCode };

export interface RoutePolicy {
  /**
   * Resolves a renderer-supplied route key for one stage.
   * Unregistered → denied; registered for another stage → unsupported;
   * registered but disabled → route_unavailable.
   */
  resolve(stage: RouteStage, routeKey: string): RouteResolution;
  /** Every registered route, frozen, for capability responses. */
  readonly routes: readonly PublishedRoute[];
}

const ROUTE_FIELDS = ['routeKey', 'stage', 'mode', 'identity', 'label', 'locationClass', 'readiness', 'limits'];
const LIMIT_FIELDS = ['transcriptBytes', 'steeringBytes', 'draftBytes'];
const MAX_LABEL_LENGTH = 80;

function hasExactly(record: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === fields.length && fields.every((f) => Object.hasOwn(record, f));
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Returns a reason the route card is unusable, or null. */
function routeProblem(route: unknown): string | null {
  if (!isPlainRecord(route) || !hasExactly(route, ROUTE_FIELDS)) return 'unexpected or missing fields';
  const { routeKey, stage, mode, identity, label, locationClass, readiness, limits } = route;
  if (!isToken(routeKey) || !isToken(identity)) return 'route key and identity must be opaque tokens';
  if (!(ROUTE_STAGES as readonly unknown[]).includes(stage)) return 'unknown stage';
  if (!(ROUTE_MODES as readonly unknown[]).includes(mode)) return 'unknown mode';
  if (!(LOCATION_CLASSES as readonly unknown[]).includes(locationClass)) return 'unknown location class';
  if (!(ROUTE_READINESS as readonly unknown[]).includes(readiness)) return 'unknown readiness';
  if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL_LENGTH) return 'bad label';
  // Fixture output must say "synthetic", and nothing else may claim to be.
  const synthetic = mode === 'fixture';
  if (synthetic !== (locationClass === 'synthetic')) return 'only fixture routes are synthetic';
  if (synthetic !== /synthetic/i.test(label)) return 'only fixture labels say synthetic';
  if (!isPlainRecord(limits) || !hasExactly(limits, LIMIT_FIELDS)) return 'unexpected limit fields';
  if (!LIMIT_FIELDS.every((f) => isPositiveInteger(limits[f]))) return 'limits must be positive integers';
  return null;
}

/**
 * Builds the policy from route cards. Throws on any malformed or duplicate
 * card, so a misconfigured app fails at startup instead of routing loosely.
 */
export function createRoutePolicy(cards: readonly PublishedRoute[] = [FIXTURE_REWRITE_ROUTE]): RoutePolicy {
  const byKey = new Map<string, PublishedRoute>();
  for (const card of cards) {
    const problem = routeProblem(card);
    if (problem !== null) throw new Error(`Invalid route card: ${problem}`);
    if (byKey.has(card.routeKey)) throw new Error('Invalid route card: duplicate route key');
    byKey.set(card.routeKey, Object.freeze({ ...card, limits: Object.freeze({ ...card.limits }) }));
  }
  const routes = Object.freeze([...byKey.values()]);

  return Object.freeze({
    routes,
    resolve(stage: RouteStage, routeKey: string): RouteResolution {
      const route = byKey.get(routeKey);
      if (route === undefined) return { ok: false, code: 'denied' };
      if (route.stage !== stage) return { ok: false, code: 'unsupported' };
      if (route.readiness !== 'ready') return { ok: false, code: 'route_unavailable' };
      return { ok: true, route };
    },
  });
}
