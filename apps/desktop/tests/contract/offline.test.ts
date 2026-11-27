// Static offline guarantee: no source module can reach the network or start
// other processes. Complements the runtime traps in jobs.test.ts, which cannot
// see workers, child processes or modules added later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../../src/', import.meta.url).pathname;
/** The only Node built-in the app's source may import today. */
const ALLOWED_BUILTINS = new Set(['node:crypto']);
/**
 * Packet B's Electron entry points and React renderer. Only these named
 * Electron bindings may be imported; `net`, `shell`, `utilityProcess` and the
 * like stay out, and the global check below still applies to these files.
 */
const ENTRY_ALLOWANCES: Readonly<Record<string, readonly string[]>> = {
  'main/main.ts': ['electron', 'node:path', 'node:url'],
  'preload/preload.ts': ['electron'],
  // The native audio chooser reads the one file the user picked, capped in size.
  'main/platform/electronChooser.ts': ['electron', 'node:fs/promises'],
  // macOS microphone permission and the hidden capture window (Packet E).
  'main/platform/electronCapture.ts': ['electron'],
  'preload/capturePreload.ts': ['electron'],
  // The one loopback transport for an approved chat route (route card 07): 127.0.0.1 and the card's port only.
  'main/providers/loopbackHttp.ts': ['node:http'],
};
const ELECTRON_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  'main/main.ts': ['app', 'BrowserWindow', 'clipboard', 'ipcMain', 'nativeTheme', 'session'],
  'preload/preload.ts': ['contextBridge', 'ipcRenderer'],
  'main/platform/electronChooser.ts': ['BrowserWindow', 'dialog'],
  'main/platform/electronCapture.ts': ['BrowserWindow', 'ipcMain', 'systemPreferences'],
  'preload/capturePreload.ts': ['contextBridge', 'ipcRenderer'],
};
const RENDERER_PACKAGES = new Set(['react', 'react-dom/client']);
const FORBIDDEN_GLOBALS = /\b(fetch|WebSocket|XMLHttpRequest|EventSource|Worker|SharedWorker|importScripts)\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );
}

test('source imports no network, process or worker module and calls no network global', () => {
  const files = sources(SRC);
  assert.ok(files.length >= 9, 'the scan found the source tree');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const relative = file.slice(SRC.length);
    const specifiers = [...text.matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'|\brequire\s*\(\s*'([^']+)'/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    for (const specifier of specifiers) {
      if (specifier === undefined || specifier.startsWith('.')) continue;
      const allowed =
        ALLOWED_BUILTINS.has(specifier) ||
        (ENTRY_ALLOWANCES[relative]?.includes(specifier) ?? false) ||
        (relative.startsWith('renderer/') && RENDERER_PACKAGES.has(specifier));
      assert.ok(allowed, `${file} imports ${specifier}`);
    }
    for (const [, names] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'electron'/g)) {
      for (const name of (names ?? '').split(',').map((n) => n.trim()).filter(Boolean)) {
        assert.ok(ELECTRON_BINDINGS[relative]?.includes(name) ?? false, `${file} imports electron's ${name}`);
      }
    }
    assert.doesNotMatch(text, /import\s+(\*\s+as\s+)?\w+\s*(,[^;]*)?from\s*'electron'/, `${file} must import named Electron bindings only`);
    assert.doesNotMatch(text, FORBIDDEN_GLOBALS, file);
  }
});

test('Electron main registers every intent through desktop.invoke, so async intents are served', () => {
  const text = readFileSync(join(SRC, 'main/main.ts'), 'utf8');
  // desktop.handle is the synchronous core: it answers chooseAudio and capture with 'unsupported'.
  assert.match(text, /ipcMain\.handle\(channel,[^\n]*desktop\.invoke\(channel,/);
  assert.doesNotMatch(text, /desktop\.handle\(/);
});
