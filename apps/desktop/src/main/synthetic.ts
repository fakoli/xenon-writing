/**
 * Main's composition (Packet D, plus route card 07).
 *
 * Main's IPC handlers wired to the route policy, the job runner and the
 * providers. By default every route is an in-process fixture: a typed session
 * completes end to end and nothing leaves the process. Given a `baseRewrite`
 * transport (main turns it on only with route card 07's switch), the rewrite
 * route is the local base model instead, and the fixture rewrite route is not
 * registered, so there is no route to fall back to. Transcription stays the
 * fixture.
 */
import type { ClipboardPort, DesktopMain, SendToWindow } from './ipc.ts';
import { createDesktopMain } from './ipc.ts';
import type { Clock } from './jobs.ts';
import { createJobRunner, createTranscribeRunner } from './jobs.ts';
import type { AudioChooserPort } from './platform/media.ts';
import type { FixtureProvider, FixtureTranscriber } from './providers/fixture.ts';
import { createFixtureRewriteProvider, createFixtureTranscriber } from './providers/fixture.ts';
import { BASE_REWRITE_ROUTE, createBaseRewriteProvider } from './providers/baseRewriteRoute.ts';
import type { ChatTransport } from './providers/chatRewrite.ts';
import { FIXTURE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE, createRoutePolicy } from './routePolicy.ts';
import type { CapturePort, MicrophonePort } from './platform/capture.ts';
import type { IdSource } from './sessionRegistry.ts';

export interface SyntheticMainOptions {
  readonly send: SendToWindow;
  readonly clipboard: ClipboardPort;
  readonly clock?: Clock;
  readonly newId?: IdSource;
  readonly fixtureDelayMs?: number;
  readonly timeoutMs?: number;
  /** Platform audio chooser; without it, audio import is not offered. */
  readonly chooser?: AudioChooserPort;
  /** OS microphone permission and capture (Packet E); without both, recording is not offered. */
  readonly microphone?: MicrophonePort;
  readonly capture?: CapturePort;
  /** Route card 07's transport. When set, rewrites go to the local base model, not the fixture. */
  readonly baseRewrite?: ChatTransport;
}

export interface SyntheticMain {
  readonly main: DesktopMain;
  readonly fixture: FixtureProvider;
  readonly transcriber: FixtureTranscriber;
}

export function createSyntheticMain(options: SyntheticMainOptions): SyntheticMain {
  const base = options.baseRewrite === undefined ? null : createBaseRewriteProvider(options.baseRewrite);
  const policy = createRoutePolicy([base === null ? FIXTURE_REWRITE_ROUTE : BASE_REWRITE_ROUTE, FIXTURE_TRANSCRIBE_ROUTE]);
  const timing = { clock: options.clock, delayMs: options.fixtureDelayMs, timeoutMs: options.timeoutMs };
  const fixture = createFixtureRewriteProvider(timing);
  const transcriber = createFixtureTranscriber(timing);
  const jobs = createJobRunner({ routes: policy.routes, providers: [base ?? fixture], clock: options.clock });
  const transcribeJobs = createTranscribeRunner({ routes: policy.routes, providers: [transcriber], clock: options.clock });
  const main = createDesktopMain({
    policy,
    jobs,
    transcriber: transcribeJobs,
    chooser: options.chooser,
    microphone: options.microphone,
    capture: options.capture,
    clipboard: options.clipboard,
    send: options.send,
    newId: options.newId,
  });
  return { main, fixture, transcriber };
}
