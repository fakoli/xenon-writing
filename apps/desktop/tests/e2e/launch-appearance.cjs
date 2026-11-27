// Loaded into Electron's main process with `-r`, after the offline trap and
// before the app's own code, by the offline tests tagged @dark-launch or
// @light-launch only. Until the first window exists, the system appearance
// reads as XENON_TEST_APPEARANCE (dark or light) through the one value main
// consults, `nativeTheme.shouldUseDarkColors`, whatever this machine's own
// appearance; `themeSource` stays "system". One tick after the window exists
// (already visible, long before its page first paints), its background is
// recorded and the real appearance comes back. Nothing here touches the network.
'use strict';

const { app, nativeTheme } = require('electron');

const appearance = process.env.XENON_TEST_APPEARANCE;
if (appearance !== 'dark' && appearance !== 'light') throw new Error('XENON_TEST_APPEARANCE must be dark or light');
// Electron defines it as the instance's own getter; keep that to put back.
const real = Object.getOwnPropertyDescriptor(nativeTheme, 'shouldUseDarkColors');
if (real === undefined || typeof real.get !== 'function') throw new Error('nativeTheme.shouldUseDarkColors is not an own getter');
Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { ...real, get: () => appearance === 'dark' });

const backgrounds = (globalThis.__windowBackgrounds = []);
app.on('browser-window-created', (_event, window) => {
  setImmediate(() => {
    backgrounds.push({ id: window.webContents.id, background: window.getBackgroundColor() });
    Object.defineProperty(nativeTheme, 'shouldUseDarkColors', real); // the machine's own appearance again
  });
});
