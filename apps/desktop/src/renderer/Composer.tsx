/**
 * Packet B accessible shell: toolbar, source pane and draft pane around the
 * Packet A reducer. Session rules live in session.ts, the recorder's in
 * recording.ts and the first-send consent rule in sendConsent.ts; this file
 * dispatches intents and forwards frozen requests to Packet C's façade.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTRACT_VERSION } from '../contracts/session.ts';
import type { FailureCode, RouteDescriptor } from '../contracts/session.ts';
import type { AudioSummary, CapabilityAction, CaptureEndReason } from '../contracts/ipc.ts';
import type { DesktopApi } from '../preload/desktop.ts';
import { copyEligibility, createSession, reduce, rewriteBlocker, rewriteRequest, transcribeBlocker, transcribeRequest } from './session.ts';
import type { SessionAction, SessionState } from './session.ts';
import { TranscriptPane } from './TranscriptPane.tsx';
import { filledFromAudio, noticeKind } from './noticeKind.ts';
import { createRecorder, recorderBusy, reduceRecorder } from './recording.ts';
import type { RecorderAction, RecorderState } from './recording.ts';
import type { JobKind } from './session.ts';
import { DraftPane, modeLabel } from './DraftPane.tsx';
import type { CopyOutcome } from './DraftPane.tsx';
import { canConfirmSend, destinationText, needsSendConfirmation } from './sendConsent.ts';

export interface SessionInit {
  readonly sessionId: string;
  readonly epoch: number;
  readonly route: RouteDescriptor | null;
  readonly transcribeRoute?: RouteDescriptor | null;
  /** Main's label for the rewrite route, e.g. "Local base model (test text only)". */
  readonly routeLabel?: string;
  /** Where the rewrite route runs: synthetic, local or remote. */
  readonly routeLocationClass?: string;
  /** What main offers this session; audio actions appear only when offered. */
  readonly actions?: readonly CapabilityAction[];
}

/** Why an import failed, in words, with what the user can do next. */
const IMPORT_FAILURES: Partial<Record<FailureCode, string>> = {
  invalid_input: 'That file can’t be used. Choose a WAV file that is mono, 16 kHz, 16-bit and at most 30 seconds.',
  unsupported: 'That WAV is in another format. Choose a mono, 16 kHz, 16-bit WAV of at most 30 seconds.',
  route_unavailable: 'That file couldn’t be opened. Try again, or choose another file.',
  denied: 'This session ended before the file arrived. Choose it again.',
};

// Fixed steps; a persisted preference waits for an approved storage design.
const TEXT_SCALES = [0.875, 1, 1.125, 1.25, 1.5, 1.75, 2] as const;
const DEFAULT_SCALE_INDEX = 1;

/** Reducer state plus what the shell derives from each transition. */
interface SessionView {
  readonly state: SessionState;
  /** Which job the shown notice is about. */
  readonly kind: JobKind;
  /** The last change was a transcription filling the empty transcript. */
  readonly filled: boolean;
}

/** Holds the reducer state; a ref keeps event handlers on the latest state. */
function useSession(api: DesktopApi | null, init: SessionInit) {
  const ref = useRef<SessionView | null>(null);
  if (ref.current === null) ref.current = { state: createSession(init), kind: 'rewrite', filled: false };
  const [view, setView] = useState(ref.current);
  const apply = useCallback((action: SessionAction): SessionState => {
    const current = ref.current as SessionView;
    const next = reduce(current.state, action);
    if (next !== current.state) {
      ref.current = { state: next, kind: noticeKind(current.state, next, action, current.kind), filled: filledFromAudio(current.state, next) };
      setView(ref.current);
    }
    return next;
  }, []);
  useEffect(() => api?.onEvent(apply), [api, apply]);
  return { ...view, apply, latest: () => (ref.current as SessionView).state };
}

/** A capture ending that arrived while the start was still pending. */
interface EarlyEnd {
  readonly handle: string;
  readonly reason: CaptureEndReason;
  readonly now: number;
}

/** The recorder's UI state, with a ref so async results act on the latest state. */
function useRecorder() {
  const ref = useRef<RecorderState>(createRecorder());
  const [rec, setRec] = useState(ref.current);
  const send = useCallback((action: RecorderAction): RecorderState => {
    const next = reduceRecorder(ref.current, action);
    if (next !== ref.current) {
      ref.current = next;
      setRec(next);
    }
    return next;
  }, []);
  return { rec, send, current: () => ref.current };
}

