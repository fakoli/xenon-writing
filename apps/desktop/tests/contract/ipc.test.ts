// Synthetic contract tests for Packet C: main IPC handlers, session registry,
// route policy and the preload façade. Fictional text only; no Electron,
// network, clipboard or provider is used. Ports are in-memory fakes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { FIXTURE_LIMITS, utf8ByteLength } from '../../src/contracts/session.ts';
import type { FailureCode, MainEvent, RewriteAccepted } from '../../src/contracts/session.ts';
import { CHANNELS } from '../../src/contracts/ipc.ts';
import type { IpcResult, PublishedRoute, SessionOpened } from '../../src/contracts/ipc.ts';
import { callerFromElectronEvent, createDesktopMain } from '../../src/main/ipc.ts';
import type { JobSink, ProviderSuccess, RewriteJob } from '../../src/main/ipc.ts';
import { FIXTURE_REWRITE_ROUTE, createRoutePolicy } from '../../src/main/routePolicy.ts';
import type { RoutePolicy } from '../../src/main/routePolicy.ts';
import { MAX_DRAFT_HANDLES, MAX_REQUEST_RECORDS, createSessionRegistry } from '../../src/main/sessionRegistry.ts';
import type { Caller } from '../../src/main/sessionRegistry.ts';
import { createDesktopApi, filterEvent } from '../../src/preload/desktop.ts';
import type { PreloadTransport } from '../../src/preload/desktop.ts';
import { copyEligibility, createSession, reduce, rewriteRequest } from '../../src/renderer/session.ts';
import type { SessionState } from '../../src/renderer/session.ts';

const TRUSTED_URL = 'file:///app/renderer/index.html';
const FIXTURE_OK: ProviderSuccess = { actualMode: 'fixture', actualIdentity: 'fixture-v1', text: 'Meet on Thursday at noon.' };

interface Sent {
  readonly windowId: number;
  readonly channel: string;
  readonly event: MainEvent;
}

interface Submitted {
  readonly job: RewriteJob;
  readonly sink: JobSink;
}

function harness(options: { policy?: RoutePolicy; onSubmit?: (job: RewriteJob, sink: JobSink) => void } = {}) {
  const sent: Sent[] = [];
  const submitted: Submitted[] = [];
  const cancelled: string[] = [];
  const copied: string[] = [];
  let clipboardFails = false;
  let next = 0;
  const main = createDesktopMain({
    policy: options.policy ?? createRoutePolicy(),
    jobs: {
      submit(job, sink) {
        submitted.push({ job, sink });
        options.onSubmit?.(job, sink);
      },
      cancel(jobId) {
        cancelled.push(jobId);
      },
    },
    clipboard: {
      writeText(text) {
        if (clipboardFails) throw new Error('synthetic clipboard failure');
        copied.push(text);
      },
    },
    send: (windowId, channel, event) => sent.push({ windowId, channel, event }),
    newId: () => `id-${++next}`,
  });
  main.registerWindow(1, TRUSTED_URL);
  main.registerWindow(2, TRUSTED_URL);
  return {
    main,
    sent,
    submitted,
    cancelled,
    copied,
    failClipboard() {
      clipboardFails = true;
    },
    events: () => sent.map((s) => s.event),
  };
}
type Harness = ReturnType<typeof harness>;

const caller = (windowId = 1, overrides: Partial<Caller> = {}): Caller => ({
  windowId,
  frameUrl: TRUSTED_URL,
  isTopFrame: true,
  ...overrides,
});

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return (result as { value: T }).value;
}

function code(result: IpcResult<unknown>): FailureCode {
  assert.equal(result.ok, false, `expected a rejection, got ${JSON.stringify(result)}`);
  return (result as { code: FailureCode }).code;
}

function open(h: Harness, windowId = 1): SessionOpened {
  return value<SessionOpened>(h.main.handle(CHANNELS.createSession, caller(windowId), { v: 1 }));
}

function envelope(s: SessionOpened) {
  return { v: 1, sessionId: s.sessionId, epoch: s.epoch };
}

function body(s: SessionOpened, overrides: Record<string, unknown> = {}) {
  return {
    ...envelope(s),
    clientRequestId: 'r1',
    routeKey: 'fixture-rewrite',
    sourceRevision: 1,
    steeringRevision: 0,
    transcript: 'Meet on Thursday at noon.',
    steering: '',
    ...overrides,
  };
}

function rewrite(h: Harness, s: SessionOpened, overrides: Record<string, unknown> = {}, windowId = 1) {
  return h.main.handle(CHANNELS.rewrite, caller(windowId), body(s, overrides));
}

function lastSubmit(h: Harness): Submitted {
  const last = h.submitted.at(-1);
  assert.ok(last, 'expected a submitted job');
  return last;
}

/** Text of exactly `bytes` UTF-8 bytes, built from 3-byte "€" plus ASCII padding. */
function textOfBytes(bytes: number): string {
  const euros = '€'.repeat(Math.floor(bytes / 3));
  const text = euros + 'a'.repeat(bytes - utf8ByteLength(euros));
  assert.equal(utf8ByteLength(text), bytes);
  return text;
}

