import { VitePlugin } from '@electron-forge/plugin-vite';

// Packet B: development start and an unsigned local package only. Makers,
// fuses, signing and publishing wait for separate platform and release
// decisions.
export default {
  packagerConfig: {
    asar: true,
    // macOS on Apple silicon is the only target (owner decision 2026-11-18); macOS 15 is the chosen minimum.
    extendInfo: {
      LSMinimumSystemVersion: '15.0',
      // Shown in macOS's microphone prompt, which appears only after a deliberate Record and the app's own explanation.
      NSMicrophoneUsageDescription: 'Xenon Writing uses the microphone only when you choose Record, to make a transcript you review before it changes your text.',
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.main.config.ts', target: 'preload' },
        // The hidden capture window's own preload (Packet E, macOS).
        { entry: 'src/preload/capturePreload.ts', config: 'vite.main.config.ts', target: 'preload' },
      ],
      renderer: [
        { name: 'main_window', config: 'vite.renderer.config.ts' },
        { name: 'capture_window', config: 'vite.capture.config.ts' },
      ],
    }),
  ],
};