export function Composer({ api, session }: { readonly api: DesktopApi | null; readonly session: SessionInit }) {
  const { state, kind, filled, apply, latest } = useSession(api, session);
  const importing = useRef(false);
  const { rec, send, current } = useRecorder();
  const capture = api !== null && (session.actions ?? []).includes('capture');
  const envelope = () => {
    const { sessionId, epoch } = latest();
    return { v: CONTRACT_VERSION, sessionId, epoch } as const;
  };

  // An ending can arrive before the start's reply (a port that ends at once); it is applied when the handle is known.
  const earlyEnd = useRef<EarlyEnd | null>(null);

  useEffect(() => {
    if (api === null || !capture) return;
    // Reading the permission state never prompts (Packet E3). At load it only explains a blocked microphone up front.
    void api.microphoneStatus(envelope()).then((r) => r.ok && send({ type: 'mic.status', microphone: r.value.microphone }));
    return api.onEvent((event) => {
      if (event.type !== 'capture.ended') return;
      const end = { handle: event.captureHandle, reason: event.reason, now: Date.now() };
      if (current().phase === 'starting') earlyEnd.current = end;
      else send({ type: 'ended', ...end });
    });
    // envelope reads the latest session through a ref, so it is not a dependency.
  }, [api, capture, send]);
  const [scaleIndex, setScaleIndex] = useState(DEFAULT_SCALE_INDEX);
  const [audio, setAudio] = useState<{ token: string; summary: AudioSummary } | null>(null);
  const [audioNote, setAudioNote] = useState<string | null>(null);
  const offered = new Set(session.actions ?? []);

  useEffect(() => {
    document.documentElement.style.setProperty('--text-scale', String(TEXT_SCALES[scaleIndex]));
  }, [scaleIndex]);

  /** Opens the native chooser; only a chosen file changes anything. */
  const importAudio = async () => {
    // One dialog per click: a second press while it is open does nothing. A recording on screen comes first.
    if (api === null || importing.current || recorderBusy(current())) return;
    importing.current = true;
    const { sessionId, epoch } = latest();
    let result: Awaited<ReturnType<DesktopApi['chooseAudio']>>;
    try {
      result = await api.chooseAudio({ v: CONTRACT_VERSION, sessionId, epoch });
    } finally {
      importing.current = false;
    }
    if (!result.ok) {
      setAudioNote(IMPORT_FAILURES[result.code] ?? 'That file couldn’t be imported. Choose another.');
      return;
    }
    if (result.value.status === 'cancelled') {
      setAudioNote(null); // closing the dialog is a fresh start, not an error
      return;
    }
    if (result.value.status === 'already_open') {
      setAudioNote('A file chooser is already open.');
      return;
    }
    takeAudio(result.value.assetToken, result.value.summary);
  };

  /** New audio from a file or a recording replaces the old, as main already did. */
  const takeAudio = (assetToken: string, summary: AudioSummary) => {
    apply({ type: 'audio.chosen', assetToken });
    setAudio({ token: assetToken, summary });
    setAudioNote(null);
  };

  /** Asks main to start the app's one capture; main prompts only if the OS never asked. */
  const beginCapture = async () => {
    if (api === null) return;
    earlyEnd.current = null;
    const result = await api.startCapture(envelope());
    const next = send({ type: 'start.result', result, now: Date.now() });
    const end = earlyEnd.current as EarlyEnd | null; // set by the event listener during the await
    earlyEnd.current = null;
    if (end !== null && end.handle === next.handle) send({ type: 'ended', ...end });
  };

  /** Runs a recorder step and reports whether it moved into "starting" just now. */
  const reachesStart = (action: RecorderAction) => {
    const before = current().phase;
    return before !== 'starting' && send(action).phase === 'starting';
  };

  /** Record reads the permission state afresh (never prompting), then explains unless it is already decided. */
  const record = async () => {
    const phase = current().phase;
    // Recording again is allowed while a kept recording waits for confirmation; it drops the prompt.
    if (api === null || (phase !== 'idle' && phase !== 'confirming') || send({ type: 'record' }).phase !== 'checking') return;
    const read = await api.microphoneStatus(envelope()).catch(() => null);
    if (reachesStart({ type: 'mic.checked', microphone: read?.ok === true ? read.value.microphone : null })) void beginCapture();
  };

  const continueRecording = () => {
    if (reachesStart({ type: 'explain.continue' })) void beginCapture();
  };

  const stopRecording = async () => {
    const before = current();
    if (api === null || before.handle === null || send({ type: 'stop' }) === before) return;
    const result = await api.stopCapture({ ...envelope(), captureHandle: before.handle });
    // Stop keeps the audio but never sends it anywhere: transcribing waits for a second, deliberate click
    // (owner decision 2026-11-18).
    if (result.ok && result.value.status === 'chosen') takeAudio(result.value.assetToken, result.value.summary);
    send({ type: 'stop.result', result, ask: canTranscribeAudio() });
  };

  const canTranscribeAudio = () => api !== null && offered.has('transcribe') && latest().transcribeRoute !== null;

  /** The second click: transcribe exactly the kept recording, under the usual rules (blockers, Replace). */
  const confirmTranscription = () => {
    const kept = current().keptAsset;
    if (kept === null || current().phase !== 'confirming') return;
    if (latest().selectedAsset !== kept) {
      send({ type: 'confirm.drop' });
      return;
    }
    if (transcribeBlocker(latest()) !== null) return; // the button says why it waits
    send({ type: 'confirm.transcribe' });
    transcribe();
  };

  // A confirmation is only for the kept recording: other audio, or a transcription started another way, ends it.
  useEffect(() => {
    const moved = state.selectedAsset !== rec.keptAsset || state.transcription !== null;
    if (rec.phase === 'confirming' && moved) send({ type: 'confirm.drop' });
    // "Nothing was sent" stops being true once that recording is sent or replaced.
    if (rec.phase === 'idle' && rec.note?.kind === 'waiting' && moved) send({ type: 'note.clear' });
  }, [rec.phase, rec.note, rec.keptAsset, state.selectedAsset, state.transcription, send]);

  const discardRecording = async () => {
    const before = current();
    if (api === null || before.handle === null || send({ type: 'discard' }) === before) return;
    const result = await api.discardCapture({ ...envelope(), captureHandle: before.handle });
    send({ type: 'discard.result', result });
  };

  const recheckMicrophone = async (): Promise<void> => {
    if (api === null) return;
    const result = await api.microphoneStatus(envelope());
    if (result.ok) send({ type: 'mic.status', microphone: result.value.microphone });
  };

  const transcribe = () => {
    const assetToken = latest().selectedAsset;
    if (assetToken === null) return;
    const clientRequestId = crypto.randomUUID();
    const request = transcribeRequest(apply({ type: 'transcribe.request', clientRequestId, assetToken }));
    if (request !== null && request.clientRequestId === clientRequestId) void api?.transcribe(request);
  };

  // Route card 07's consent step (sendConsent.ts): before text first leaves the app, ask once per session.
  const [sendConfirmed, setSendConfirmed] = useState(false);
  const [confirmingSend, setConfirmingSend] = useState(false);
  const requestRewrite = () => {
    if (needsSendConfirmation(state.route, sendConfirmed)) setConfirmingSend(true);
    else rewrite();
  };
  // After either answer, focus goes to the status line, not Rewrite: a repeated Enter must not send or reopen.
  const focusStatus = () => document.getElementById('source-status')?.focus();
  const confirmSend = () => {
    // A send that cannot happen records no consent; the confirmation stays open and says why.
    if (!canConfirmSend(rewriteBlocker(latest()))) return;
    setSendConfirmed(true);
    setConfirmingSend(false);
    rewrite();
    focusStatus();
  };
  const declineSend = () => {
    setConfirmingSend(false);
    focusStatus();
  };

  const rewrite = () => {
    const clientRequestId = crypto.randomUUID();
    const request = rewriteRequest(apply({ type: 'rewrite.request', clientRequestId }));
    // Main answers with events, refusals included, so the result is not needed here.
    if (request !== null && request.clientRequestId === clientRequestId) void api?.rewrite(request);
  };

  /** Cancels whichever job is running: a rewrite or a transcription. */
  const cancel = () => {
    const { pending, transcription, sessionId, epoch } = latest();
    if (pending !== null) {
      apply({ type: 'rewrite.cancel', clientRequestId: pending.clientRequestId });
      void api?.cancel({ v: CONTRACT_VERSION, sessionId, epoch, clientRequestId: pending.clientRequestId });
    } else if (transcription !== null) {
      apply({ type: 'transcribe.cancel', clientRequestId: transcription.clientRequestId });
      void api?.cancel({ v: CONTRACT_VERSION, sessionId, epoch, clientRequestId: transcription.clientRequestId });
    }
  };

  /** Explicit copy of the shown draft; main holds the text and writes the clipboard. */
  const copy = async (): Promise<CopyOutcome> => {
    const { sessionId, epoch } = latest();
    const eligibility = copyEligibility(latest());
    if (api === null || !eligibility.allowed) return 'failed';
    const result = await api.copyDraft({ v: CONTRACT_VERSION, sessionId, epoch, draftHandle: eligibility.draftHandle });
    // Main refuses a handle it no longer holds; a clipboard failure is an unknown outcome and can be retried.
    if (result.ok) return 'copied';
    return result.code === 'denied' ? 'expired' : 'failed';
  };

  const route = state.route;
  const atSmallest = scaleIndex === 0;
  const atLargest = scaleIndex === TEXT_SCALES.length - 1;
  return (
    <div className="app">
      <header className="toolbar">
        <h1>Session</h1>
        <p className="route-summary">{route === null ? 'No processing route' : (session.routeLabel ?? modeLabel(route.mode))}</p>
        {/* aria-disabled, like Rewrite: native disabled would drop keyboard focus at either end of the range. */}
        <div className="text-size" role="group" aria-label="Text size">
          <button
            type="button"
            aria-label="A− Decrease text size"
            aria-disabled={atSmallest}
            onClick={() => !atSmallest && setScaleIndex((i) => Math.max(0, i - 1))}
          >
            A−
          </button>
          <button
            type="button"
            aria-label="A+ Increase text size"
            aria-disabled={atLargest}
            onClick={() => !atLargest && setScaleIndex((i) => Math.min(TEXT_SCALES.length - 1, i + 1))}
          >
            A+
          </button>
        </div>
      </header>
      <main className="panes">
        <TranscriptPane
          state={state}
          kind={kind}
          filled={filled}
          audio={{
            canImport: api !== null && offered.has('chooseAudio'),
            canTranscribe: api !== null && offered.has('transcribe') && state.transcribeRoute !== null,
            summary: audio?.token === state.selectedAsset ? audio.summary : null,
            note: audioNote,
            recorder: capture
              ? {
                  state: rec,
                  onRecord: () => void record(),
                  onContinue: continueRecording,
                  onDismiss: () => send({ type: 'explain.dismiss' }),
                  onStop: () => void stopRecording(),
                  onDiscard: () => void discardRecording(),
                  onRecheck: recheckMicrophone,
                  onConfirm: confirmTranscription,
                  onDecline: () => send({ type: 'confirm.dismiss' }),
                  confirmTarget: state.transcribeRoute === null ? '' : `${modeLabel(state.transcribeRoute.mode)} · ${state.transcribeRoute.identity}`,
                  confirmBlocker: rec.phase === 'confirming' ? transcribeBlocker(state) : null,
                }
              : null,
            recording: recorderBusy(rec),
            onImport: () => void importAudio(),
            onTranscribe: transcribe,
            onReplace: () => apply({ type: 'candidate.replace' }),
            onKeep: () => apply({ type: 'candidate.keep' }),
          }}
          onTranscript={(text) => apply({ type: 'edit.transcript', text })}
          onSteering={(text) => apply({ type: 'edit.steering', text })}
          onRewrite={requestRewrite}
          onCancel={cancel}
          sendConfirm={
            confirmingSend && state.route !== null
              ? {
                  label: session.routeLabel ?? modeLabel(state.route.mode),
                  identity: state.route.identity,
                  destination: destinationText(session.routeLocationClass),
                  blocker: rewriteBlocker(state),
                  onSend: confirmSend,
                  onDecline: declineSend,
                }
              : null
          }
        />
        <DraftPane state={state} onCopy={api === null ? null : copy} />
      </main>
    </div>
  );
}
