// Synthetic unit tests for the Packet A session reducer. Fictional text only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_VERSION, FIXTURE_LIMITS, utf8ByteLength } from '../../src/contracts/session.ts';
import type { MainEvent, RewriteSucceeded, RouteDescriptor } from '../../src/contracts/session.ts';
import {
  copyEligibility,
  createSession,
  draftStatus,
  phase,
  reduce,
  rewriteBlocker,
  rewriteRequest,
} from '../../src/renderer/session.ts';
import type { SessionAction, SessionState } from '../../src/renderer/session.ts';

const ROUTE: RouteDescriptor = { routeKey: 'fixture-base', mode: 'fixture', identity: 'fixture-v1', limits: FIXTURE_LIMITS };
const ENVELOPE = { v: CONTRACT_VERSION, sessionId: 's1', epoch: 1 } as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Applies actions to frozen states, so any mutation by the reducer throws. */
function run(state: SessionState, ...actions: SessionAction[]): SessionState {
  return actions.reduce((s, a) => deepFreeze(reduce(s, a)), deepFreeze(state));
}

const fresh = (route: RouteDescriptor | null = ROUTE) => deepFreeze(createSession({ sessionId: 's1', epoch: 1, route }));
const edit = (text: string): SessionAction => ({ type: 'edit.transcript', text });
const steer = (text: string): SessionAction => ({ type: 'edit.steering', text });
const request = (clientRequestId = 'r1'): SessionAction => ({ type: 'rewrite.request', clientRequestId });
const cancel = (clientRequestId = 'r1'): SessionAction => ({ type: 'rewrite.cancel', clientRequestId });

function pendingOf(state: SessionState) {
  assert.ok(state.pending, 'expected an in-flight rewrite');
  return state.pending;
}

/** Event echoing the in-flight snapshot, as a well-behaved main would send it. */
function accepted(state: SessionState, jobId = 'j9'): MainEvent {
  const p = pendingOf(state);
  return { ...ENVELOPE, type: 'rewrite.accepted', clientRequestId: p.clientRequestId, jobId,
    sourceRevision: p.sourceRevision, steeringRevision: p.steeringRevision };
}

function succeeded(state: SessionState, overrides: Partial<RewriteSucceeded> = {}): MainEvent {
  const p = pendingOf(state);
  return { ...ENVELOPE, type: 'rewrite.succeeded', clientRequestId: p.clientRequestId, jobId: p.jobId ?? 'j9',
    sourceRevision: p.sourceRevision, steeringRevision: p.steeringRevision, actualMode: 'fixture',
    actualIdentity: 'fixture-v1', text: 'Meet at noon.', draftHandle: 'd1', ...overrides };
}

function failed(state: SessionState, code: string): MainEvent {
  const p = pendingOf(state);
  return { ...ENVELOPE, type: 'rewrite.failed', clientRequestId: p.clientRequestId, jobId: p.jobId, code } as MainEvent;
}

/** A session whose current draft "Meet Thursday." came from request r1. */
function readyWithThursday(): SessionState {
  const pending = run(fresh(), edit('Meet Thursday.'), request('r1'));
  return run(pending, succeeded(pending, { text: 'Meet Thursday.', draftHandle: 'd-thu' }));
}

