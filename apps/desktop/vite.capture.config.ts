import path from 'node:path';
import { defineConfig } from 'vite';

// The hidden capture window (Packet E, macOS): its own root and page, built next to the app's renderer.
// Forge's renderer outDir is relative to the root, so it is set absolutely here.
export default defineConfig({
  root: path.resolve('src/capture'),
  base: './',
  build: { outDir: path.resolve('.vite/renderer/capture_window'), emptyOutDir: true },
});