describe('trust and payload shape', () => {
  test('untrusted callers are denied and change nothing', () => {
    const h = harness();
    const untrusted: (Caller | null)[] = [
      null,
      caller(1, { isTopFrame: false }),
      caller(1, { frameUrl: 'https://example.invalid/index.html' }),
      caller(1, { frameUrl: `${TRUSTED_URL}?next=1` }),
      caller(99),
    ];
    for (const who of untrusted) {
      assert.equal(code(h.main.handle(CHANNELS.createSession, who, { v: 1 })), 'denied');
    }
    // Nothing was opened for window 1, so the first real session gets epoch 1.
    assert.equal(open(h).epoch, 1);
    // A fragment is ignored: same document.
    assert.equal(h.main.handle(CHANNELS.createSession, caller(2, { frameUrl: `${TRUSTED_URL}#top` }), { v: 1 }).ok, true);
  });

  test('unknown fields, missing fields and wrong types are rejected before dispatch', () => {
    const h = harness();
    const s = open(h);
    const bad: Record<string, unknown>[] = [
      { ...body(s), extra: 'x' },
      { ...body(s), routeUrl: 'https://example.invalid/' },
      (({ steering: _omit, ...rest }) => rest)(body(s)),
      body(s, { epoch: String(s.epoch) }),
      body(s, { sourceRevision: -1 }),
      body(s, { sourceRevision: 1.5 }),
      body(s, { transcript: 42 }),
      body(s, { clientRequestId: '' }),
      body(s, { clientRequestId: 'x'.repeat(129) }),
    ];
    for (const payload of bad) assert.equal(code(h.main.handle(CHANNELS.rewrite, caller(), payload)), 'invalid_input');
    assert.equal(h.submitted.length, 0);
    assert.equal(h.sent.length, 0);
  });

  test('non-plain payloads are rejected', () => {
    const h = harness();
    const s = open(h);
    class Payload {}
    const withGetter = { ...body(s) };
    Object.defineProperty(withGetter, 'transcript', { get: () => 'Meet at noon.', enumerable: true });
    const withSymbol = { ...body(s), [Symbol('x')]: 1 };
    const inherited = Object.assign(Object.create({ polluted: true }), body(s));
    for (const payload of [[body(s)], new Payload(), withGetter, withSymbol, inherited, 'text', null]) {
      assert.equal(code(h.main.handle(CHANNELS.rewrite, caller(), payload)), 'invalid_input');
    }
    assert.equal(h.submitted.length, 0);
  });

  test('other contract versions are unsupported and unknown channels are rejected', () => {
    const h = harness();
    assert.equal(code(h.main.handle(CHANNELS.createSession, caller(), { v: 2 })), 'unsupported');
    assert.equal(code(h.main.handle(CHANNELS.createSession, caller(), { v: '1' })), 'unsupported');
    const s = open(h);
    assert.equal(code(rewrite(h, s, { v: 2 })), 'unsupported');
    assert.equal(code(h.main.handle('xenon:v1:shell.open', caller(), { v: 1 })), 'unsupported');
    assert.equal(code(h.main.handle(CHANNELS.event, caller(), { v: 1 })), 'unsupported');
    assert.equal(h.submitted.length, 0);
  });

  test('Electron invoke events are normalized structurally', () => {
    const top = { url: TRUSTED_URL, parent: null };
    assert.deepEqual(callerFromElectronEvent({ sender: { id: 7 }, senderFrame: top }), caller(7));
    assert.equal(callerFromElectronEvent({ sender: { id: 7 }, senderFrame: { url: TRUSTED_URL, parent: top } })?.isTopFrame, false);
    assert.equal(callerFromElectronEvent({ sender: { id: 7 }, senderFrame: null }), null);
    assert.equal(callerFromElectronEvent({ sender: { id: '7' }, senderFrame: top }), null);
    const destroyed = { sender: { id: 7 }, get senderFrame(): never { throw new Error('frame destroyed'); } };
    assert.equal(callerFromElectronEvent(destroyed), null);
  });
});

