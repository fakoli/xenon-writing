// Packet B part 2: which job a notice is about, so the shell words it right.
// Synthetic reducer runs only; fictional text.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_VERSION, FIXTURE_LIMITS } from '../../src/contracts/session.ts';
import type { RouteDescriptor } from '../../src/contracts/session.ts';
import { filledFromAudio, noticeKind } from '../../src/renderer/noticeKind.ts';
import { createSession, reduce } from '../../src/renderer/session.ts';
import type { JobKind, SessionAction, SessionState } from '../../src/renderer/session.ts';

const REWRITE: RouteDescriptor = { routeKey: 'fixture-rewrite', mode: 'fixture', identity: 'fixture-v1', limits: FIXTURE_LIMITS };
const ASR: RouteDescriptor = { routeKey: 'fixture-transcribe', mode: 'fixture', identity: 'fixture-asr-v1', limits: FIXTURE_LIMITS };
const ENVELOPE = { v: CONTRACT_VERSION, sessionId: 's1', epoch: 1 } as const;

/** Runs actions the way the shell does, tracking the notice kind alongside. */
function run(actions: SessionAction[], kind: JobKind = 'rewrite', start?: SessionState) {
  let state = start ?? createSession({ sessionId: 's1', epoch: 1, route: REWRITE, transcribeRoute: ASR });
  for (const action of actions) {
    const next = reduce(state, action);
    if (next !== state) kind = noticeKind(state, next, action, kind);
    state = next;
  }
  return { state, kind };
}

const withCandidate: SessionAction[] = [
  { type: 'edit.transcript', text: 'Meet at noon.' },
  { type: 'audio.chosen', assetToken: 'a1' },
  { type: 'transcribe.request', clientRequestId: 't1', assetToken: 'a1' },
  { ...ENVELOPE, type: 'transcribe.accepted', clientRequestId: 't1', jobId: 'j1', sourceRevision: 1 },
  { ...ENVELOPE, type: 'transcribe.succeeded', clientRequestId: 't1', jobId: 'j1', sourceRevision: 1, actualMode: 'fixture', actualIdentity: 'fixture-asr-v1', text: 'Meet at one.' },
];

test('a cancelled rewrite is worded as a rewrite, a cancelled transcription as a transcription', () => {
  const rewrite = run([{ type: 'edit.transcript', text: 'Hi.' }, { type: 'rewrite.request', clientRequestId: 'r1' }, { type: 'rewrite.cancel', clientRequestId: 'r1' }], 'transcribe');
  assert.equal(rewrite.state.notice, 'cancelled');
  assert.equal(rewrite.kind, 'rewrite');
  const asr = run([{ type: 'audio.chosen', assetToken: 'a1' }, { type: 'transcribe.request', clientRequestId: 't1', assetToken: 'a1' }, { type: 'transcribe.cancel', clientRequestId: 't1' }]);
  assert.equal(asr.state.notice, 'cancelled');
  assert.equal(asr.kind, 'transcribe');
});

test('typing over a waiting candidate is about the transcript, even after a rewrite started', () => {
  const opened = run(withCandidate);
  assert.notEqual(opened.state.candidate, null);
  // A rewrite runs while the candidate waits; then the user types over it.
  const later = run([{ type: 'rewrite.request', clientRequestId: 'r1' }, { type: 'rewrite.cancel', clientRequestId: 'r1' }, { type: 'edit.transcript', text: 'Meet at two.' }], opened.kind, opened.state);
  assert.equal(later.state.candidate, null);
  assert.equal(later.state.notice, 'result_outdated');
  assert.equal(later.kind, 'transcribe');
});

test('an unrelated action keeps the wording of a notice that is still shown', () => {
  const cancelled = run([{ type: 'edit.transcript', text: 'Hi.' }, { type: 'rewrite.request', clientRequestId: 'r1' }, { type: 'rewrite.cancel', clientRequestId: 'r1' }]);
  // Choosing audio changes the state but not the rewrite's notice.
  const after = run([{ type: 'audio.chosen', assetToken: 'a1' }], cancelled.kind, cancelled.state);
  assert.equal(after.state.notice, 'cancelled');
  assert.equal(after.kind, 'rewrite');
});

test('Keep closes the candidate without rewording an earlier notice', () => {
  const opened = run(withCandidate, 'rewrite');
  const kept = run([{ type: 'candidate.keep' }], 'rewrite', opened.state);
  assert.equal(kept.state.candidate, null);
  assert.equal(kept.kind, 'rewrite');
});

test('a stale rewrite after typing over a candidate is worded as a rewrite', () => {
  // A rewrite runs while a candidate waits; typing over the candidate is about the
  // transcript, then the rewrite comes back for the old text and is discarded.
  const opened = run(withCandidate);
  const rewriting = run([{ type: 'rewrite.request', clientRequestId: 'r1' }], opened.kind, opened.state);
  const typed = run([{ type: 'edit.transcript', text: 'Meet at two.' }], rewriting.kind, rewriting.state);
  assert.equal(typed.state.notice, 'result_outdated');
  assert.equal(typed.kind, 'transcribe');
  const req = typed.state.pending;
  assert.notEqual(req, null);
  const ids = { ...ENVELOPE, clientRequestId: 'r1', jobId: 'jr', sourceRevision: req!.sourceRevision, steeringRevision: req!.steeringRevision };
  const late = run(
    [
      { ...ids, type: 'rewrite.accepted' },
      { ...ids, type: 'rewrite.succeeded', actualMode: 'fixture', actualIdentity: 'fixture-v1', text: 'Meet at one, please.', draftHandle: 'd1' },
    ],
    typed.kind,
    typed.state,
  );
  assert.equal(late.state.notice, 'result_outdated');
  assert.equal(late.kind, 'rewrite');
});

test('choosing new audio during a transcription is worded as a transcription', () => {
  const started = run([{ type: 'audio.chosen', assetToken: 'a1' }, { type: 'transcribe.request', clientRequestId: 't1', assetToken: 'a1' }]);
  const swapped = run([{ type: 'audio.chosen', assetToken: 'a2' }], 'rewrite', started.state);
  assert.equal(swapped.state.notice, 'result_outdated');
  assert.equal(swapped.kind, 'transcribe');
});

test('filling an empty transcript from audio is detected, a candidate is not', () => {
  // No typed text first, so the transcription answers source revision 0.
  const steps = withCandidate.slice(1).map((a) => ('sourceRevision' in a ? { ...a, sourceRevision: 0 } : a)) as SessionAction[];
  let state = createSession({ sessionId: 's1', epoch: 1, route: REWRITE, transcribeRoute: ASR });
  let filled = false;
  for (const action of steps) {
    const next = reduce(state, action);
    filled = filledFromAudio(state, next);
    state = next;
  }
  assert.equal(state.transcript, 'Meet at one.');
  assert.equal(filled, true);
  let withText = createSession({ sessionId: 's1', epoch: 1, route: REWRITE, transcribeRoute: ASR });
  for (const action of withCandidate) {
    const next = reduce(withText, action);
    filled = filledFromAudio(withText, next);
    withText = next;
  }
  assert.notEqual(withText.candidate, null);
  assert.equal(filled, false);
});