describe('idle → editing → pending → ready', () => {
  test('a typed fixture journey promotes only the matching reply', () => {
    let s = fresh();
    assert.equal(phase(s), 'idle');
    assert.equal(draftStatus(s), 'none');
    assert.equal(rewriteBlocker(s), 'empty_transcript');
    assert.equal(rewriteRequest(s), null);

    s = run(s, edit('Meet at noon.'), steer('Use one sentence.'));
    assert.equal(phase(s), 'editing');
    assert.equal(s.sourceRevision, 1);
    assert.equal(s.steeringRevision, 1);
    assert.equal(rewriteBlocker(s), null);

    s = run(s, request('r1'));
    assert.equal(phase(s), 'pending');
    assert.equal(rewriteBlocker(s), 'pending');
    assert.deepEqual(rewriteRequest(s), {
      v: 1, sessionId: 's1', epoch: 1, clientRequestId: 'r1', routeKey: 'fixture-base',
      sourceRevision: 1, steeringRevision: 1, transcript: 'Meet at noon.', steering: 'Use one sentence.',
    });

    s = run(s, accepted(s, 'j9'));
    assert.equal(s.pending?.jobId, 'j9');

    s = run(s, succeeded(s));
    assert.equal(phase(s), 'ready');
    assert.equal(s.pending, null);
    assert.equal(s.notice, null);
    assert.deepEqual(s.draft, {
      jobId: 'j9', draftHandle: 'd1', text: 'Meet at noon.', mode: 'fixture', identity: 'fixture-v1',
      sourceRevision: 1, steeringRevision: 1,
    });
    assert.equal(s.transcript, 'Meet at noon.', 'the draft never replaces the transcript');
  });

  test('a capture event never settles a pending rewrite', () => {
    const pending = run(fresh(), edit('Meet at noon.'), request());
    const ended = { v: CONTRACT_VERSION, sessionId: 's1', epoch: 1, type: 'capture.ended', captureHandle: 'c1', reason: 'revoked' } as const;
    assert.equal(reduce(pending, ended), pending);
  });

  test('a reply may arrive without a separate accepted event', () => {
    const pending = run(fresh(), edit('Meet at noon.'), request());
    assert.equal(phase(run(pending, succeeded(pending))), 'ready');
  });

  test('re-entering identical text does not bump the revision', () => {
    const s = run(fresh(), edit('Same.'), steer('Short.'));
    assert.equal(reduce(s, edit('Same.')), s);
    assert.equal(reduce(s, steer('Short.')), s);
  });

  test('empty steering is valid', () => {
    const s = run(fresh(), edit('Meet at noon.'));
    assert.equal(s.steering, '');
    assert.equal(rewriteBlocker(s), null);
  });
});

describe('edits while a rewrite is in flight', () => {
  test('Thursday → Friday: a late reply never overwrites newer text or the previous draft', () => {
    let s = run(readyWithThursday(), edit('Meet Thursday at noon.'), request('r2'));
    const late = succeeded(s, { text: 'Meet Thursday at noon.', draftHandle: 'd-late' });
    s = run(s, edit('Meet Friday at noon.'));

    assert.equal(s.pending?.transcript, 'Meet Thursday at noon.', 'the request snapshot is frozen');
    assert.equal(rewriteRequest(s)?.transcript, 'Meet Thursday at noon.');

    s = run(s, late);
    assert.equal(s.transcript, 'Meet Friday at noon.');
    assert.equal(s.draft?.text, 'Meet Thursday.', 'previous draft survives');
    assert.equal(s.draft?.draftHandle, 'd-thu');
    assert.equal(s.notice, 'result_outdated');
    assert.equal(draftStatus(s), 'previous');
    assert.equal(rewriteBlocker(s), null, 'a deliberate new rewrite is allowed');
  });

  test('deleting the transcript mid-flight keeps the deletion and drops the reply', () => {
    let s = run(fresh(), edit('Meet at noon.'), request());
    const late = succeeded(s);
    s = run(s, edit(''));
    assert.equal(phase(s), 'pending');
    assert.equal(rewriteBlocker(s), 'pending');

    s = run(s, late);
    assert.equal(s.transcript, '');
    assert.equal(s.draft, null);
    assert.equal(s.notice, 'result_outdated');
    assert.equal(phase(s), 'idle');
    assert.equal(rewriteBlocker(s), 'empty_transcript');
  });

  test('changing steering alone makes the draft previous and outdates an in-flight reply', () => {
    const ready = readyWithThursday();
    let s = run(ready, steer('Be formal.'));
    assert.equal(s.sourceRevision, ready.sourceRevision, 'transcript revision unchanged');
    assert.equal(s.steeringRevision, ready.steeringRevision + 1);
    assert.equal(draftStatus(s), 'previous');
    assert.equal(phase(s), 'editing');

    s = run(s, request('r2'));
    const late = succeeded(s, { text: 'Please meet Thursday.' });
    s = run(s, steer('Be casual.'), late);
    assert.equal(s.draft?.text, 'Meet Thursday.');
    assert.equal(s.notice, 'result_outdated');
  });

  test('the previous draft is labeled previous during regeneration and survives failure', () => {
    let s = run(readyWithThursday(), request('r2'));
    assert.equal(draftStatus(s), 'previous');
    s = run(s, failed(s, 'timed_out'));
    assert.equal(s.notice, 'timed_out');
    assert.equal(s.draft?.text, 'Meet Thursday.');
    assert.equal(draftStatus(s), 'current', 'inputs did not change, so it is current again');
    assert.equal(rewriteBlocker(s), null, 'a known failure allows an explicit retry');
  });
});