describe('sessions and handles', () => {
  test('a new session replaces the old one, bumps the epoch and cancels its job', () => {
    const h = harness();
    const first = open(h);
    assert.equal(rewrite(h, first).ok, true);
    const second = open(h);
    assert.ok(second.epoch > first.epoch);
    assert.notEqual(second.sessionId, first.sessionId);
    assert.deepEqual(h.cancelled, [lastSubmit(h).job.jobId]);
    assert.equal(code(rewrite(h, first, { clientRequestId: 'r2' })), 'denied');
    assert.equal(code(h.main.handle(CHANNELS.getCapabilities, caller(), envelope(first))), 'denied');
    // The old job is still running until it reports, so the new session waits.
    assert.equal(code(rewrite(h, second)), 'denied');
    lastSubmit(h).sink.failed('cancelled');
    assert.equal(rewrite(h, second, { clientRequestId: 'r3' }).ok, true);
    assert.equal(h.submitted.length, 2);
  });

  test('a stale epoch or another window cannot use a session', () => {
    const h = harness();
    const s = open(h);
    open(h, 2);
    assert.equal(code(rewrite(h, s, { epoch: s.epoch + 1 })), 'denied');
    assert.equal(code(rewrite(h, s, {}, 2)), 'denied');
    assert.equal(h.submitted.length, 0);
  });

  test('draft handles and request IDs cannot cross windows or sessions', () => {
    const h = harness();
    const a = open(h, 1);
    const b = open(h, 2);
    rewrite(h, a);
    lastSubmit(h).sink.succeeded(FIXTURE_OK);
    const done = h.events().find((e) => e.type === 'rewrite.succeeded');
    assert.ok(done && done.type === 'rewrite.succeeded');

    const fromB = { ...envelope(b), draftHandle: done.draftHandle };
    assert.equal(code(h.main.handle(CHANNELS.copyDraft, caller(2), fromB)), 'denied');
    assert.equal(code(h.main.handle(CHANNELS.cancel, caller(2), { ...envelope(b), clientRequestId: 'r1' })), 'denied');
    assert.deepEqual(h.copied, []);

    // The owner can copy it.
    const fromA = { ...envelope(a), draftHandle: done.draftHandle };
    assert.deepEqual(value(h.main.handle(CHANNELS.copyDraft, caller(1), fromA)), { status: 'copied' });
    assert.deepEqual(h.copied, ['Meet on Thursday at noon.']);
  });

  test('closing a session revokes handles and drops late callbacks', () => {
    const h = harness();
    const s = open(h);
    rewrite(h, s);
    lastSubmit(h).sink.succeeded(FIXTURE_OK);
    const done = h.events().find((e) => e.type === 'rewrite.succeeded');
    assert.ok(done && done.type === 'rewrite.succeeded');
    rewrite(h, s, { clientRequestId: 'r2' });
    const running = lastSubmit(h);

    assert.deepEqual(value(h.main.handle(CHANNELS.closeSession, caller(), envelope(s))), { closed: true });
    assert.deepEqual(h.cancelled, [running.job.jobId]);
    const sentBefore = h.sent.length;
    running.sink.succeeded(FIXTURE_OK);
    assert.equal(h.sent.length, sentBefore, 'a closed session receives no callbacks');

    const reopened = open(h);
    const copy = { ...envelope(reopened), draftHandle: done.draftHandle };
    assert.equal(code(h.main.handle(CHANNELS.copyDraft, caller(), copy)), 'denied');
    assert.equal(code(h.main.handle(CHANNELS.closeSession, caller(), envelope(s))), 'denied');
  });

  test('an unknown outcome after close is not delivered but still gates the next session', () => {
    const h = harness();
    const s = open(h);
    const accepted = value<RewriteAccepted>(rewrite(h, s));
    const running = lastSubmit(h);
    h.main.handle(CHANNELS.closeSession, caller(), envelope(s));
    const sentBefore = h.sent.length;
    running.sink.failed('unknown_outcome');
    running.sink.failed('cancelled');
    assert.equal(h.sent.length, sentBefore);

    // A reload opens a new session; resending the same body must not dispatch.
    const reloaded = open(h);
    assert.deepEqual(reloaded.unresolved.map((o) => o.jobId), [accepted.jobId], 'the reload is told what holds it back');
    assert.equal(code(rewrite(h, reloaded)), 'denied');
    assert.equal(h.submitted.length, 1);
    assert.equal(h.main.reconcile(accepted.jobId), true);
    assert.deepEqual(
      h.sent.slice(sentBefore).map((s) => [s.event.sessionId, s.event.type]),
      [[reloaded.sessionId, 'rewrite.failed'], [reloaded.sessionId, 'outcome.cleared']],
      'the refusal and the cleared gate; the closed session gets no reconcile',
    );
    assert.equal(rewrite(h, reloaded, { clientRequestId: 'r2' }).ok, true);
  });

  test('navigation ends the session, cancels its job and drops later events', () => {
    const h = harness();
    const s = open(h);
    rewrite(h, s);
    const running = lastSubmit(h);
    h.main.windowNavigated(1);
    assert.deepEqual(h.cancelled, [running.job.jobId]);
    const sentBefore = h.sent.length;
    running.sink.succeeded(FIXTURE_OK);
    assert.equal(h.sent.length, sentBefore);
    assert.equal(code(h.main.handle(CHANNELS.getCapabilities, caller(), envelope(s))), 'denied');
    assert.equal(open(h).epoch, s.epoch + 2, 'the window stays registered for the reloaded page');
  });

  test('a valid envelope from a subframe or another URL is still denied', () => {
    const h = harness({ onSubmit: (_job, sink) => sink.succeeded(FIXTURE_OK) });
    const s = open(h);
    rewrite(h, s);
    const done = h.events().find((e) => e.type === 'rewrite.succeeded');
    assert.ok(done && done.type === 'rewrite.succeeded');
    for (const who of [caller(1, { isTopFrame: false }), caller(1, { frameUrl: 'https://example.invalid/' })]) {
      assert.equal(code(h.main.handle(CHANNELS.rewrite, who, body(s, { clientRequestId: 'r9' }))), 'denied');
      assert.equal(code(h.main.handle(CHANNELS.copyDraft, who, { ...envelope(s), draftHandle: done.draftHandle })), 'denied');
      assert.equal(code(h.main.handle(CHANNELS.closeSession, who, envelope(s))), 'denied');
    }
    assert.equal(h.submitted.length, 1);
    assert.deepEqual(h.copied, []);
  });

  test('closing a session releases retained draft text', () => {
    const registry = createSessionRegistry(() => 'id');
    registry.registerWindow(1, TRUSTED_URL);
    const session = registry.open(1);
    registry.issueDraft(session, 'Meet on Thursday at noon.');
    assert.equal(session.drafts.size, 1);
    registry.close(session);
    assert.equal(session.drafts.size, 0);
    assert.equal(session.open, false);
    assert.equal(registry.find(1, session.sessionId, session.epoch), null);
  });

  test('a destroyed window cannot receive callbacks or call again', () => {
    const h = harness();
    const s = open(h);
    rewrite(h, s);
    const running = lastSubmit(h);
    h.main.windowClosed(1);
    assert.deepEqual(h.cancelled, [running.job.jobId]);
    const sentBefore = h.sent.length;
    running.sink.succeeded(FIXTURE_OK);
    running.sink.failed('cancelled');
    assert.equal(h.sent.length, sentBefore);
    assert.equal(code(h.main.handle(CHANNELS.createSession, caller(1), { v: 1 })), 'denied');
  });
});

