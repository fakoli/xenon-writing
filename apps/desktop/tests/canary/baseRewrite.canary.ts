// The local base rewrite route's synthetic canary: one fictional, synthetic sentence through
// the real chat core, runner and loopback transport to the local base rewrite
// service at 127.0.0.1:30113, through the route's own transport, so the
// service must prove its identity before the body goes out. Opt-in and manual, never part of `npm test`
// (which runs only tests/**/*.test.ts): it sends nothing without `--send`.
//
//   node tests/canary/baseRewrite.canary.ts          # prints what it would send
//   node tests/canary/baseRewrite.canary.ts --send   # sends it once
//
// It prints the outcome code, or the draft with its identity and timing.
// Real samples are not allowed here: the route sends synthetic text only.
import { homedir } from 'node:os';

import type { FailureCode } from '../../src/contracts/session.ts';
import type { JobSink, ProviderSuccess } from '../../src/main/ipc.ts';
import { createJobRunner } from '../../src/main/jobs.ts';
import { BASE_REWRITE_PORT, BASE_REWRITE_ROUTE, BASE_REWRITE_SETTINGS, createBaseRewriteProvider, createBaseRewriteTransport } from '../../src/main/providers/baseRewriteRoute.ts';
import { chatRequestBody } from '../../src/main/providers/chatRewrite.ts';

const TRANSCRIPT = 'Synthetic note for the garden club: the plant swap moves to Saturday at ten, at the community hall.';
const STEERING = 'Synthetic test: use one short, friendly sentence.';

type Outcome = { ok: true; result: ProviderSuccess } | { ok: false; code: FailureCode };

function run(transcript: string): Promise<{ outcome: Outcome; ms: number }> {
  const provider = createBaseRewriteProvider(createBaseRewriteTransport(homedir()));
  const runner = createJobRunner({ routes: [BASE_REWRITE_ROUTE], providers: [provider] });
  const started = performance.now();
  return new Promise((resolve) => {
    const sink: JobSink = {
      succeeded: (result) => resolve({ outcome: { ok: true, result }, ms: Math.round(performance.now() - started) }),
      failed: (code) => resolve({ outcome: { ok: false, code }, ms: Math.round(performance.now() - started) }),
    };
    runner.submit({ jobId: globalThis.crypto.randomUUID(), route: BASE_REWRITE_ROUTE, transcript, steering: STEERING }, sink);
  });
}

if (!process.argv.includes('--send')) {
  console.log(`Would send to 127.0.0.1:${BASE_REWRITE_PORT}:`);
  console.log(JSON.stringify(chatRequestBody(BASE_REWRITE_ROUTE.identity, 1024, { transcript: TRANSCRIPT, steering: STEERING }), null, 2));
  console.log('Run with --send to send it once.');
} else {
  // The guard first: text without the marker must stop before anything is sent.
  const guarded = await run('Meet at noon.');
  console.log(`guard (no marker): ${guarded.outcome.ok ? 'SENT, which is wrong' : guarded.outcome.code} in ${guarded.ms} ms`);
  const { outcome, ms } = await run(TRANSCRIPT);
  if (outcome.ok) {
    console.log(`canary: ok in ${ms} ms, mode ${outcome.result.actualMode}, identity ${outcome.result.actualIdentity}`);
    console.log(`draft: ${outcome.result.text}`);
  } else {
    const ended = !(Date.now() < BASE_REWRITE_SETTINGS.allowedUntil);
    console.log(`canary: ${outcome.code} in ${ms} ms${ended ? ` (the allowance ended at ${new Date(BASE_REWRITE_SETTINGS.allowedUntil).toISOString()}; nothing was sent)` : ''}`);
  }
}
