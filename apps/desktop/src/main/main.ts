/**
 * Electron main process: one hardened window showing the accessible shell,
 * wired to Packet D's composition (C's handlers, the job runner and the
 * in-process fixture providers). By default nothing leaves the process.
 * The native audio chooser (Packet B part 2) feeds E's inspection and the
 * synthetic transcriber. On macOS (the only target), Packet E's microphone
 * permission and capture ports are wired too, through a hidden capture window
 * that alone may use the microphone while a recording is opening or open.
 * Route card 07's local base rewrite is off unless main is launched with its
 * exact switch (XENON_REWRITE_ROUTE=local-base-rewrite); then rewrites go to
 * 127.0.0.1:30113 and synthetic text only is accepted. The window stays
 * sandboxed and context-isolated, with no Node integration, no navigation or
 * new windows, and no permission except the capture window's microphone.
 */
import { app, BrowserWindow, clipboard, ipcMain, session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNELS } from '../contracts/ipc.ts';
import { callerFromElectronEvent } from './ipc.ts';
import { createElectronMedia } from './platform/electronCapture.ts';
import { createElectronChooser } from './platform/electronChooser.ts';
import { createSyntheticMain } from './synthetic.ts';
import { BASE_REWRITE_PORT, baseRewriteEnabled } from './providers/baseRewriteRoute.ts';
import { createLoopbackTransport } from './providers/loopbackHttp.ts';

// Injected by @electron-forge/plugin-vite at build time.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const CAPTURE_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const CAPTURE_WINDOW_VITE_NAME: string;

function pageUrl(devServer: string | undefined, name: string): string {
  return devServer ? new URL(devServer).href : pathToFileURL(path.join(__dirname, `../renderer/${name}/index.html`)).href;
}

// macOS is the only target with microphone ports (owner decision 2026-11-18); elsewhere main does not offer capture.
const media =
  process.platform === 'darwin'
    ? createElectronMedia({ preload: path.join(__dirname, 'capturePreload.cjs'), pageUrl: pageUrl(CAPTURE_WINDOW_VITE_DEV_SERVER_URL, CAPTURE_WINDOW_VITE_NAME) })
    : null;

// Main-only: the environment can turn route card 07 on, never choose where it goes.
const baseRewrite = baseRewriteEnabled(process.env) ? createLoopbackTransport({ port: BASE_REWRITE_PORT }) : undefined;

const { main: desktop } = createSyntheticMain({
  baseRewrite,
  chooser: createElectronChooser(),
  microphone: media?.microphone,
  capture: media?.capture,
  clipboard: { writeText: (text) => clipboard.writeText(text) },
  send(windowId, channel, event) {
    const target = BrowserWindow.getAllWindows().find((w) => w.webContents.id === windowId);
    if (target !== undefined && !target.webContents.isDestroyed()) target.webContents.send(channel, event);
  },
});

for (const [intent, channel] of Object.entries(CHANNELS)) {
  // invoke, not handle: async intents (the audio chooser) resolve later.
  if (intent !== 'event') ipcMain.handle(channel, (event, payload: unknown) => desktop.invoke(channel, callerFromElectronEvent(event), payload));
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 320,
    minHeight: 480,
    title: 'Xenon Writing',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // No spellchecking where it would need downloaded dictionaries (see 'session-created' below).
      spellcheck: process.platform === 'darwin',
    },
  });
  const contents = window.webContents;
  const url = pageUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL, MAIN_WINDOW_VITE_NAME);
  // Only this window's top frame at exactly this URL may call main.
  const id = contents.id;
  desktop.registerWindow(id, url);
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) desktop.windowNavigated(id);
  });
  contents.on('render-process-gone', () => desktop.windowNavigated(id));
  contents.on('destroyed', () => desktop.windowClosed(id));
  void window.loadURL(url);
}

// Offline: on Windows and Linux every new session starts loading Chromium's Hunspell dictionaries for
// the app locale and downloads any it lacks, before any window exists. Clear the list the moment each
// session is created. macOS spellchecks locally with the OS. Re-enabling needs a bundled dictionary.
if (process.platform !== 'darwin') {
  app.on('session-created', (created) => {
    created.setSpellCheckerLanguages([]);
    created.setSpellCheckerEnabled(false);
  });
}

// The renderer only shows bundled local content: no new windows, navigation
// away from it, or embedded webviews.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

void app.whenReady().then(() => {
  // Never prompt at launch: main asks macOS only from a deliberate Record (Packet E).
  // Everything is denied except audio for the hidden capture window while a recording is opening or open.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    const request = { contentsId: contents.id, permission, mediaTypes, requestingUrl: details.requestingUrl, isMainFrame: details.isMainFrame };
    callback(media?.allowsMedia(request) ?? false);
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (contents === null || media === null) return false;
    const request = { contentsId: contents.id, permission, mediaTypes: [details.mediaType ?? 'unknown'], requestingUrl: details.requestingUrl ?? '', isMainFrame: details.isMainFrame };
    return media.allowsMedia(request);
  });
  createWindow();
  app.on('activate', () => {
    // The hidden capture window is not an app window.
    if (BrowserWindow.getAllWindows().every((w) => media?.owns(w.webContents.id) ?? false)) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
