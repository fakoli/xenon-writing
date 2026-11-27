/**
 * Packet D's `offline.spec.ts` (delivery plan), run against the built app in a
 * real Electron 45 window: the Forge Vite production build of main, preload
 * and renderer, wired to the offline synthetic composition. Network, DNS and
 * process entry points in main are trapped from before the app's code runs
 * (offline-trap.cjs; see its header for what it cannot see), the native open
 * dialog is stubbed in main, the clipboard write is captured and each run gets
 * a throwaway profile. Fictional text and a generated tone only.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { noonWav } from '../fixtures/wav.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '../..');
const TRAP = path.join(HERE, 'offline-trap.cjs');

type MainGlobals = typeof globalThis & { __offlineHits: string[]; __copied: string[]; __dialog?: unknown };

function withoutRouteSwitch(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.XENON_REWRITE_ROUTE;
  return copy;
}

let app: ElectronApplication;
let page: Page;
let dir: string;
let hitsFile: string;
let errors: string[];

test.beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'xenon-offline-'));
  hitsFile = path.join(dir, 'hits.log');
  errors = [];
  app = await electron.launch({
    // The trap loads before the app's main module, the way Playwright loads its own hook. Chromium's fake
    // input device means no test ever opens a real microphone (macOS's permission state is stubbed per test).
    args: ['-r', TRAP, '--use-fake-device-for-media-stream', APP_DIR],
    // Never inherit route card 07's switch from the shell: this test runs the fixture routes only.
    env: { ...withoutRouteSwitch(process.env), XENON_OFFLINE_PROFILE: path.join(dir, 'profile'), XENON_OFFLINE_HITS: hitsFile },
    // Keep Chromium's OS sandbox on Linux too (Playwright turns it off there by default).
    chromiumSandbox: true,
  });
  const watched = new WeakSet<Page>();
  const watch = (p: Page) => {
    if (watched.has(p)) return;
    watched.add(p);
    p.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
    p.on('pageerror', (err) => errors.push(err.message));
  };
  app.on('window', watch);
  page = await app.firstWindow();
  watch(page);
  // No test may ever open a real microphone: the fake input device must be in force.
  expect(await app.evaluate(({ app: electronApp }) => electronApp.commandLine.hasSwitch('use-fake-device-for-media-stream'))).toBe(true);
  await expect(page.getByRole('heading', { name: 'Session' })).toBeVisible();
});

test.afterEach(async () => {
  let hits = '';
  try {
    await app.close();
    // Read after close, so hits during shutdown count too.
    hits = existsSync(hitsFile) ? readFileSync(hitsFile, 'utf8') : '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(hits, 'no trapped entry point was touched').toBe('');
  expect(errors).toEqual([]);
});

/** Makes the native open dialog return one file, and records how it was opened. */
async function stubDialog(file: string | null) {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async (parent: unknown, options: { title?: string; filters?: unknown }) => {
      (globalThis as MainGlobals).__dialog = { parented: parent !== undefined && parent !== null, title: options?.title, filters: options?.filters };
      return picked === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [picked] };
    }) as typeof dialog.showOpenDialog;
  }, file);
}

test('the trap is armed: network, DNS, session and process entry points are caught', async () => {
  // A trap that never loaded would make every "no hits" check pass, so prove it works first.
  const caught = await app.evaluate(async ({ BrowserWindow, net, session, shell, utilityProcess }, file) => {
    const hits = (globalThis as MainGlobals).__offlineHits;
    const nodeNet = process.getBuiltinModule('node:net') as typeof import('node:net');
    const http = process.getBuiltinModule('node:http') as typeof import('node:http');
    const dns = process.getBuiltinModule('node:dns') as typeof import('node:dns');
    const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process');
    const threads = process.getBuiltinModule('node:worker_threads') as typeof import('node:worker_threads');
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
    const host = 'offline-trap.invalid';
    const attempts: (() => unknown)[] = [
      () => new nodeNet.Socket().connect(80, host),
      () => http.get(`http://${host}/`),
      () => dns.lookup(host, () => {}),
      () => new dns.Resolver().resolveTxt(host, () => {}),
      () => fetch(`https://${host}/`),
      () => net.resolveHost(host),
      () => session.defaultSession.preconnect({ url: `https://${host}/` }),
      () => session.defaultSession.resolveHost(host),
      () => childProcess.spawn('true'),
      () => new threads.Worker('', { eval: true }),
      () => utilityProcess.fork(file),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
      } catch {
        // expected: the trap throws
      }
    }
    // Chromium-level requests (not Node's) from hidden throwaway windows, one in another partition.
    // Spellchecking off, like the app's window: these probe requests, not the spellchecker.
    for (const partition of [undefined, 'offline-probe']) {
      const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true, partition, spellcheck: false } });
      await probe.loadURL(`https://${host}/`).catch(() => undefined);
      probe.destroy();
    }
    const seen = [...hits];
    // Patched, not called: a broken trap would open the system browser.
    const shellTrapped = shell.openExternal.name === 'trapped';
    hits.length = 0; // reset, so afterEach checks only the app's own behavior
    fs.writeFileSync(process.env.XENON_OFFLINE_HITS as string, '');
    return { seen, shellTrapped };
  }, TRAP);
  expect(caught).toEqual({
    seen: [
      'net.Socket.connect',
      'http.get',
      'dns.lookup',
      'dns.Resolver.resolveTxt',
      'fetch',
      'electron.net.resolveHost',
      'session.preconnect',
      'session.resolveHost',
      'child_process.spawn',
      'worker_threads.Worker',
      'electron.utilityProcess.fork',
      'session request (https:)',
      'session request (https:)',
    ],
    shellTrapped: true,
  });
});

