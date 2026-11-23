/**
 * Preload for the hidden capture window only (Packet E, macOS). It hands the
 * capture page the few messages it needs and nothing else; the app window's
 * preload never exposes these.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CAPTURE_CHANNELS } from '../main/platform/captureProtocol.ts';

contextBridge.exposeInMainWorld('captureHost', {
  started: () => ipcRenderer.send(CAPTURE_CHANNELS.started),
  failed: (name: unknown) => ipcRenderer.send(CAPTURE_CHANNELS.failed, typeof name === 'string' ? name.slice(0, 64) : 'Error'),
  chunk: (buffer: ArrayBuffer) => ipcRenderer.send(CAPTURE_CHANNELS.chunk, buffer),
  ended: () => ipcRenderer.send(CAPTURE_CHANNELS.ended),
  flushed: () => ipcRenderer.send(CAPTURE_CHANNELS.flushed),
  onFlush: (listener: () => void) => {
    ipcRenderer.on(CAPTURE_CHANNELS.flush, () => listener());
  },
});
