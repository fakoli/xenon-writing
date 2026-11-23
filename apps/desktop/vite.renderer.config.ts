import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * index.html carries the packaged CSP. The dev server alone needs inline
 * scripts/styles and a loopback websocket for hot reload, so relax it there.
 */
const devCsp: Plugin = {
  name: 'xenon-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
      .replace("connect-src 'none'", "connect-src 'self' ws://localhost:*"),
};

export default defineConfig({
  base: './',
  plugins: [react(), devCsp],
});
