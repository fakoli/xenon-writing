/**
 * Global setup for the offline Electron test: refuse to run against a missing,
 * development or stale build, which would test something other than the source.
 * `npm run test:electron` packages first; running Playwright directly needs
 * `npx electron-forge package` after any change.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUTS = ['.vite/build/main.cjs', '.vite/build/preload.cjs', '.vite/build/capturePreload.cjs', '.vite/renderer/main_window/index.html', '.vite/renderer/capture_window/index.html'];
const INPUTS = ['src', 'index.html', 'forge.config.ts', 'vite.main.config.ts', 'vite.renderer.config.ts', 'vite.capture.config.ts', 'package.json'];

function newest(target: string): number {
  const info = statSync(target);
  if (!info.isDirectory()) return info.mtimeMs;
  return Math.max(0, ...readdirSync(target).map((name) => newest(path.join(target, name))));
}

export default function checkBuild(): void {
  const missing = OUTPUTS.filter((file) => !existsSync(path.join(ROOT, file)));
  // A development build (electron-forge start) has no packaged renderer and points at the dev server.
  if (missing.length > 0) throw new Error(`No production build (${missing.join(', ')}). Run \`npm run test:electron\`.`);
  const built = Math.min(...OUTPUTS.map((file) => statSync(path.join(ROOT, file)).mtimeMs));
  const changed = Math.max(...INPUTS.map((input) => newest(path.join(ROOT, input))));
  if (changed > built) throw new Error('The build in .vite is older than the source. Run `npm run test:electron`.');
}