describe('rewrite admission', () => {
  test('an accepted rewrite sends accepted first and dispatches the frozen snapshot', () => {
    const h = harness();
    const s = open(h);
    assert.deepEqual(s.capabilities.actions, ['rewrite', 'cancel', 'copyDraft']);
    assert.deepEqual(s.capabilities.routes, [FIXTURE_REWRITE_ROUTE]);

    const accepted = value<RewriteAccepted>(rewrite(h, s, { steering: 'Use one sentence.' }));
    assert.equal(accepted.type, 'rewrite.accepted');
    assert.equal(accepted.clientRequestId, 'r1');
    assert.equal(accepted.sourceRevision, 1);
    assert.deepEqual(h.events(), [accepted]);
    assert.equal(h.sent[0]?.channel, CHANNELS.event);
    const { job } = lastSubmit(h);
    assert.deepEqual(job, {
      jobId: accepted.jobId,
      route: FIXTURE_REWRITE_ROUTE,
      transcript: 'Meet on Thursday at noon.',
      steering: 'Use one sentence.',
    });
  });

  test('an identical retry replays the first result without a second dispatch', () => {
    const h = harness();
    const s = open(h);
    const first = rewrite(h, s);
    const again = rewrite(h, s);
    assert.equal(again, first);
    assert.equal(h.submitted.length, 1);
    assert.equal(h.sent.length, 1);
  });

  test('a reused request ID with a different body is rejected and the original stands', () => {
    const h = harness();
    const s = open(h);
    const first = rewrite(h, s);
    assert.equal(code(rewrite(h, s, { transcript: 'Meet on Friday at noon.' })), 'invalid_input');
    assert.equal(h.submitted.length, 1);
    assert.equal(rewrite(h, s), first);
  });

  test('a rejected request replays its rejection without dispatching', () => {
    const h = harness();
    const s = open(h);
    assert.equal(code(rewrite(h, s, { transcript: '   ' })), 'invalid_input');
    assert.equal(code(rewrite(h, s, { transcript: '   ' })), 'invalid_input');
    assert.equal(code(rewrite(h, s)), 'invalid_input', 'same ID, new body: conflict');
    assert.equal(h.submitted.length, 0);
    assert.deepEqual(h.events(), [
      { ...envelope(s), type: 'rewrite.failed', clientRequestId: 'r1', jobId: null, code: 'invalid_input' },
    ], 'the refusal is announced once; replays and conflicts add nothing');
    const cancel = { ...envelope(s), clientRequestId: 'r1' };
    assert.deepEqual(value(h.main.handle(CHANNELS.cancel, caller(), cancel)), { disposition: 'already_finished' });
  });

  test('an oversized body is refused without hashing and cannot reuse an ID', () => {
    const h = harness();
    const s = open(h);
    const huge = 'a'.repeat(2 * 1024 * 1024);
    assert.equal(code(rewrite(h, s, { clientRequestId: 'big', transcript: huge })), 'invalid_input');
    assert.equal(h.events().length, 1);
    rewrite(h, s);
    const sentBefore = h.sent.length;
    assert.equal(code(rewrite(h, s, { transcript: huge })), 'invalid_input');
    assert.equal(h.sent.length, sentBefore, 'a conflict on a used ID announces nothing');
    assert.equal(h.submitted.length, 1);
  });

  test('routes outside the registry, for another stage or disabled cause zero dispatches', () => {
    const transcribe: PublishedRoute = { ...FIXTURE_REWRITE_ROUTE, routeKey: 'fixture-asr', stage: 'transcribe' };
    const disabled: PublishedRoute = { ...FIXTURE_REWRITE_ROUTE, routeKey: 'fixture-off', readiness: 'disabled' };
    const h = harness({ policy: createRoutePolicy([FIXTURE_REWRITE_ROUTE, transcribe, disabled]) });
    const s = open(h);
    assert.equal(code(rewrite(h, s, { clientRequestId: 'a', routeKey: 'personal-adapter' })), 'denied');
    assert.equal(code(rewrite(h, s, { clientRequestId: 'b', routeKey: 'fixture-asr' })), 'unsupported');
    assert.equal(code(rewrite(h, s, { clientRequestId: 'c', routeKey: 'fixture-off' })), 'route_unavailable');
    assert.equal(h.submitted.length, 0);
    const refusals = h.events().map((e) => (e.type === 'rewrite.failed' ? [e.clientRequestId, e.jobId, e.code] : e.type));
    assert.deepEqual(refusals, [['a', null, 'denied'], ['b', null, 'unsupported'], ['c', null, 'route_unavailable']]);
  });

  test('no rewrite action is offered without a ready rewrite route', () => {
    const h = harness({ policy: createRoutePolicy([]) });
    assert.deepEqual(open(h).capabilities, { actions: ['cancel', 'copyDraft'], routes: [] });
  });

  test('byte limits are enforced at max-1, max and max+1 with multibyte text', () => {
    const h = harness();
    const s = open(h);
    const cases: [string, Record<string, unknown>, boolean][] = [
      ['transcript max-1', { transcript: textOfBytes(FIXTURE_LIMITS.transcriptBytes - 1) }, true],
      ['transcript max', { transcript: textOfBytes(FIXTURE_LIMITS.transcriptBytes) }, true],
      ['transcript max+1', { transcript: textOfBytes(FIXTURE_LIMITS.transcriptBytes + 1) }, false],
      ['steering max', { steering: textOfBytes(FIXTURE_LIMITS.steeringBytes) }, true],
      ['steering max+1', { steering: textOfBytes(FIXTURE_LIMITS.steeringBytes + 1) }, false],
      ['emoji over by one byte', { steering: `${textOfBytes(FIXTURE_LIMITS.steeringBytes - 3)}😀` }, false],
      ['empty steering', { steering: '' }, true],
      ['empty transcript', { transcript: '' }, false],
    ];
    cases.forEach(([label, overrides, allowed], i) => {
      const before = h.submitted.length;
      const result = rewrite(h, s, { clientRequestId: `limit-${i}`, ...overrides });
      assert.equal(result.ok, allowed, label);
      assert.equal(h.submitted.length, before + (allowed ? 1 : 0), label);
      if (allowed) lastSubmit(h).sink.failed('cancelled'); // free the session for the next case
    });
  });

  test('only one job runs per session', () => {
    const h = harness();
    const s = open(h);
    rewrite(h, s);
    assert.equal(code(rewrite(h, s, { clientRequestId: 'r2' })), 'denied');
    lastSubmit(h).sink.failed('timed_out');
    assert.equal(rewrite(h, s, { clientRequestId: 'r3' }).ok, true);
    assert.equal(h.submitted.length, 2);
  });
});

