/**
 * What the Inspect step says about one unknown outcome (the local base rewrite route; the
 * interaction design: an unknown outcome shows Inspect, never a retry that
 * bypasses it). Pure, so the wording is tested apart from the UI, like
 * sendConsent.ts. It states what is known (when the app began sending what,
 * to which route, and that the reply was not applied), what is not (whether it
 * arrived, whether the service replied, and that it may keep a copy), and that
 * nothing is resent automatically. "Began sending", not "sent": main knows only
 * that it accepted the job and handed it to the route; a timeout can fire after
 * that and before the request is out, and that is an unknown outcome too.
 */
import type { OutcomeReport } from '../contracts/session.ts';

/** The route facts Inspect names, from main's published routes. */
export interface InspectRoute {
  readonly routeKey: string;
  readonly label: string;
  readonly identity: string;
  readonly locationClass: string;
}

export interface InspectFacts {
  readonly jobId: string;
  /** What is known. */
  readonly known: readonly string[];
  /** What is not known. */
  readonly unknown: string;
  /** What happens next, and how this outcome can clear. */
  readonly next: readonly string[];
  readonly canAcknowledge: boolean;
  /** Names this outcome on its Acknowledge button when there are several. */
  readonly name: string;
}

export interface TimeFormat {
  readonly locale?: string;
  readonly timeZone?: string;
}

/** The time, plus the date when it was not today. */
export function formatSentAt(sentAt: number, now: number, format: TimeFormat = {}): string {
  const { locale, timeZone } = format;
  const day = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric', timeZone });
  const sameDay = day.format(sentAt) === day.format(now);
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: 'numeric', minute: '2-digit', timeZone }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone };
  return new Intl.DateTimeFormat(locale, options).format(sentAt);
}

export const NOTHING_RESENT = 'Nothing will be sent again automatically.';
export const ACKNOWLEDGE_LINE = 'Acknowledge to resume. New rewrites and transcriptions can then start, each only when you ask.';
export const RESTART_LINE = 'This route can’t be cleared here. Quit and reopen Xenon Writing to resume.';
/** For an unknown outcome this session holds without main's report (a contract fault): nothing here can clear it. */
export const MISSING_DETAILS = 'An earlier outcome is unknown, but its details did not arrive. Nothing will be sent again automatically. Quit and reopen Xenon Writing to resume.';

export function inspectFacts(outcome: OutcomeReport, routes: readonly InspectRoute[], now: number, format: TimeFormat = {}): InspectFacts {
  const route = routes.find((r) => r.routeKey === outcome.routeKey);
  const label = route?.label ?? outcome.routeKey;
  const where = route === undefined ? label : `${label}: the model ${route.identity}`;
  // Main stamps 0 when its clock gave no usable time: then say no time rather than 1970.
  const time = outcome.sentAt > 0 ? formatSentAt(outcome.sentAt, now, format) : null;
  const rewrite = outcome.kind === 'rewrite';
  const what = rewrite ? 'your transcript and steering' : 'your audio';
  const inside = route?.locationClass === 'synthetic';
  const canAcknowledge = outcome.clearance === 'acknowledge';
  const job = rewrite ? 'rewrite' : 'transcription';
  return {
    jobId: outcome.jobId,
    known: [`${time === null ? 'Earlier' : `At ${time}`}, Xenon Writing began sending ${what} to ${where}.`, 'Its reply, if one came, was not applied.'],
    unknown: inside
      ? 'What became of it. The fixture runs inside this app, so nothing left it.'
      : `Whether ${rewrite ? 'they' : 'it'} arrived, and whether ${label} produced a reply. It may have, and it may keep a copy of what it received.`,
    next: [NOTHING_RESENT, canAcknowledge ? ACKNOWLEDGE_LINE : RESTART_LINE],
    canAcknowledge,
    name: time === null ? `the earlier ${job}` : `the ${job} started at ${time}`,
  };
}
