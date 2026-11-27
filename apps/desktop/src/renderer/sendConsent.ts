/**
 * The first-send consent rule (the local base rewrite route): before text first leaves the
 * app in a session, the user confirms where it goes. Pure, so it is tested
 * apart from the UI, like recording.ts.
 */
import type { RouteDescriptor } from '../contracts/session.ts';
import type { RewriteBlocker } from './session.ts';

/** A route that leaves the app (anything but the in-process fixture) asks once per session. */
export function needsSendConfirmation(route: RouteDescriptor | null, consented: boolean): boolean {
  return route !== null && route.mode !== 'fixture' && !consented;
}

/**
 * Whether Send may record consent and send now. A blocker (an empty or
 * oversized transcript, a running job, an unknown outcome) keeps the
 * confirmation open: consent is not recorded for a send that cannot happen.
 */
export function canConfirmSend(blocker: RewriteBlocker | null): boolean {
  return blocker === null;
}

/** Where the text goes, in words, from the route's location class. */
export function destinationText(locationClass: string | undefined): string {
  if (locationClass === 'local') return 'a separate service on this Mac';
  if (locationClass === 'remote') return 'a service outside this Mac';
  return 'a service outside this app';
}
