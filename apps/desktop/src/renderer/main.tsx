import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopApi } from '../preload/desktop.ts';
import { Composer } from './Composer.tsx';
import type { SessionInit } from './Composer.tsx';
import './styles.css';

const OFFLINE: SessionInit = { sessionId: 'offline', epoch: 0, route: null };

/** Opens a session through the preload façade; without one, the shell runs offline. */
async function start(): Promise<void> {
  const api = (globalThis as { xenon?: DesktopApi }).xenon ?? null;
  const opened = api === null ? null : await api.createSession();
  const rewriteRoute = opened?.ok ? opened.value.capabilities.routes.find((route) => route.stage === 'rewrite' && route.readiness === 'ready') : undefined;
  const session: SessionInit = opened?.ok
    ? {
        sessionId: opened.value.sessionId,
        epoch: opened.value.epoch,
        route: rewriteRoute ?? null,
        ...(rewriteRoute === undefined ? {} : { routeLabel: rewriteRoute.label, routeLocationClass: rewriteRoute.locationClass }),
        transcribeRoute: opened.value.capabilities.routes.find((route) => route.stage === 'transcribe' && route.readiness === 'ready') ?? null,
        actions: opened.value.capabilities.actions,
      }
    : OFFLINE;
  const root = document.getElementById('root');
  if (root === null) throw new Error('missing #root');
  createRoot(root).render(
    <StrictMode>
      <Composer api={opened?.ok ? api : null} session={session} />
    </StrictMode>,
  );
}

void start();
