// The first-send consent rule (the local base rewrite route), apart from the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canConfirmSend, destinationText, needsSendConfirmation } from '../../src/renderer/sendConsent.ts';
import type { RouteDescriptor } from '../../src/contracts/session.ts';

const limits = { transcriptBytes: 4096, steeringBytes: 2048, draftBytes: 8192 };
const route = (mode: RouteDescriptor['mode']): RouteDescriptor => ({ routeKey: 'r', mode, identity: 'id', limits });

test('only a route that leaves the app asks, and only until the session consents', () => {
  assert.equal(needsSendConfirmation(null, false), false);
  assert.equal(needsSendConfirmation(route('fixture'), false), false);
  assert.equal(needsSendConfirmation(route('base'), false), true);
  assert.equal(needsSendConfirmation(route('personalized'), false), true);
  assert.equal(needsSendConfirmation(route('base'), true), false);
});

test('a blocked send keeps the confirmation open and records no consent', () => {
  assert.equal(canConfirmSend(null), true);
  for (const blocker of ['empty_transcript', 'transcript_too_large', 'pending', 'unresolved_outcome', 'no_route'] as const) {
    assert.equal(canConfirmSend(blocker), false, blocker);
  }
});

test('the destination is named from the location class', () => {
  assert.equal(destinationText('local'), 'a separate service on this Mac');
  assert.equal(destinationText('remote'), 'a service outside this Mac');
  assert.equal(destinationText(undefined), 'a service outside this app');
});
