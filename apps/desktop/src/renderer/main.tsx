import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { MainEvent } from '../contracts/session.ts';
import type { DesktopApi } from '../preload/desktop.ts';
import { Composer } from './Composer.tsx';
import type { EarlyEvents, SessionInit } from './Composer.tsx';
import './styles.css';

const OFFLINE: SessionInit = { sessionId: 'offline', epoch: 0, route: null };

/** Opens a session through the preload façade; without one, the shell runs offline. */
async function start(): Promise<void> {
  const api = (globalThis as { xenon?: DesktopApi }).xenon ?? null;
  // Main may send events (an outcome turning unknown, or clearing) between its reply and the Composer's first
  // subscription. Listen from before the call and hand them over, so none is lost.
  const early: EarlyEvents = { events: [] as MainEvent[], stop: () => {} };
  if (api !== null) early.stop = api.onEvent((event) => early.events.push(event));
  const opened = api === null ? null : await api.createSession();
  if (!opened?.ok) early.stop();
  const rewriteRoute = opened?.ok ? opened.value.capabilities.routes.find((route) => route.stage === 'rewrite' && route.readiness === 'ready') : undefined;
  const session: SessionInit = opened?.ok
    ? {
        sessionId: opened.value.sessionId,
        epoch: opened.value.epoch,
        route: rewriteRoute ?? null,
        ...(rewriteRoute === undefined ? {} : { routeLabel: rewriteRoute.label, routeLocationClass: rewriteRoute.locationClass }),
        transcribeRoute: opened.value.capabilities.routes.find((route) => route.stage === 'transcribe' && route.readiness === 'ready') ?? null,
        actions: opened.value.capabilities.actions,
        routes: opened.value.capabilities.routes,
        // The gate is app-wide: a reload learns here that new work waits, and Inspect is offered (the reducer keeps well-formed reports only).
        outcomes: Array.isArray(opened.value.unresolved) ? opened.value.unresolved : [],
      }
    : OFFLINE;
  const root = document.getElementById('root');
  if (root === null) throw new Error('missing #root');
  createRoot(root).render(
    <StrictMode>
      <Composer api={opened?.ok ? api : null} session={session} early={early} />
    </StrictMode>,
  );
}

void start();
