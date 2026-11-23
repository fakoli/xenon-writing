// Synthetic reducer tests for Packet E2: one transcription at a time and the
// Replace/Keep transcript candidate (interaction design). Fictional text only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_VERSION, FIXTURE_LIMITS } from '../../src/contracts/session.ts';
import type { MainEvent, RouteDescriptor, TranscribeSucceeded } from '../../src/contracts/session.ts';
import {
  createSession,
  phase,
  reduce,
  rewriteBlocker,
  transcribeBlocker,
  transcribeRequest,
} from '../../src/renderer/session.ts';
import type { SessionAction, SessionState } from '../../src/renderer/session.ts';

const REWRITE: RouteDescriptor = { routeKey: 'fixture-rewrite', mode: 'fixture', identity: 'fixture-v1', limits: FIXTURE_LIMITS };
const ASR: RouteDescriptor = { routeKey: 'fixture-transcribe', mode: 'fixture', identity: 'fixture-asr-v1', limits: FIXTURE_LIMITS };
const ENVELOPE = { v: CONTRACT_VERSION, sessionId: 's1', epoch: 1 } as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function run(state: SessionState, ...actions: SessionAction[]): SessionState {
  return actions.reduce((s, a) => deepFreeze(reduce(s, a)), deepFreeze(state));
}

/** A session with audio "a1" already chosen. */
const fresh = (asr: RouteDescriptor | null = ASR) =>
  run(createSession({ sessionId: 's1', epoch: 1, route: REWRITE, transcribeRoute: asr }), { type: 'audio.chosen', assetToken: 'a1' });
const edit = (text: string): SessionAction => ({ type: 'edit.transcript', text });
const transcribe = (clientRequestId = 't1', assetToken = 'a1'): SessionAction => ({ type: 'transcribe.request', clientRequestId, assetToken });

function pendingOf(state: SessionState) {
  assert.ok(state.transcription, 'expected a transcription in flight');
  return state.transcription;
}

function accepted(state: SessionState, jobId = 'tj1'): MainEvent {
  const t = pendingOf(state);
  return { ...ENVELOPE, type: 'transcribe.accepted', clientRequestId: t.clientRequestId, jobId, sourceRevision: t.sourceRevision };
}

function heard(state: SessionState, overrides: Partial<TranscribeSucceeded> = {}): MainEvent {
  const t = pendingOf(state);
  return { ...ENVELOPE, type: 'transcribe.succeeded', clientRequestId: t.clientRequestId, jobId: t.jobId ?? 'tj1',
    sourceRevision: t.sourceRevision, actualMode: 'fixture', actualIdentity: 'fixture-asr-v1', text: 'Meet at noon.', ...overrides };
}

function failed(state: SessionState, code: string): MainEvent {
  const t = pendingOf(state);
  return { ...ENVELOPE, type: 'transcribe.failed', clientRequestId: t.clientRequestId, jobId: t.jobId, code } as MainEvent;
}

describe('transcription into an empty editor', () => {
  test('fills the transcript directly and bumps the revision', () => {
    let s = run(fresh(), transcribe());
    assert.equal(phase(s), 'pending');
    assert.deepEqual(transcribeRequest(s), { ...ENVELOPE, clientRequestId: 't1', routeKey: 'fixture-transcribe', assetToken: 'a1', sourceRevision: 0 });
    s = run(s, accepted(s));
    s = run(s, heard(s));
    assert.equal(s.transcript, 'Meet at noon.');
    assert.equal(s.sourceRevision, 1);
    assert.equal(s.transcription, null);
    assert.equal(s.candidate, null);
    assert.equal(phase(s), 'editing');
  });
});

describe('transcription over existing text', () => {
  test('becomes a candidate; Replace swaps it in, Keep leaves the text alone', () => {
    let s = run(fresh(), edit('Meet on Thursday.'), transcribe());
    s = run(s, heard(s));
    assert.equal(s.transcript, 'Meet on Thursday.', 'nothing replaced without confirmation');
    assert.deepEqual(s.candidate, { jobId: 'tj1', assetToken: 'a1', text: 'Meet at noon.', mode: 'fixture', identity: 'fixture-asr-v1', sourceRevision: 1 });
    assert.equal(transcribeBlocker(s), 'candidate_open');
    const replaced = run({ ...s, notice: 'timed_out' }, { type: 'candidate.replace' });
    assert.equal(replaced.notice, null, 'replacing clears an old notice');
    assert.equal(replaced.transcript, 'Meet at noon.');
    assert.equal(replaced.sourceRevision, 2);
    assert.equal(replaced.candidate, null);
    const kept = run(s, { type: 'candidate.keep' });
    assert.equal(kept.transcript, 'Meet on Thursday.');
    assert.equal(kept.sourceRevision, 1);
    assert.equal(kept.candidate, null);
    assert.equal(run(kept, { type: 'candidate.replace' }), kept, 'no candidate, no change');
  });

  test('typing while a candidate waits keeps the typing and drops the candidate', () => {
    let s = run(fresh(), edit('Meet on Thursday.'), transcribe());
    s = run(s, heard(s), edit('Meet on Friday.'));
    assert.equal(s.transcript, 'Meet on Friday.');
    assert.equal(s.candidate, null);
    assert.equal(s.notice, 'result_outdated');
  });

  test('confirming a replacement outdates a rewrite already in flight', () => {
    let s = run(fresh(), edit('Meet on Thursday.'), transcribe());
    s = run(s, heard(s), { type: 'rewrite.request', clientRequestId: 'r1' }, { type: 'candidate.replace' });
    assert.ok(s.pending);
    const late: MainEvent = { ...ENVELOPE, type: 'rewrite.succeeded', clientRequestId: 'r1', jobId: 'j1', sourceRevision: 1,
      steeringRevision: 0, actualMode: 'fixture', actualIdentity: 'fixture-v1', text: 'Meet on Thursday.', draftHandle: 'd1' };
    s = run(s, late);
    assert.equal(s.draft, null);
    assert.equal(s.notice, 'result_outdated');
    assert.equal(s.transcript, 'Meet at noon.');
  });
});

