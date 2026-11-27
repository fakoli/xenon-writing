// The interface copy uses typographic apostrophes and ellipses (UI review):
// "can’t", not "can't"; "Saving…", not "Saving...". Scans the
// renderer's source with comments removed, so it covers notices that the e2e
// journeys never reach. The e2e axe journeys check rendered text and accessible
// names for straight quotes as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RENDERER = new URL('../../src/renderer/', import.meta.url).pathname;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('renderer copy has no straight apostrophes or three-dot ellipses', () => {
  const files = readdirSync(RENDERER).filter((name) => /\.tsx?$/.test(name));
  assert.ok(files.length >= 8, 'the renderer sources were found');
  const problems: string[] = [];
  for (const name of files) {
    withoutComments(readFileSync(join(RENDERER, name), 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        // In code a straight quote never sits between two letters, so this is copy.
        if (/[A-Za-z]'[A-Za-z]/.test(line)) problems.push(`${name}:${i + 1}: straight apostrophe`);
        if (/[A-Za-z]\.\.\./.test(line)) problems.push(`${name}:${i + 1}: three dots`);
      });
  }
  assert.deepEqual(problems, []);
});

test('the check itself finds a straight apostrophe and three dots', () => {
  const sample = withoutComments("const a = 'Couldn't copy.'; // can't\nconst b = 'Saving...';\n/* don't */");
  assert.match(sample, /[A-Za-z]'[A-Za-z]/);
  assert.match(sample, /[A-Za-z]\.\.\./);
  assert.doesNotMatch(sample, /can't|don't/);
});
