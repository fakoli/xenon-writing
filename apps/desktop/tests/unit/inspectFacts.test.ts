// Synthetic unit tests for what the Inspect step says (src/renderer/inspectFacts.ts).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { OutcomeReport } from '../../src/contracts/session.ts';
import { ACKNOWLEDGE_LINE, NOTHING_RESENT, RESTART_LINE, formatSentAt, inspectFacts } from '../../src/renderer/inspectFacts.ts';
import type { InspectRoute } from '../../src/renderer/inspectFacts.ts';

const UTC = { locale: 'en-US', timeZone: 'UTC' } as const;
const SENT = Date.UTC(2026, 10, 26, 22, 42); // 10:42 PM UTC
const BASE: InspectRoute = {
  routeKey: 'local-base-rewrite',
  label: 'Local base model (test text only)',
  identity: 'mlx-community/Qwen3-4B-Instruct-2507-4bit',
  locationClass: 'local',
};
const FIXTURE_ASR: InspectRoute = { routeKey: 'fixture-transcribe', label: 'Synthetic fixture', identity: 'fixture-asr-v1', locationClass: 'synthetic' };
const OUTCOME: OutcomeReport = { kind: 'rewrite', jobId: 'j1', routeKey: BASE.routeKey, sentAt: SENT, clearance: 'acknowledge' };

describe('formatSentAt', () => {
  test('the time alone on the same day, with the date otherwise', () => {
    assert.equal(formatSentAt(SENT, SENT + 60_000, UTC), '10:42 PM');
    assert.equal(formatSentAt(SENT, SENT + 2 * 60 * 60_000, UTC), 'Nov 26, 10:42 PM', 'past midnight UTC');
  });
});

describe('inspectFacts', () => {
  test('says where the text went and when, that the reply was not applied, what is unknown, and that nothing is resent', () => {
    const facts = inspectFacts(OUTCOME, [BASE], SENT, UTC);
    assert.deepEqual(facts.known, [
      'At 10:42 PM, Xenon Writing began sending your transcript and steering to Local base model (test text only): the model mlx-community/Qwen3-4B-Instruct-2507-4bit.',
      'Its reply, if one came, was not applied.',
    ]);
    assert.equal(
      facts.unknown,
      'Whether they arrived, and whether Local base model (test text only) produced a reply. It may have, and it may keep a copy of what it received.',
    );
    assert.deepEqual(facts.next, [NOTHING_RESENT, ACKNOWLEDGE_LINE]);
    assert.equal(facts.canAcknowledge, true);
    assert.equal(facts.jobId, 'j1');
  });

  test('a route that only a restart clears offers no acknowledgment and says how to resume', () => {
    const facts = inspectFacts({ ...OUTCOME, kind: 'transcribe', routeKey: FIXTURE_ASR.routeKey, clearance: 'restart' }, [BASE, FIXTURE_ASR], SENT, UTC);
    assert.equal(facts.canAcknowledge, false);
    assert.deepEqual(facts.next, [NOTHING_RESENT, RESTART_LINE]);
    assert.equal(facts.known[0], 'At 10:42 PM, Xenon Writing began sending your audio to Synthetic fixture: the model fixture-asr-v1.');
    assert.equal(facts.unknown, 'What became of it. The fixture runs inside this app, so nothing left it.', 'no claim that an in-process fixture keeps a copy');
    assert.equal(facts.name, 'the transcription started at 10:42 PM');
  });

  test('a route main did not publish is named by its key, without a model', () => {
    const facts = inspectFacts(OUTCOME, [], SENT, UTC);
    assert.equal(facts.known[0], 'At 10:42 PM, Xenon Writing began sending your transcript and steering to local-base-rewrite.');
    assert.match(facts.unknown, /^Whether they arrived, and whether local-base-rewrite produced a reply\. It may have, and it may keep a copy/);
  });

  test('audio is "it", and a time main could not stamp (0) is left out rather than shown as 1970', () => {
    const facts = inspectFacts({ ...OUTCOME, kind: 'transcribe', sentAt: 0 }, [BASE], SENT, UTC);
    assert.equal(facts.known[0], 'Earlier, Xenon Writing began sending your audio to Local base model (test text only): the model mlx-community/Qwen3-4B-Instruct-2507-4bit.');
    assert.match(facts.unknown, /^Whether it arrived, and whether/);
    assert.equal(facts.name, 'the earlier transcription');
  });
});