describe('stale, duplicate and malformed events are ignored', () => {
  test('events for another session, epoch or contract version change nothing', () => {
    const s = run(fresh(), edit('Meet at noon.'), request());
    const ok = succeeded(s) as RewriteSucceeded;
    assert.equal(reduce(s, { ...ok, sessionId: 's2' }), s);
    assert.equal(reduce(s, { ...ok, epoch: 2 }), s);
    assert.equal(reduce(s, { ...ok, v: 2 } as unknown as MainEvent), s);
  });

  test('unknown requests, duplicate terminals and job ID mismatches change nothing', () => {
    let s = run(fresh(), edit('Meet at noon.'), request('r1'));
    assert.equal(reduce(s, { ...(succeeded(s) as RewriteSucceeded), clientRequestId: 'r-other' }), s);

    s = run(s, accepted(s, 'j9'));
    assert.equal(reduce(s, accepted(s, 'j9')), s, 'duplicate accepted');
    assert.equal(reduce(s, { ...(succeeded(s) as RewriteSucceeded), jobId: 'j-other' }), s);

    const terminal = succeeded(s);
    s = run(s, terminal);
    assert.equal(reduce(s, terminal), s, 'duplicate terminal');
    assert.equal(reduce(s, { ...ENVELOPE, type: 'rewrite.failed', clientRequestId: 'r1', jobId: 'j9', code: 'timed_out' }), s);
  });

  test('accepted with revisions that differ from the snapshot is ignored', () => {
    const s = run(fresh(), edit('Meet at noon.'), request());
    const event = { ...accepted(s), sourceRevision: 99 } as MainEvent;
    assert.equal(reduce(s, event), s);
  });

  test('a reply echoing the wrong revisions is invalid and not promoted', () => {
    let s = run(fresh(), edit('Meet at noon.'), request());
    s = run(s, succeeded(s, { steeringRevision: 7 }));
    assert.equal(s.draft, null);
    assert.equal(s.notice, 'invalid_response');
  });

  test('base or fixture output is never presented as a different identity', () => {
    for (const overrides of [
      { actualMode: 'personalized' as const },
      { actualMode: 'base' as const },
      { actualIdentity: 'fixture-v2' },
    ]) {
      let s = run(fresh(), edit('Meet at noon.'), request());
      s = run(s, succeeded(s, overrides));
      assert.equal(s.draft, null, JSON.stringify(overrides));
      assert.equal(s.notice, 'provider_mismatch');
    }
  });

  test('blank, oversized or handle-less replies are invalid', () => {
    const max = FIXTURE_LIMITS.draftBytes;
    for (const overrides of [{ text: '  \n' }, { text: 'x'.repeat(max + 1) }, { draftHandle: '' }]) {
      let s = run(fresh(), edit('Meet at noon.'), request());
      s = run(s, succeeded(s, overrides));
      assert.equal(s.draft, null);
      assert.equal(s.notice, 'invalid_response');
    }
    let s = run(fresh(), edit('Meet at noon.'), request());
    s = run(s, succeeded(s, { text: 'x'.repeat(max) }));
    assert.equal(utf8ByteLength(s.draft?.text ?? ''), max, 'exactly at the limit is accepted');
  });

  test('a route change mid-flight outdates the reply', () => {
    let s = run(fresh(), edit('Meet at noon.'), request());
    const late = succeeded(s);
    s = deepFreeze({ ...s, route: { ...ROUTE, identity: 'fixture-v2' } });
    s = run(s, late);
    assert.equal(s.draft, null);
    assert.equal(s.notice, 'result_outdated');
  });
});

