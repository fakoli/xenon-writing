/**
 * Main-process session registry (Packet C).
 *
 * Tracks trusted windows and at most one open session per window. Session
 * IDs and draft handles are opaque and main-issued; request records and
 * handles are looked up only inside the calling window's own session, so
 * they cannot cross windows or sessions. Closing a session or destroying its
 * window revokes its handles and bumps the window's epoch, so stale requests
 * match nothing. Running jobs and unknown outcomes are tracked app-wide in
 * ipc.ts, because they outlive the session that started them.
 */
import type { AudioSummary, IpcResult } from '../contracts/ipc.ts';

/** The calling frame, normalized from Electron's invoke event by the wiring. */
export interface Caller {
  /** The sender's webContents ID. */
  readonly windowId: number;
  readonly frameUrl: string;
  readonly isTopFrame: boolean;
}

/** First outcome for a request ID, replayed for an identical retry. */
export interface RequestRecord {
  readonly fingerprint: string;
  readonly result: IpcResult<unknown>;
  /** Null when the request was rejected before acceptance. */
  readonly jobId: string | null;
}

export interface Session {
  readonly sessionId: string;
  readonly epoch: number;
  readonly windowId: number;
  open: boolean;
  /** Request ID → first result, oldest first. Capped; see MAX_REQUEST_RECORDS. */
  readonly requests: Map<string, RequestRecord>;
  /** Draft handle → text, oldest first. Only main ever holds the text for copy. */
  readonly drafts: Map<string, string>;
  /** Asset token → validated audio. At most one; a new choice replaces it. */
  readonly assets: Map<string, SessionAsset>;
}

export interface SessionAsset {
  /** Canonical WAV: only fmt and data, in memory main allocated. */
  readonly bytes: Uint8Array;
  readonly summary: AudioSummary;
}

/**
 * Most draft handles a session keeps. Which retained draft is "current" or
 * "previous" is the renderer reducer's call, since main cannot see edits; a
 * small window keeps a discarded late result from evicting the draft still
 * on screen.
 */
export const MAX_DRAFT_HANDLES = 8;

/**
 * Most request records a session keeps for dedupe. Retries arrive close
 * together, so the oldest settled records are evicted first; a running job's
 * record is never evicted.
 */
export const MAX_REQUEST_RECORDS = 256;

export interface SessionRegistry {
  /** Trusts one window's top frame at exactly this URL (fragment ignored). */
  registerWindow(windowId: number, trustedUrl: string): void;
  isTrusted(caller: Caller): boolean;
  current(windowId: number): Session | null;
  /** Opens a new session; the caller must close any current one first. */
  open(windowId: number): Session;
  /** The caller window's open session, only if ID and epoch both match. */
  find(windowId: number, sessionId: unknown, epoch: unknown): Session | null;
  /** Main-side lookup of an open session by ID, for reconciliation. */
  lookup(sessionId: string): Session | null;
  /** Every open session, across windows, for app-wide reports such as unknown outcomes. */
  openSessions(): Session[];
  /** Closes the session, revokes its handles and bumps the window's epoch. */
  close(session: Session): void;
  /** Forgets the window entirely; returns the session it closed, if any. */
  forgetWindow(windowId: number): Session | null;
  /** Stores draft text under a new handle, evicting the oldest past the cap. */
  issueDraft(session: Session, text: string): string;
  newId(): string;
}

interface WindowState {
  trustedUrl: string;
  epoch: number;
  session: Session | null;
}

function withoutFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

export type IdSource = () => string;

const randomId: IdSource = () => globalThis.crypto.randomUUID();

export function createSessionRegistry(newId: IdSource = randomId): SessionRegistry {
  const windows = new Map<number, WindowState>();

  function close(session: Session): void {
    if (!session.open) return;
    session.open = false;
    session.drafts.clear();
    session.requests.clear();
    session.assets.clear();
    const state = windows.get(session.windowId);
    if (state !== undefined && state.session === session) {
      state.session = null;
      state.epoch += 1;
    }
  }

  return {
    registerWindow(windowId, trustedUrl) {
      if (!Number.isSafeInteger(windowId) || typeof trustedUrl !== 'string' || trustedUrl === '' || trustedUrl.includes('#')) {
        throw new Error('registerWindow needs an integer window ID and a URL without a fragment');
      }
      if (windows.has(windowId)) throw new Error('window already registered');
      windows.set(windowId, { trustedUrl, epoch: 0, session: null });
    },

    isTrusted(caller) {
      const state = windows.get(caller.windowId);
      return state !== undefined && caller.isTopFrame === true && withoutFragment(caller.frameUrl) === state.trustedUrl;
    },

    current(windowId) {
      return windows.get(windowId)?.session ?? null;
    },

    open(windowId) {
      const state = windows.get(windowId);
      if (state === undefined) throw new Error('window not registered');
      if (state.session !== null) throw new Error('close the current session first');
      state.epoch += 1;
      const session: Session = {
        sessionId: newId(),
        epoch: state.epoch,
        windowId,
        open: true,
        requests: new Map(),
        drafts: new Map(),
        assets: new Map(),
      };
      state.session = session;
      return session;
    },

    find(windowId, sessionId, epoch) {
      const session = windows.get(windowId)?.session ?? null;
      if (session === null || !session.open) return null;
      return session.sessionId === sessionId && session.epoch === epoch ? session : null;
    },

    lookup(sessionId) {
      for (const state of windows.values()) {
        if (state.session !== null && state.session.open && state.session.sessionId === sessionId) return state.session;
      }
      return null;
    },

    openSessions() {
      const open: Session[] = [];
      for (const state of windows.values()) if (state.session !== null && state.session.open) open.push(state.session);
      return open;
    },

    close,

    forgetWindow(windowId) {
      const session = windows.get(windowId)?.session ?? null;
      if (session !== null) close(session);
      windows.delete(windowId);
      return session;
    },

    issueDraft(session, text) {
      const handle = newId();
      session.drafts.set(handle, text);
      while (session.drafts.size > MAX_DRAFT_HANDLES) {
        const oldest = session.drafts.keys().next().value;
        if (oldest === undefined) break;
        session.drafts.delete(oldest);
      }
      return handle;
    },

    newId,
  };
}