test('the app runs on a throwaway profile, not the developer\'s', async () => {
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  expect(userData).toBe(path.join(dir, 'profile'));
});

test('the built app exposes only the façade and publishes the fixture routes; recording only on macOS', async () => {
  const surface = await page.evaluate(() => ({
    xenon: Object.keys((window as unknown as { xenon: object }).xenon).sort(),
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
  }));
  expect(surface).toEqual({
    xenon: ['acknowledgeOutcome', 'cancel', 'chooseAudio', 'closeSession', 'copyDraft', 'createSession', 'discardCapture', 'getCapabilities', 'microphoneStatus', 'onEvent', 'rewrite', 'startCapture', 'stopCapture', 'transcribe'],
    require: 'undefined',
    process: 'undefined',
  });
  await expect(page.getByText('Synthetic fixture · fixture-v1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import audio' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Transcribe' })).toBeVisible();
  // No outcome is unknown in a fresh app, so nothing is paused and Inspect is not offered.
  await expect(page.getByRole('button', { name: 'Inspect unknown outcome' })).toHaveCount(0);
  // Microphone ports exist only on macOS, the only target; elsewhere capture is not offered.
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toHaveCount(process.platform === 'darwin' ? 1 : 0);
  // Hunspell would download dictionaries on Windows and Linux; macOS spellchecks locally with the OS.
  // The trap records any dictionary download, which is the evidence on Linux CI.
  expect(await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled())).toBe(process.platform === 'darwin');

  // Last, because it opens a new session from the page: the acknowledgment channel is wired through Electron to main, which refuses a job it never reported (the fixture routes never allow one).
  const acknowledged = await page.evaluate(async () => {
    type Api = { createSession(): Promise<any>; acknowledgeOutcome(request: object): Promise<unknown> };
    const api = (window as unknown as { xenon: Api }).xenon;
    const opened = await api.createSession();
    return api.acknowledgeOutcome({ v: 1, sessionId: opened.value.sessionId, epoch: opened.value.epoch, clientRequestId: 'ack-probe', jobId: 'never-reported' });
  });
  expect(acknowledged).toEqual({ ok: false, code: 'denied' });
});

test('typed transcript → synthetic rewrite → explicit copy, end to end in Electron', async () => {
  await page.getByRole('textbox', { name: 'Transcript' }).fill('Meet  at\nnoon. ');
  await page.getByRole('button', { name: 'Rewrite' }).click();
  // The fixture collapses whitespace; its identity is shown with the draft.
  await expect(page.locator('.preview')).toHaveText('Meet at noon.');
  await expect(page.locator('#source-status')).toContainText('Draft ready for review.');
  expect(await app.evaluate(() => (globalThis as MainGlobals).__copied)).toEqual([]);
  await page.getByRole('button', { name: 'Copy draft' }).click();
  await expect(page.locator('#copy-status')).toHaveText('✓ Draft copied to the clipboard.');
  expect(await app.evaluate(() => (globalThis as MainGlobals).__copied)).toEqual(['Meet at noon.']);
});

test('imported audio → synthetic transcription → Replace, end to end in Electron', async () => {
  const file = path.join(dir, 'tone.wav');
  writeFileSync(file, noonWav());
  await stubDialog(file);
  const transcript = page.getByRole('textbox', { name: 'Transcript' });
  await transcript.fill('Meet at ten.');
  await page.getByRole('button', { name: 'Import audio' }).click();
  await expect(page.locator('#audio-status')).toHaveText('✓ Audio ready: 1.0 seconds of WAV.');
  expect(await app.evaluate(() => (globalThis as MainGlobals).__dialog)).toEqual({
    parented: true,
    title: 'Import audio',
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  // Nothing in the renderer names the file.
  expect(await page.content()).not.toContain('tone.wav');
  await page.getByRole('button', { name: 'Transcribe' }).click();
  const candidate = page.getByRole('region', { name: 'Transcript from audio' });
  await expect(candidate).toContainText('Meet at noon.');
  await expect(candidate).toContainText('Synthetic fixture · fixture-asr-v1');
  await expect(transcript).toHaveValue('Meet at ten.');
  await page.getByRole('button', { name: 'Replace transcript' }).click();
  await expect(transcript).toHaveValue('Meet at noon.');
});

test('the chooser refuses a file that is not the fixture WAV format, and a closed dialog changes nothing', async () => {
  await stubDialog(null);
  await page.getByRole('button', { name: 'Import audio' }).click();
  await expect(page.locator('#audio-status')).toHaveText('ⓘ No audio chosen.');
  const file = path.join(dir, 'notes.wav');
  writeFileSync(file, 'Fictional notes, not audio.');
  await stubDialog(file);
  await page.getByRole('button', { name: 'Import audio' }).click();
  await expect(page.locator('#audio-status')).toContainText('Choose a WAV file that is mono, 16 kHz, 16-bit and at most 30 seconds.');
  await expect(page.getByRole('button', { name: 'Transcribe' })).toBeDisabled();
});

test.describe('macOS microphone and capture, with a fake input device', () => {
  test.skip(process.platform !== 'darwin', 'macOS is the only target with microphone ports');

  /** Stubs macOS's microphone state in main; askForMediaAccess records calls and turns the state into `answer`. */
  async function stubMicrophone(state: string, answer = state) {
    await app.evaluate(({ systemPreferences }, [initial, after]) => {
      const g = globalThis as Record<string, unknown>;
      g.__micState = initial;
      g.__micAsked = 0;
      systemPreferences.getMediaAccessStatus = (() => g.__micState) as typeof systemPreferences.getMediaAccessStatus;
      systemPreferences.askForMediaAccess = (async () => {
        g.__micAsked = (g.__micAsked as number) + 1;
        g.__micState = after;
        return after === 'granted';
      }) as typeof systemPreferences.askForMediaAccess;
    }, [state, answer]);
  }
  const asked = () => app.evaluate(() => (globalThis as Record<string, unknown>).__micAsked as number);
  /** Open windows, as counts of visible and hidden ones. */
  const windows = () =>
    app.evaluate(({ BrowserWindow }) => {
      const all = BrowserWindow.getAllWindows();
      return { visible: all.filter((w) => w.isVisible()).length, hidden: all.filter((w) => !w.isVisible()).length };
    });
  const recordStatus = () => page.locator('#record-status');

  test('Record captures in a hidden window; Stop keeps it; the second click transcribes it', async () => {
    await stubMicrophone('granted');
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(recordStatus()).toContainText('Recording.');
    const started = Date.now();
    // The capture runs in a second, hidden window that exists only while recording.
    expect(await windows()).toEqual({ visible: 1, hidden: 1 });
    await page.waitForTimeout(1_200);
    await page.getByRole('button', { name: 'Stop' }).click();
    const wall = (Date.now() - started) / 1000;
    await expect(page.locator('#audio-status')).toHaveText(/Audio ready: \d+\.\d seconds of WAV\./);
    const seconds = Number(/(\d+\.\d) seconds/.exec((await page.locator('#audio-status').textContent()) ?? '')?.[1]);
    // The recording lasts as long as the wall clock: 16 kHz samples, not the device rate.
    expect(seconds).toBeGreaterThanOrEqual(0.8);
    expect(seconds).toBeLessThanOrEqual(wall + 0.5);
    expect(await windows()).toEqual({ visible: 1, hidden: 0 });
    expect(await asked()).toBe(0);
    // Stop sends nothing: the recording waits for the second click, then goes to the synthetic transcriber.
    const prompt = page.getByRole('region', { name: 'Transcribe this recording?' });
    await expect(prompt).toContainText('Synthetic fixture · fixture-asr-v1');
    await expect(page.getByRole('textbox', { name: 'Transcript' })).toHaveValue('');
    await page.getByRole('button', { name: 'Transcribe recording' }).click();
    await expect(page.getByRole('textbox', { name: 'Transcript' })).toHaveValue('Meet at noon.');
  });

  test('never asked: the explanation comes first, then one OS prompt, then recording; Discard keeps nothing', async () => {
    await stubMicrophone('not-determined', 'granted');
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Before you record' })).toBeVisible();
    expect(await asked()).toBe(0);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(recordStatus()).toContainText('Recording.');
    expect(await asked()).toBe(1);
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(recordStatus()).toContainText('Recording discarded. Nothing was kept.');
    await expect(page.locator('#audio-status')).toHaveText('ⓘ No audio chosen.');
    expect(await windows()).toEqual({ visible: 1, hidden: 0 });
  });

  test('denied: explained, never prompted, and no capture window opens', async () => {
    await stubMicrophone('denied');
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(recordStatus()).toContainText('Microphone access is off for this app.');
    expect(await asked()).toBe(0);
    expect(await windows()).toEqual({ visible: 1, hidden: 0 });
  });

  test('the app window itself can never use the microphone, even while recording', async () => {
    await stubMicrophone('granted');
    const tryMic = () =>
      page.evaluate(() =>
        navigator.mediaDevices.getUserMedia({ audio: true }).then(
          (stream) => (stream.getTracks().forEach((t) => t.stop()), 'opened'),
          (error: DOMException) => error.name,
        ),
      );
    expect(await tryMic()).toBe('NotAllowedError');
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(recordStatus()).toContainText('Recording.');
    expect(await tryMic()).toBe('NotAllowedError');
    await page.getByRole('button', { name: 'Discard' }).click();
  });
});