describe('cancellation', () => {
  test('cancel returns to editing with edits and the previous draft intact', () => {
    let s = run(readyWithThursday(), edit('Meet Friday.'), request('r2'));
    s = run(s, accepted(s, 'j2'));
    const late = succeeded(s, { text: 'Meet Friday.', draftHandle: 'd-fri' });
    s = run(s, cancel('r2'));
    assert.equal(phase(s), 'editing');
    assert.equal(s.notice, 'cancelled');
    assert.equal(s.transcript, 'Meet Friday.');
    assert.equal(s.draft?.text, 'Meet Thursday.');
    assert.deepEqual(s.abandoned, [{ kind: 'rewrite', clientRequestId: 'r2', jobId: 'j2' }]);

    s = run(s, late);
    assert.equal(s.draft?.text, 'Meet Thursday.', 'a cancelled reply is never promoted');
    assert.equal(s.notice, 'cancelled');
    assert.deepEqual(s.abandoned, [], 'its terminal event retires it');
  });

  test('no new dispatch until main reports the cancelled job outcome', () => {
    let s = run(fresh(), edit('Meet at noon.'), request('r1'));
    s = run(s, accepted(s, 'j1'));
    const disposition = failed(s, 'cancelled');
    s = run(s, cancel('r1'));
    assert.equal(phase(s), 'editing', 'editing resumes immediately');
    assert.equal(rewriteBlocker(s), 'awaiting_cancellation');
    assert.equal(reduce(s, request('r2')), s);

    s = run(s, disposition);
    assert.deepEqual(s.abandoned, []);
    assert.equal(rewriteBlocker(s), null);
    assert.equal(run(s, request('r2')).pending?.clientRequestId, 'r2');
  });

  test('cancelling a terminal or unknown job is an idempotent no-op', () => {
    let s = run(fresh(), edit('Meet at noon.'), request('r1'));
    const once = run(s, cancel('r1'));
    assert.equal(reduce(once, cancel('r1')), once, 'second cancel');

    s = run(s, succeeded(s));
    assert.equal(reduce(s, cancel('r1')), s, 'after success');

    let f = run(fresh(), edit('Meet at noon.'), request('r1'));
    f = run(f, failed(f, 'route_unavailable'));
    assert.equal(reduce(f, cancel('r1')), f, 'after failure');

    const p = run(fresh(), edit('Meet at noon.'), request('r1'));
    assert.equal(reduce(p, cancel('r-other')), p, 'wrong request id');
  });

  test('a late unknown outcome for a cancelled job still gates new rewrites', () => {
    let s = run(fresh(), edit('Meet at noon.'), request('r1'));
    s = run(s, accepted(s, 'j1'));
    const unknown = failed(s, 'unknown_outcome');
    s = run(s, cancel('r1'), unknown);
    assert.deepEqual(s.unresolved, [{ kind: 'rewrite', clientRequestId: 'r1', jobId: 'j1' }]);
    assert.equal(rewriteBlocker(s), 'unresolved_outcome');
    assert.equal(s.notice, 'cancelled');
  });

  test('cancelling before acceptance records the job ID from a later accepted event', () => {
    let s = run(fresh(), edit('Meet at noon.'), request('r1'));
    const acc = accepted(s, 'j1');
    s = run(s, cancel('r1'), acc);
    assert.deepEqual(s.abandoned, [{ kind: 'rewrite', clientRequestId: 'r1', jobId: 'j1' }]);
    assert.equal(reduce(s, { ...ENVELOPE, type: 'rewrite.failed', clientRequestId: 'r1', jobId: 'j-x', code: 'unknown_outcome' }), s);
  });
});

describe('unknown outcomes', () => {
  test('block new rewrites until main reconciles them', () => {
    let s = run(fresh(), edit('Meet at noon.'), request('r1'));
    s = run(s, accepted(s, 'j1'));
    s = run(s, failed(s, 'unknown_outcome'));
    assert.equal(s.notice, 'unknown_outcome');
    assert.equal(rewriteBlocker(s), 'unresolved_outcome');
    assert.equal(reduce(s, request('r2')), s, 'no new dispatch while unresolved');

    const reconciled: MainEvent = { ...ENVELOPE, type: 'rewrite.reconciled', clientRequestId: 'r1', jobId: 'j1' };
    s = run(s, reconciled);
    assert.deepEqual(s.unresolved, []);
    assert.equal(rewriteBlocker(s), null);
    assert.equal(reduce(s, reconciled), s, 'duplicate reconciliation');
  });

  test('a reconciliation without a job ID still clears a gate whose job ID is known', () => {
    let s = run(fresh(), edit('Meet at noon.'), request('r1'));
    s = run(s, accepted(s, 'j1'));
    s = run(s, failed(s, 'unknown_outcome'));
    const conflicting: MainEvent = { ...ENVELOPE, type: 'rewrite.reconciled', clientRequestId: 'r1', jobId: 'j-other' };
    assert.equal(reduce(s, conflicting), s, 'a conflicting job ID is ignored');

    s = run(s, { ...ENVELOPE, type: 'rewrite.reconciled', clientRequestId: 'r1', jobId: null });
    assert.deepEqual(s.unresolved, []);
    assert.equal(rewriteBlocker(s), null);
  });

  test('an unrecognized failure code is treated as unknown, not completed', () => {
    let s = run(fresh(), edit('Meet at noon.'), request());
    s = run(s, failed(s, 'exploded'));
    assert.equal(s.notice, 'unknown_outcome');
    assert.equal(rewriteBlocker(s), 'unresolved_outcome');
  });
});