describe('job outcomes', () => {
  test('success issues a draft handle that copies exactly that text', () => {
    const h = harness();
    const s = open(h);
    const accepted = value<RewriteAccepted>(rewrite(h, s, { sourceRevision: 4, steeringRevision: 2 }));
    lastSubmit(h).sink.succeeded(FIXTURE_OK);
    const done = h.events()[1];
    assert.ok(done && done.type === 'rewrite.succeeded');
    assert.deepEqual({ ...done, draftHandle: 'h' }, {
      ...envelope(s),
      type: 'rewrite.succeeded',
      clientRequestId: 'r1',
      jobId: accepted.jobId,
      sourceRevision: 4,
      steeringRevision: 2,
      actualMode: 'fixture',
      actualIdentity: 'fixture-v1',
      text: 'Meet on Thursday at noon.',
      draftHandle: 'h',
    });
    value(h.main.handle(CHANNELS.copyDraft, caller(), { ...envelope(s), draftHandle: done.draftHandle }));
    assert.deepEqual(h.copied, ['Meet on Thursday at noon.']);
  });

  test('a duplicate terminal is dropped', () => {
    const h = harness();
    const s = open(h);
    rewrite(h, s);
    const { sink } = lastSubmit(h);
    sink.succeeded(FIXTURE_OK);
    sink.succeeded({ ...FIXTURE_OK, text: 'Meet on Friday at noon.' });
    sink.failed('timed_out');
    assert.deepEqual(h.events().map((e) => e.type), ['rewrite.accepted', 'rewrite.succeeded']);
  });

  test('a wrong mode or identity is provider_mismatch and issues no handle', () => {
    for (const claim of [{ actualIdentity: 'fixture-v2' }, { actualMode: 'personalized' as const }]) {
      const h = harness();
      const s = open(h);
      rewrite(h, s);
      lastSubmit(h).sink.succeeded({ ...FIXTURE_OK, ...claim });
      const last = h.events().at(-1);
      assert.deepEqual(last && last.type === 'rewrite.failed' ? last.code : null, 'provider_mismatch');
    }
  });

  test('blank, oversized or malformed text is invalid_response', () => {
    const replies: unknown[] = [
      { ...FIXTURE_OK, text: '  ' },
      { ...FIXTURE_OK, text: textOfBytes(FIXTURE_LIMITS.draftBytes + 1) },
      { ...FIXTURE_OK, text: 7 },
      null,
    ];
    for (const reply of replies) {
      const h = harness();
      const s = open(h);
      rewrite(h, s);
      lastSubmit(h).sink.succeeded(reply as ProviderSuccess);
      const last = h.events().at(-1);
      assert.deepEqual(last && last.type === 'rewrite.failed' ? last.code : null, 'invalid_response');
    }
  });

  test('an unknown outcome blocks rewrites until main reconciles it', () => {
    const h = harness();
    const s = open(h);
    const accepted = value<RewriteAccepted>(rewrite(h, s));
    lastSubmit(h).sink.failed('provider_said_maybe' as FailureCode);
    const failure = h.events().at(-2);
    assert.deepEqual(failure && failure.type === 'rewrite.failed' ? failure.code : null, 'unknown_outcome');
    assert.equal(h.events().at(-1)?.type, 'outcome.unresolved');
    assert.equal(code(rewrite(h, s, { clientRequestId: 'r2' })), 'denied');

    assert.equal(h.main.reconcile('not-a-job'), false);
    assert.equal(h.main.reconcile(accepted.jobId), true);
    assert.equal(h.main.reconcile(accepted.jobId), false, 'reconciles once');
    assert.deepEqual(h.events().slice(-2), [
      { ...envelope(s), type: 'rewrite.reconciled', clientRequestId: 'r1', jobId: accepted.jobId },
      { ...envelope(s), type: 'outcome.cleared', kind: 'rewrite', jobId: accepted.jobId },
    ]);
    assert.equal(rewrite(h, s, { clientRequestId: 'r3' }).ok, true);
  });

  test('an unknown outcome survives a reload, so the same body is not dispatched twice', () => {
    const h = harness();
    const s = open(h);
    const accepted = value<RewriteAccepted>(rewrite(h, s));
    lastSubmit(h).sink.failed('unknown_outcome');
    for (let reload = 0; reload < 3; reload++) {
      const next = open(h);
      assert.equal(code(rewrite(h, next)), 'denied');
    }
    assert.equal(h.submitted.length, 1);
    assert.equal(h.main.reconcile(accepted.jobId), true);
    assert.equal(rewrite(h, open(h)).ok, true);
  });

  test('a throwing submit is reported as an unknown outcome after accepted', () => {
    const h = harness({
      onSubmit() {
        throw new Error('synthetic adapter crash');
      },
    });
    const s = open(h);
    assert.equal(rewrite(h, s).ok, true);
    const types = h.events().map((e) => (e.type === 'rewrite.failed' ? `failed:${e.code}` : e.type));
    assert.deepEqual(types, ['rewrite.accepted', 'failed:unknown_outcome', 'outcome.unresolved']);
  });

  test('a synchronous completion still arrives after accepted', () => {
    const h = harness({ onSubmit: (_job, sink) => sink.succeeded(FIXTURE_OK) });
    const s = open(h);
    rewrite(h, s);
    assert.deepEqual(h.events().map((e) => e.type), ['rewrite.accepted', 'rewrite.succeeded']);
  });
});