describe('choosing other audio', () => {
  test('abandons a transcription of the old audio, which then can never land', () => {
    let s = run(fresh(), transcribe());
    s = run(s, accepted(s), { type: 'audio.chosen', assetToken: 'a2' });
    assert.equal(s.transcription, null);
    assert.equal(s.notice, 'result_outdated');
    assert.deepEqual(s.abandoned, [{ kind: 'transcribe', clientRequestId: 't1', jobId: 'tj1' }]);
    const late: MainEvent = { ...ENVELOPE, type: 'transcribe.succeeded', clientRequestId: 't1', jobId: 'tj1', sourceRevision: 0,
      actualMode: 'fixture', actualIdentity: 'fixture-asr-v1', text: 'Meet at noon.' };
    s = run(s, late);
    assert.equal(s.transcript, '', 'the old audio’s text never fills the editor');
    assert.deepEqual(s.abandoned, []);
    assert.ok(run(s, transcribe('t2', 'a2')).transcription, 'the new audio can be transcribed');
  });

  test('drops a candidate from the old audio', () => {
    let s = run(fresh(), edit('Meet on Thursday.'), transcribe());
    s = run(s, heard(s), { type: 'audio.chosen', assetToken: 'a2' });
    assert.equal(s.candidate, null);
    assert.equal(s.notice, 'result_outdated');
    assert.equal(run(s, { type: 'candidate.replace' }).transcript, 'Meet on Thursday.');
  });

  test('only the chosen audio can be transcribed', () => {
    assert.equal(run(fresh(), transcribe('t1', 'a-stale')).transcription, null);
    const s = run(fresh(), transcribe());
    assert.equal(run(s, { type: 'audio.chosen', assetToken: 'a1' }), s, 'choosing the same audio again changes nothing');
  });

  test('whitespace already in the editor still needs Replace', () => {
    let s = run(fresh(), edit('\n  \n'), transcribe());
    s = run(s, heard(s));
    assert.equal(s.transcript, '\n  \n');
    assert.equal(s.candidate?.text, 'Meet at noon.');
  });
});

describe('stale and mismatched transcripts never overwrite anything', () => {
  test('an edit during transcription outdates the result', () => {
    let s = run(fresh(), edit('Meet on Thursday.'), transcribe(), edit('Meet on Friday.'));
    s = run(s, heard(s));
    assert.equal(s.transcript, 'Meet on Friday.');
    assert.equal(s.candidate, null);
    assert.equal(s.notice, 'result_outdated');
  });

  test('identity, echo, blank and oversize problems are reported and change no text', () => {
    const cases: [Partial<TranscribeSucceeded>, string][] = [
      [{ actualIdentity: 'fixture-asr-v2' }, 'provider_mismatch'],
      [{ actualMode: 'personalized' }, 'provider_mismatch'],
      [{ sourceRevision: 5 }, 'invalid_response'],
      [{ text: '   ' }, 'invalid_response'],
      [{ text: 'a'.repeat(FIXTURE_LIMITS.transcriptBytes + 1) }, 'invalid_response'],
    ];
    for (const [overrides, code] of cases) {
      let s = run(fresh(), transcribe());
      s = run(s, heard(s, overrides));
      assert.equal(s.notice, code, JSON.stringify(Object.keys(overrides)));
      assert.equal(s.transcript, '');
      assert.equal(s.transcription, null);
    }
  });

  test('rewrite events never settle a transcription, and transcription events never settle a rewrite', () => {
    let s = run(fresh(), transcribe('shared-id'));
    const crossed: MainEvent = { ...ENVELOPE, type: 'rewrite.failed', clientRequestId: 'shared-id', jobId: null, code: 'cancelled' };
    assert.equal(run(s, crossed), s);
    s = run(fresh(), edit('Meet at noon.'), { type: 'rewrite.request', clientRequestId: 'r1' });
    const other: MainEvent = { ...ENVELOPE, type: 'transcribe.failed', clientRequestId: 'r1', jobId: null, code: 'cancelled' };
    assert.equal(run(s, other), s);
    // A cancelled transcription waits for its own terminal, not a rewrite's.
    s = run(fresh(), transcribe('shared-id'), { type: 'transcribe.cancel', clientRequestId: 'shared-id' });
    assert.equal(run(s, crossed), s, 'a rewrite terminal cannot retire an abandoned transcription');
    assert.deepEqual(run(s, { ...ENVELOPE, type: 'transcribe.failed', clientRequestId: 'shared-id', jobId: null, code: 'cancelled' }).abandoned, []);
  });
});

