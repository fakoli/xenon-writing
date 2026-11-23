import { defineConfig } from '@playwright/test';

// Drives the built app (`npm run test:electron` packages it first) in a real
// Electron window. One worker: each test launches its own app instance.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'offline.spec.ts',
  globalSetup: './tests/e2e/electron-build-check.ts',
  forbidOnly: !!process.env.CI,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
});