describe('cancel and copy', () => {
  test('cancel is idempotent and reports only a local disposition', () => {
    const h = harness();
    const s = open(h);
    rewrite(h, s);
    const cancel = { ...envelope(s), clientRequestId: 'r1' };
    assert.deepEqual(value(h.main.handle(CHANNELS.cancel, caller(), cancel)), { disposition: 'cancel_requested' });
    assert.deepEqual(value(h.main.handle(CHANNELS.cancel, caller(), cancel)), { disposition: 'cancel_requested' });
    assert.equal(h.cancelled.length, 1);
    assert.equal(h.events().length, 1, 'cancel itself emits no terminal event');
    lastSubmit(h).sink.failed('cancelled');
    assert.deepEqual(value(h.main.handle(CHANNELS.cancel, caller(), cancel)), { disposition: 'already_finished' });
    assert.equal(code(h.main.handle(CHANNELS.cancel, caller(), { ...cancel, clientRequestId: 'never-sent' })), 'denied');
  });

  test('a job that succeeds after cancel is reported but never copyable', () => {
    const h = harness();
    const s = open(h);
    rewrite(h, s);
    h.main.handle(CHANNELS.cancel, caller(), { ...envelope(s), clientRequestId: 'r1' });
    lastSubmit(h).sink.succeeded({ ...FIXTURE_OK, text: 'Cancelled but finished anyway.' });
    const done = h.events().at(-1);
    assert.ok(done && done.type === 'rewrite.succeeded', 'the renderer still needs the terminal to retire the job');
    assert.equal(code(h.main.handle(CHANNELS.copyDraft, caller(), { ...envelope(s), draftHandle: done.draftHandle })), 'denied');
    assert.deepEqual(h.copied, []);
  });

  test('request records are capped without evicting a running job', () => {
    const h = harness();
    const s = open(h);
    rewrite(h, s, { clientRequestId: 'running' });
    for (let i = 0; i < MAX_REQUEST_RECORDS + 5; i++) {
      assert.equal(code(rewrite(h, s, { clientRequestId: `busy-${i}` })), 'denied');
    }
    const cancel = { ...envelope(s), clientRequestId: 'running' };
    assert.deepEqual(value(h.main.handle(CHANNELS.cancel, caller(), cancel)), { disposition: 'cancel_requested' });
    // The oldest settled record was evicted, so its ID is no longer known.
    assert.equal(code(h.main.handle(CHANNELS.cancel, caller(), { ...cancel, clientRequestId: 'busy-0' })), 'denied');
    assert.deepEqual(value(h.main.handle(CHANNELS.cancel, caller(), { ...cancel, clientRequestId: 'busy-9' })), {
      disposition: 'already_finished',
    });
  });

  test('old handles expire past the retention cap', () => {
    const h = harness({ onSubmit: (_job, sink) => sink.succeeded(FIXTURE_OK) });
    const s = open(h);
    for (let i = 0; i <= MAX_DRAFT_HANDLES; i++) rewrite(h, s, { clientRequestId: `r${i}` });
    const handles = h.events().flatMap((e) => (e.type === 'rewrite.succeeded' ? [e.draftHandle] : []));
    assert.equal(handles.length, MAX_DRAFT_HANDLES + 1);
    const copy = (draftHandle: string | undefined) =>
      h.main.handle(CHANNELS.copyDraft, caller(), { ...envelope(s), draftHandle });
    assert.equal(code(copy(handles[0])), 'denied');
    assert.equal(copy(handles[1]).ok, true);
    assert.equal(copy(handles.at(-1)).ok, true);
  });

  test('a clipboard failure is reported as an unknown outcome', () => {
    const h = harness({ onSubmit: (_job, sink) => sink.succeeded(FIXTURE_OK) });
    const s = open(h);
    rewrite(h, s);
    const done = h.events().find((e) => e.type === 'rewrite.succeeded');
    assert.ok(done && done.type === 'rewrite.succeeded');
    h.failClipboard();
    const result = h.main.handle(CHANNELS.copyDraft, caller(), { ...envelope(s), draftHandle: done.draftHandle });
    assert.equal(code(result), 'unknown_outcome');
  });

  test('there is no clipboard-read or generic channel', () => {
    assert.deepEqual(Object.keys(CHANNELS).sort(), [
      'acknowledgeOutcome',
      'cancel',
      'chooseAudio',
      'closeSession',
      'copyDraft',
      'createSession',
      'discardCapture',
      'event',
      'getCapabilities',
      'microphoneStatus',
      'rewrite',
      'startCapture',
      'stopCapture',
      'transcribe',
    ]);
  });
});