describe('one processing job at a time', () => {
  test('a transcription blocks rewrites and a rewrite blocks transcriptions', () => {
    const transcribing = run(fresh(), edit('Meet at noon.'), transcribe());
    assert.equal(rewriteBlocker(transcribing), 'pending');
    assert.equal(run(transcribing, { type: 'rewrite.request', clientRequestId: 'r1' }), transcribing);
    const rewriting = run(fresh(), edit('Meet at noon.'), { type: 'rewrite.request', clientRequestId: 'r1' });
    assert.equal(transcribeBlocker(rewriting), 'pending');
    assert.equal(run(rewriting, transcribe()), rewriting);
  });

  test('requests need a route, tokens and a fresh request ID', () => {
    assert.equal(transcribeBlocker(fresh(null)), 'no_route');
    assert.equal(run(fresh(null), transcribe()).transcription, null);
    assert.equal(run(fresh(), transcribe('t1', '')).transcription, null, 'blank asset token');
    let s = run(fresh(), transcribe('t1'));
    s = run(s, heard(s));
    assert.equal(run(s, transcribe('t1')).transcription, null, 'request IDs are never reused');
  });
});

describe('cancellation and unknown outcomes', () => {
  test('cancel is local and immediate, and blocks until main reports the outcome', () => {
    let s = run(fresh(), edit('Meet on Thursday.'), transcribe());
    s = run(s, accepted(s), { type: 'transcribe.cancel', clientRequestId: 't1' });
    assert.equal(s.transcription, null);
    assert.equal(s.notice, 'cancelled');
    assert.deepEqual(s.abandoned, [{ kind: 'transcribe', clientRequestId: 't1', jobId: 'tj1' }]);
    assert.equal(transcribeBlocker(s), 'awaiting_cancellation');
    assert.equal(rewriteBlocker(s), 'awaiting_cancellation');
    const late: MainEvent = { ...ENVELOPE, type: 'transcribe.succeeded', clientRequestId: 't1', jobId: 'tj1', sourceRevision: 1,
      actualMode: 'fixture', actualIdentity: 'fixture-asr-v1', text: 'Meet at noon.' };
    s = run(s, late);
    assert.deepEqual(s.abandoned, []);
    assert.equal(s.transcript, 'Meet on Thursday.', 'a cancelled transcription never lands');
    assert.equal(s.candidate, null);
  });

  test('an unknown outcome gates both kinds until a transcribe reconcile clears it', () => {
    let s = run(fresh(), edit('Meet at noon.'), transcribe());
    s = run(s, accepted(s));
    s = run(s, failed(s, 'unknown_outcome'));
    assert.deepEqual(s.unresolved, [{ kind: 'transcribe', clientRequestId: 't1', jobId: 'tj1' }]);
    assert.equal(rewriteBlocker(s), 'unresolved_outcome');
    assert.equal(transcribeBlocker(s), 'unresolved_outcome');
    const wrongKind: MainEvent = { ...ENVELOPE, type: 'rewrite.reconciled', clientRequestId: 't1', jobId: 'tj1' };
    assert.equal(run(s, wrongKind), s, 'a rewrite reconcile cannot clear a transcription');
    s = run(s, { ...ENVELOPE, type: 'transcribe.reconciled', clientRequestId: 't1', jobId: 'tj1' });
    assert.deepEqual(s.unresolved, []);
    assert.equal(rewriteBlocker(s), null);
  });

  test('an abandoned transcription that reports an unknown outcome still gates new work', () => {
    let s = run(fresh(), transcribe());
    s = run(s, accepted(s), { type: 'transcribe.cancel', clientRequestId: 't1' });
    s = run(s, { ...ENVELOPE, type: 'transcribe.failed', clientRequestId: 't1', jobId: 'tj1', code: 'unknown_outcome' });
    assert.deepEqual(s.abandoned, []);
    assert.deepEqual(s.unresolved, [{ kind: 'transcribe', clientRequestId: 't1', jobId: 'tj1' }]);
    assert.equal(transcribeBlocker(s), 'unresolved_outcome');
  });

  test('an accepted event echoing the wrong revision is ignored', () => {
    const s = run(fresh(), transcribe());
    const wrong: MainEvent = { ...ENVELOPE, type: 'transcribe.accepted', clientRequestId: 't1', jobId: 'tj1', sourceRevision: 9 };
    assert.equal(run(s, wrong), s);
  });

  test('a known failure ends the attempt and allows a retry', () => {
    let s = run(fresh(), transcribe());
    s = run(s, failed(s, 'timed_out'));
    assert.equal(s.notice, 'timed_out');
    assert.equal(transcribeBlocker(s), null);
    assert.ok(run(s, transcribe('t2')).transcription);
  });
});
