/**
 * Electron binding for the audio chooser (Packet B part 2): a native open
 * dialog parented to the caller's window, then a bounded read of the one
 * file picked. Opens only from a chooseAudio intent, never at launch.
 */
import { BrowserWindow, dialog } from 'electron';
import { constants, open } from 'node:fs/promises';
import { createChooser } from './chooser.ts';
import type { AudioChooserPort } from './media.ts';

export function createElectronChooser(): AudioChooserPort {
  return createChooser({
    async showOpenDialog(windowId) {
      const parent = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === windowId);
      if (parent === undefined) return null;
      return dialog.showOpenDialog(parent, {
        title: 'Import audio',
        properties: ['openFile'],
        filters: [{ name: 'WAV audio', extensions: ['wav'] }],
      });
    },
    async readHead(file, limit) {
      // Non-blocking, so a FIFO or a serial device opens at once and then fails the regular-file check
      // instead of blocking until a writer or carrier appears. Regular files read normally.
      const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        if (!(await handle.stat()).isFile()) throw new Error('not a regular file');
        const buffer = new Uint8Array(limit);
        let filled = 0;
        while (filled < limit) {
          const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return buffer.slice(0, filled);
      } finally {
        await handle.close();
      }
    },
  });
}
