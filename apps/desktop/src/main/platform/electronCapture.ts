/**
 * Electron binding for macOS microphone permission and capture (Packet E).
 * Permission comes from macOS through systemPreferences. Recording happens in
 * a hidden, sandboxed capture window whose page streams samples to main; main
 * grants that window, and only that window, the audio permission while a
 * recording is opening or open. macOS shows its own microphone indicator in
 * the menu bar while the input is in use.
 */
import { BrowserWindow, ipcMain, systemPreferences } from 'electron';
import type { CaptureEndReason } from '../../contracts/ipc.ts';
import { CaptureUnavailable } from './capture.ts';
import type { CapturePort, MicrophonePort } from './capture.ts';
import { createCapturePort } from './captureCore.ts';
import type { CaptureDriver, CaptureListener } from './captureCore.ts';
import { CAPTURE_CHANNELS, chunkSamples, createMacMicrophone, unavailableReason } from './captureProtocol.ts';

/** How long the input may take to open before the start counts as failed. */
const OPEN_TIMEOUT_MS = 10_000;

export interface ElectronMedia {
  readonly microphone: MicrophonePort;
  readonly capture: CapturePort;
  /** Whether a media permission request or check comes from the open capture window's own page, top frame, audio only. */
  allowsMedia(request: { contentsId: number; permission: string; mediaTypes: readonly string[]; requestingUrl: string; isMainFrame: boolean }): boolean;
  /** Whether this webContents belongs to the hidden capture window (so it never counts as an app window). */
  owns(contentsId: number): boolean;
}

/** The URL without its fragment, or null when it is not a URL. */
function pageOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

export function createElectronMedia(options: { readonly preload: string; readonly pageUrl: string }): ElectronMedia {
  const microphone = createMacMicrophone(systemPreferences);
  const capturePage = pageOf(options.pageUrl);
  // One capture app-wide (main enforces it too), so one current window and listener.
  let current: { window: BrowserWindow; listener: CaptureListener; settle: (error?: unknown) => void; flushed: (() => void) | null } | null = null;

  /** Messages count only from the current capture window's top frame. */
  const from = (event: Electron.IpcMainEvent) =>
    current !== null && !current.window.isDestroyed() && event.sender === current.window.webContents && event.senderFrame === current.window.webContents.mainFrame;

  ipcMain.on(CAPTURE_CHANNELS.started, (event) => {
    if (from(event)) current?.settle();
  });
  ipcMain.on(CAPTURE_CHANNELS.failed, (event, name: unknown) => {
    if (from(event)) current?.settle(new CaptureUnavailable(unavailableReason(name)));
  });
  ipcMain.on(CAPTURE_CHANNELS.chunk, (event, payload: unknown) => {
    if (!from(event)) return; // check the sender before touching the payload
    const samples = chunkSamples(payload);
    if (samples !== null) current?.listener.chunk(samples);
  });
  ipcMain.on(CAPTURE_CHANNELS.ended, (event) => {
    if (!from(event)) return;
    // The track cannot say why it ended; macOS can say whether access was taken away.
    let reason: CaptureEndReason = 'device_lost';
    try {
      if (microphone.status() !== 'granted') reason = 'revoked';
    } catch {
      // an unreadable state is not evidence of a revoke
    }
    current?.listener.ended(reason);
  });
  ipcMain.on(CAPTURE_CHANNELS.flushed, (event) => {
    if (from(event)) current?.flushed?.();
  });

  const driver = (): CaptureDriver => {
    let window: BrowserWindow | null = null;
    const close = () => {
      if (current !== null && current.window === window) current = null;
      if (window !== null && !window.isDestroyed()) window.destroy();
      window = null;
    };
    return {
      open(listener) {
        return new Promise<void>((resolve, reject) => {
          window = new BrowserWindow({
            show: false,
            webPreferences: {
              preload: options.preload,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webviewTag: false,
              spellcheck: false,
              // Keep the hidden page's audio processing running at full rate.
              backgroundThrottling: false,
            },
          });
          let settled = false;
          const timer = setTimeout(() => settle(new CaptureUnavailable('failed')), OPEN_TIMEOUT_MS);
          const settle = (error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error === undefined) resolve();
            else reject(error);
          };
          current = { window, listener, settle, flushed: null };
          const contents = window.webContents;
          contents.on('render-process-gone', () => {
            settle(new CaptureUnavailable('failed'));
            listener.ended('device_lost');
          });
          // The page loads once. A reload or any later top-frame navigation ends the capture, so a page
          // other than the one main opened can never hold the microphone.
          let loaded = false;
          contents.once('did-finish-load', () => (loaded = true));
          contents.on('did-start-navigation', (details) => {
            if (!loaded || !details.isMainFrame || details.isSameDocument) return;
            settle(new CaptureUnavailable('failed'));
            listener.ended('device_lost');
            close();
          });
          window.loadURL(options.pageUrl).catch(() => settle(new CaptureUnavailable('failed')));
        });
      },
      flush(ms) {
        return new Promise<void>((resolve) => {
          // Only this driver's own window: never a later capture's.
          if (current === null || window === null || window.isDestroyed() || current.window !== window) return resolve();
          const timer = setTimeout(resolve, ms);
          current.flushed = () => {
            clearTimeout(timer);
            resolve();
          };
          window.webContents.send(CAPTURE_CHANNELS.flush);
        });
      },
      close,
    };
  };

  return {
    microphone,
    capture: createCapturePort(driver),
    allowsMedia({ contentsId, permission, mediaTypes, requestingUrl, isMainFrame }) {
      return (
        current !== null &&
        !current.window.isDestroyed() &&
        contentsId === current.window.webContents.id &&
        isMainFrame &&
        pageOf(requestingUrl) === capturePage &&
        permission === 'media' &&
        mediaTypes.length > 0 &&
        mediaTypes.every((type) => type === 'audio')
      );
    },
    owns(contentsId) {
      return current !== null && !current.window.isDestroyed() && contentsId === current.window.webContents.id;
    },
  };
}
