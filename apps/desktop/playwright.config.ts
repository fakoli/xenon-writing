import { defineConfig, devices } from '@playwright/test';

// Drives the production renderer build (`npm run test:e2e` builds it first)
// in Chromium. Files are served by request interception, so the run opens no
// sockets and every other request is aborted.
export default defineConfig({
  testDir: 'tests/e2e',
  // offline.spec.ts needs the built app in Electron: playwright.electron.config.ts.
  testIgnore: 'offline.spec.ts',
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 760 } },
});