describe('copy eligibility', () => {
  test('follows the draft status and never changes state', () => {
    assert.deepEqual(copyEligibility(fresh()), { allowed: false, reason: 'no_draft' });

    const ready = readyWithThursday();
    assert.deepEqual(copyEligibility(ready),
      { allowed: true, draftHandle: 'd-thu', draftStatus: 'current', requiresConfirmation: false });

    const edited = run(ready, edit('Meet Friday.'));
    assert.deepEqual(copyEligibility(edited),
      { allowed: true, draftHandle: 'd-thu', draftStatus: 'previous', requiresConfirmation: true });

    const regenerating = run(ready, request('r2'));
    assert.equal(copyEligibility(regenerating).allowed, true);
    assert.equal((copyEligibility(regenerating) as { requiresConfirmation: boolean }).requiresConfirmation, true);
  });
});

describe('rewrite availability and fixture limits', () => {
  const limit = FIXTURE_LIMITS.transcriptBytes; // 16 KiB
  const euro = '€'; // 3 UTF-8 bytes, 1 UTF-16 unit
  const grin = '😀'; // 4 UTF-8 bytes, 2 UTF-16 units

  test('transcript limit counts UTF-8 bytes at max−1, max and max+1', () => {
    const base = euro.repeat(Math.floor(limit / 3)); // 16383 bytes
    assert.equal(utf8ByteLength(base), limit - 1);
    assert.equal(rewriteBlocker(run(fresh(), edit(base))), null);
    assert.equal(rewriteBlocker(run(fresh(), edit(base + 'a'))), null);
    assert.equal(rewriteBlocker(run(fresh(), edit(base + 'ab'))), 'transcript_too_large');

    const emoji = grin.repeat(limit / 4);
    assert.equal(emoji.length, limit / 2, 'UTF-16 length is half the byte count');
    assert.equal(rewriteBlocker(run(fresh(), edit(emoji))), null);
    assert.equal(rewriteBlocker(run(fresh(), edit(emoji + 'a'))), 'transcript_too_large');
  });

  test('steering limit is enforced at max and max+1', () => {
    const max = 'a'.repeat(FIXTURE_LIMITS.steeringBytes);
    assert.equal(rewriteBlocker(run(fresh(), edit('Meet.'), steer(max))), null);
    assert.equal(rewriteBlocker(run(fresh(), edit('Meet.'), steer(max + 'a'))), 'steering_too_large');
  });

  test('whitespace-only transcripts cannot be rewritten', () => {
    for (const text of [' ', '\n\t  ', '　']) {
      const s = run(fresh(), edit(text));
      assert.equal(rewriteBlocker(s), 'empty_transcript', JSON.stringify(text));
      assert.equal(reduce(s, request()), s);
    }
  });

  test('requests are ignored with no route, a blank ID or a reused ID', () => {
    const noRoute = run(fresh(null), edit('Meet.'));
    assert.equal(rewriteBlocker(noRoute), 'no_route');
    assert.equal(reduce(noRoute, request()), noRoute);

    const s = run(fresh(), edit('Meet.'));
    assert.equal(reduce(s, request('')), s);
    assert.equal(reduce(s, request('x'.repeat(129))), s);

    let cancelled = run(s, request('r1'));
    const disposition = failed(cancelled, 'cancelled');
    cancelled = run(cancelled, cancel('r1'), disposition);
    assert.equal(reduce(cancelled, request('r1')), cancelled, 'a cancelled ID is not reused');
    assert.equal(run(cancelled, request('r2')).pending?.clientRequestId, 'r2');
  });

  test('a completed request ID cannot be reused, so a replayed reply cannot complete a new request', () => {
    let s = run(fresh(), edit('Meet at noon.'), request('r1'));
    const original = succeeded(s, { draftHandle: 'd1' });
    s = run(s, original);
    assert.equal(reduce(s, request('r1')), s, 'completed ID refused');

    s = run(s, request('r2'));
    s = run(s, original);
    assert.equal(s.pending?.clientRequestId, 'r2', 'the replay did not settle the new request');
    assert.equal(s.draft?.draftHandle, 'd1');
  });
});
