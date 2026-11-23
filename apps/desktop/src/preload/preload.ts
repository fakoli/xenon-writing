/**
 * Preload entry: the only file that touches Electron in the renderer process.
 * It hands Packet C's façade the two IPC primitives and exposes nothing else.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopApi } from './desktop.ts';

contextBridge.exposeInMainWorld(
  'xenon',
  createDesktopApi({
    invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
    subscribe(channel, listener) {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  }),
);