describe('route policy', () => {
  test('misconfigured route cards fail at startup', () => {
    const base = FIXTURE_REWRITE_ROUTE;
    const bad: unknown[] = [
      { ...base, label: 'Local AI' },
      { ...base, mode: 'base', label: 'Synthetic base' },
      { ...base, mode: 'base', label: 'Base model', locationClass: 'synthetic' },
      { ...base, endpoint: 'http://127.0.0.1:9/' },
      { ...base, limits: { ...base.limits, draftBytes: 0 } },
      { ...base, limits: { ...base.limits, timeoutMs: 10 } },
      { ...base, routeKey: '' },
      { ...base, stage: 'translate' },
    ];
    for (const card of bad) assert.throws(() => createRoutePolicy([card as PublishedRoute]), /Invalid route card/);
    assert.throws(() => createRoutePolicy([base, base]), /duplicate/);
  });

  test('published routes are frozen copies', () => {
    const policy = createRoutePolicy();
    assert.ok(Object.isFrozen(policy.routes));
    assert.ok(Object.isFrozen(policy.routes[0]));
    assert.ok(Object.isFrozen(policy.routes[0]?.limits));
  });
});

describe('preload façade', () => {
  function fakeTransport(reply: (channel: string, payload: unknown) => unknown) {
    const calls: { channel: string; payload: unknown }[] = [];
    const listeners = new Set<(payload: unknown) => void>();
    const transport: PreloadTransport = {
      async invoke(channel, payload) {
        calls.push({ channel, payload });
        return reply(channel, payload);
      },
      subscribe(_channel, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return { transport, calls, emit: (payload: unknown) => listeners.forEach((l) => l(payload)) };
  }

  test('exposes only named intents and sends exactly the contract fields', async () => {
    const fake = fakeTransport(() => ({ ok: true, value: { closed: true } }));
    const api = createDesktopApi(fake.transport);
    assert.ok(Object.isFrozen(api));
    assert.deepEqual(Object.keys(api).sort(), [
      'acknowledgeOutcome',
      'cancel',
      'chooseAudio',
      'closeSession',
      'copyDraft',
      'createSession',
      'discardCapture',
      'getCapabilities',
      'microphoneStatus',
      'onEvent',
      'rewrite',
      'startCapture',
      'stopCapture',
      'transcribe',
    ]);
    const sneaky = { v: 9, sessionId: 's1', epoch: 1, clientRequestId: 'r1', path: '/etc/passwd' } as never;
    await api.cancel(sneaky);
    assert.deepEqual(fake.calls, [
      { channel: CHANNELS.cancel, payload: { v: 1, sessionId: 's1', epoch: 1, clientRequestId: 'r1' } },
    ]);
  });

  test('every façade method sends on its own channel', async () => {
    const fake = fakeTransport(() => ({ ok: false, code: 'denied' }));
    const api = createDesktopApi(fake.transport) as unknown as Record<string, (payload: unknown) => Promise<unknown>>;
    const methods = Object.keys(api).filter((name) => name !== 'onEvent').sort();
    for (const name of methods) await api[name]?.({ v: 1, sessionId: 's1', epoch: 1 });
    assert.deepEqual(fake.calls.map((call) => call.channel), methods.map((name) => CHANNELS[name as keyof typeof CHANNELS]));
    assert.ok(methods.every((name) => CHANNELS[name as keyof typeof CHANNELS] !== undefined), 'each method has a channel of the same name');
  });

  test('transport failures and malformed replies become safe codes', async () => {
    const throwing = createDesktopApi(fakeTransport(() => Promise.reject(new Error('synthetic'))).transport);
    assert.deepEqual(await throwing.createSession(), { ok: false, code: 'unknown_outcome' });
    const garbled = createDesktopApi(fakeTransport(() => ({ status: 'fine' })).transport);
    assert.deepEqual(await garbled.createSession(), { ok: false, code: 'invalid_response' });
  });

  test('only well-formed v1 events reach the renderer', () => {
    const fake = fakeTransport(() => null);
    const api = createDesktopApi(fake.transport);
    const received: MainEvent[] = [];
    const unsubscribe = api.onEvent((event) => received.push(event));
    const good = { v: 1, sessionId: 's1', epoch: 1, type: 'rewrite.failed', clientRequestId: 'r1', jobId: null, code: 'cancelled' };
    fake.emit({ ...good, type: 'rewrite.exploded' });
    fake.emit({ ...good, html: '<img src=x onerror=alert(1)>' });
    fake.emit({ ...good, epoch: '1' });
    fake.emit({ ...good, v: 2 });
    fake.emit(good);
    unsubscribe();
    fake.emit(good);
    assert.deepEqual(received, [good]);
    assert.ok(Object.isFrozen(received[0]));
    assert.equal(filterEvent(Object.assign(Object.create({ injected: 1 }), good)), null);
  });
});

describe('façade, main and reducer together', () => {
  /** Wires the preload façade to main through an in-memory transport. */
  function wired(onSubmit?: (job: RewriteJob, sink: JobSink) => void, policy?: RoutePolicy) {
    const h = harness({ onSubmit, policy });
    const listeners = new Set<(payload: unknown) => void>();
    const transport: PreloadTransport = {
      async invoke(channel, payload) {
        return h.main.handle(channel, caller(), structuredClone(payload));
      },
      subscribe(_channel, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const api = createDesktopApi(transport);
    let state: SessionState | null = null;
    api.onEvent((event) => {
      if (state !== null) state = reduce(state, event);
    });
    const flush = () => {
      for (const { event, windowId } of h.sent.splice(0)) {
        if (windowId === 1) listeners.forEach((l) => l(structuredClone(event)));
      }
    };
    return {
      h,
      api,
      flush,
      get state(): SessionState {
        assert.ok(state);
        return state;
      },
      set state(next: SessionState) {
        state = next;
      },
    };
  }

  test('a typed request round-trips to a copyable current draft', async () => {
    const w = wired((_job, sink) => sink.succeeded(FIXTURE_OK));
    const opened = value<SessionOpened>(await w.api.createSession());
    const route = opened.capabilities.routes[0] ?? null;
    w.state = createSession({ sessionId: opened.sessionId, epoch: opened.epoch, route });
    w.state = reduce(w.state, { type: 'edit.transcript', text: 'Meet on Thursday at noon.' });
    w.state = reduce(w.state, { type: 'rewrite.request', clientRequestId: 'r1' });
    const request = rewriteRequest(w.state);
    assert.ok(request);
    assert.equal((await w.api.rewrite(request)).ok, true);
    w.flush();
    assert.equal(w.state.draft?.text, 'Meet on Thursday at noon.');
    const eligibility = copyEligibility(w.state);
    assert.equal(eligibility.allowed, true);
    assert.ok(eligibility.allowed && eligibility.draftHandle);
    const copied = await w.api.copyDraft({ v: 1, sessionId: opened.sessionId, epoch: opened.epoch, draftHandle: eligibility.draftHandle });
    assert.deepEqual(copied, { ok: true, value: { status: 'copied' } });
    assert.deepEqual(w.h.copied, ['Meet on Thursday at noon.']);
  });

  test('a refused request settles the renderer instead of leaving it pending', async () => {
    const disabled: PublishedRoute = { ...FIXTURE_REWRITE_ROUTE, readiness: 'disabled' };
    const w = wired(undefined, createRoutePolicy([disabled]));
    const opened = value<SessionOpened>(await w.api.createSession());
    w.state = createSession({ sessionId: opened.sessionId, epoch: opened.epoch, route: opened.capabilities.routes[0] ?? null });
    w.state = reduce(w.state, { type: 'edit.transcript', text: 'Meet on Thursday at noon.' });
    w.state = reduce(w.state, { type: 'rewrite.request', clientRequestId: 'r1' });
    const request = rewriteRequest(w.state);
    assert.ok(request);
    assert.deepEqual(await w.api.rewrite(request), { ok: false, code: 'route_unavailable' });
    w.flush();
    assert.equal(w.state.pending, null);
    assert.equal(w.state.notice, 'route_unavailable');
    assert.equal(w.h.submitted.length, 0);
  });

  test('editing Thursday to Friday mid-flight keeps the edit and discards the late draft', async () => {
    const w = wired();
    const opened = value<SessionOpened>(await w.api.createSession());
    w.state = createSession({ sessionId: opened.sessionId, epoch: opened.epoch, route: opened.capabilities.routes[0] ?? null });
    w.state = reduce(w.state, { type: 'edit.transcript', text: 'Meet on Thursday at noon.' });
    w.state = reduce(w.state, { type: 'rewrite.request', clientRequestId: 'r1' });
    const request = rewriteRequest(w.state);
    assert.ok(request);
    await w.api.rewrite(request);
    w.flush();
    w.state = reduce(w.state, { type: 'edit.transcript', text: 'Meet on Friday at noon.' });
    lastSubmit(w.h).sink.succeeded(FIXTURE_OK);
    w.flush();
    assert.equal(w.state.transcript, 'Meet on Friday at noon.');
    assert.equal(w.state.draft, null);
    assert.equal(w.state.notice, 'result_outdated');
  });
});
