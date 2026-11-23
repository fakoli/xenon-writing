// Which kind a status line is, from the icon it already shows: the color follows the icon, never replaces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusKind } from '../../src/renderer/statusKind.ts';

test('status kinds follow the icon', () => {
  assert.equal(statusKind('⚠'), 'warning');
  assert.equal(statusKind('✓'), 'success');
  assert.equal(statusKind('…'), 'progress');
  assert.equal(statusKind('●'), 'recording');
  assert.equal(statusKind('ⓘ'), 'info');
  assert.equal(statusKind(''), 'info');
  assert.equal(statusKind('?'), 'info', 'anything unknown is plain information');
});
