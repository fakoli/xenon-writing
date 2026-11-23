/**
 * Packet B part 3: Record, the explanation before the first microphone
 * prompt, the recording timer with Stop/Discard, and what each outcome
 * means in words. State lives in recording.ts; Composer sends the intents.
 */
import { useEffect, useRef, useState } from 'react';
import type { CaptureEndReason, CaptureUnavailableReason, MicrophoneState } from '../contracts/ipc.ts';
import type { FailureCode } from '../contracts/session.ts';
import type { RecorderNote, RecorderPhase, RecorderState } from './recording.ts';
import type { TranscribeBlocker } from './session.ts';
import { elapsedMs } from './recording.ts';
import { statusKind } from './statusKind.ts';

export interface RecorderControls {
  readonly state: RecorderState;
  readonly onRecord: () => void;
  readonly onContinue: () => void;
  readonly onDismiss: () => void;
  readonly onStop: () => void;
  readonly onDiscard: () => void;
  /** Re-reads the permission state; never prompts. */
  readonly onRecheck: () => Promise<void>;
  /** The second click after Stop: transcribe the kept recording. */
  readonly onConfirm: () => void;
  /** Not now: keep the recording without transcribing it. */
  readonly onDecline: () => void;
  /** Where transcribing would send the recording, as mode and identity. */
  readonly confirmTarget: string;
  /** Why transcribing must wait for now, or null. */
  readonly confirmBlocker: TranscribeBlocker | null;
}

/** Permission states that are explained without pressing Record (platform design: explain, offer settings and a recheck). */
const MICROPHONE_TEXT: Partial<Record<MicrophoneState, string>> = {
  denied: 'Microphone access is off for this app. Turn it on in your system’s privacy settings, then choose Check again. You can still type or import audio.',
  restricted: 'Microphone access is controlled by a system policy on this computer. You can still type or import audio.',
  unsupported: 'Recording isn’t available on this system. You can type or import audio.',
  unknown: 'The microphone’s permission couldn’t be read. Choose Check again, or type or import audio.',
};

const BLOCKED_TEXT: Record<MicrophoneState, string> = {
  denied: MICROPHONE_TEXT.denied as string,
  restricted: MICROPHONE_TEXT.restricted as string,
  unsupported: MICROPHONE_TEXT.unsupported as string,
  unknown: MICROPHONE_TEXT.unknown as string,
  not_requested: 'Microphone access wasn’t granted. Record again to be asked, or type or import audio.',
  granted: 'Recording couldn’t start. Record again.',
};

const UNAVAILABLE_TEXT: Record<CaptureUnavailableReason, string> = {
  no_input: 'No microphone was found. Connect one, then record again.',
  in_use: 'The microphone is in use by another app. Record again when it’s free.',
  failed: 'The microphone couldn’t start. Record again, or check your sound settings.',
};

function failedText(code: FailureCode): string {
  if (code === 'denied') return 'Recording stopped because this session ended. Nothing was kept.';
  // The reply was lost: main may have started or kept a recording this window never heard about.
  if (code === 'unknown_outcome') return 'The recording’s outcome is unknown, and nothing from it is shown here. If Record says a recording is in progress, close and reopen the window.';
  if (code === 'route_unavailable') return 'The recording couldn’t be saved. Nothing was kept. Record again.';
  if (code === 'unsupported' || code === 'invalid_input' || code === 'invalid_response') return 'The recording couldn’t be used. Nothing was kept. Record again.';
  return 'Recording didn’t work. Nothing was kept. Record again.';
}

function noteText(note: RecorderNote): string {
  switch (note.kind) {
    case 'blocked':
      return BLOCKED_TEXT[note.microphone];
    case 'unavailable':
      return UNAVAILABLE_TEXT[note.reason];
    case 'busy':
      return 'A recording is already in progress in this app.';
    case 'kept':
      return 'Recording kept.';
    case 'waiting':
      return 'Recording kept. Nothing was sent; choose Transcribe when you want a transcript.';
    case 'discarded':
      return 'Recording discarded. Nothing was kept.';
    case 'failed':
      return failedText(note.code);
  }
}

function endedText(reason: CaptureEndReason, maxDurationMs: number): string {
  if (reason === 'max_duration') return `Recording stopped at the ${Math.round(maxDurationMs / 1000)}-second limit. Keep the audio, or discard it.`;
  if (reason === 'revoked') return 'Microphone access was turned off. Keep what was recorded, or discard it.';
  return 'The microphone was disconnected. Keep what was recorded, or discard it.';
}

/** Why the confirmed transcription has to wait, in words. */
const CONFIRM_BLOCKER_TEXT: Record<TranscribeBlocker, string> = {
  pending: 'Transcribing waits until the current job ends.',
  candidate_open: 'Transcribing waits until the waiting transcript is replaced or kept.',
  awaiting_cancellation: 'Transcribing waits for the cancelled job to finish.',
  unresolved_outcome: 'Transcribing is paused until an unknown outcome is reconciled.',
  no_route: 'No transcription route is set up.',
};

function statusText(state: RecorderState, target: string): string {
  if (state.phase === 'confirming') return `Recording kept and not sent. Choose Transcribe recording to send it to ${target}, or Not now.`;
  switch (state.phase) {
    case 'checking':
      return 'Checking the microphone…';
    case 'explaining':
      return ''; // the explanation itself carries the text
    case 'starting':
      return state.microphone === 'not_requested' ? 'Waiting for the microphone. Your computer may ask for permission.' : 'Starting the microphone…';
    case 'recording':
      return 'Recording. Stop keeps it; Discard keeps nothing.';
    case 'ended':
      return endedText(state.endReason ?? 'device_lost', state.maxDurationMs);
    case 'stopping':
      return 'Saving the recording…';
    case 'discarding':
      return 'Discarding the recording…';
    case 'idle':
      return state.note !== null ? noteText(state.note) : state.microphone === null ? '' : (MICROPHONE_TEXT[state.microphone] ?? '');
  }
  return '';
}

function icon(state: RecorderState): string {
  if (state.phase === 'recording') return '●';
  if (state.phase === 'confirming') return '✓';
  // An ending the user did not choose: the time limit is information; access turned off or a lost device is a warning.
  if (state.phase === 'ended') return state.endReason === 'max_duration' ? 'ⓘ' : '⚠';
  if (state.phase !== 'idle') return '…';
  if (state.note?.kind === 'kept' || state.note?.kind === 'waiting') return '✓';
  if (state.note?.kind === 'discarded') return 'ⓘ';
  return '⚠';
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const HELD: readonly RecorderPhase[] = ['recording', 'ended', 'stopping', 'discarding'];

/** Focus is on the page itself (lost) or on the recorder's own controls, so moving it takes nothing from the user. */
function focusIsWithRecorder(): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  return active instanceof HTMLElement && (active.closest('.recorder') !== null || active.id === 'record-button' || active.id === 'record-stop' || active.id === 'record-discard');
}

/** Record, or Stop/Keep and Discard while a recording is held. Goes in the audio row's actions. */
export function RecorderButtons({ recorder }: { readonly recorder: RecorderControls }) {
  const { state } = recorder;
  if (!HELD.includes(state.phase)) {
    // Recording again while a kept recording waits for confirmation is allowed and drops the confirmation.
    const ready = state.phase === 'idle' || state.phase === 'confirming';
    return (
      <button id="record-button" type="button" aria-disabled={!ready} aria-describedby="record-status" onClick={() => ready && recorder.onRecord()}>
        Record
      </button>
    );
  }
  const settling = state.phase === 'stopping' || state.phase === 'discarding';
  return (
    <>
      <button id="record-stop" type="button" aria-disabled={settling} aria-describedby="record-status" onClick={() => !settling && recorder.onStop()}>
        {state.phase === 'ended' ? 'Keep audio' : 'Stop'}
      </button>
      <button id="record-discard" type="button" className="danger" aria-disabled={settling} aria-describedby="record-status" onClick={() => !settling && recorder.onDiscard()}>
        Discard
      </button>
    </>
  );
}

/** The explanation, the timer and the recorder's own status line. Goes under the audio row's actions. */
export function RecorderPanel({ recorder }: { readonly recorder: RecorderControls }) {
  const { state } = recorder;
  const [now, setNow] = useState(() => Date.now());
  const previous = useRef<RecorderPhase>(state.phase);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (state.phase !== 'recording') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [state.phase]);

  // Focus follows the step, but only while it is still with the recorder: it never leaves the editor.
  useEffect(() => {
    const from = previous.current;
    previous.current = state.phase;
    if (from === state.phase) return;
    // The heading, not Continue: a repeated or held Enter on Record must not consent before the text is shown.
    if (state.phase === 'explaining') {
      headingRef.current?.focus();
      return;
    }
    if (!focusIsWithRecorder()) return;
    // After Stop, the heading again: a repeated Enter on Stop must not become the confirming click.
    if (state.phase === 'confirming') confirmRef.current?.focus();
    // After the prompt, the status line, not Record: a repeated Enter must not start a new recording.
    else if (from === 'confirming') document.getElementById('record-status')?.focus();
    else if (state.phase === 'recording' || state.phase === 'ended') document.getElementById('record-stop')?.focus();
    else if (!HELD.includes(state.phase)) document.getElementById('record-button')?.focus();
  }, [state.phase]);

  const text = statusText(state, recorder.confirmTarget);
  const showRecheck = state.phase === 'idle' && (state.microphone === 'denied' || state.microphone === 'unknown');
  const recheck = async () => {
    await recorder.onRecheck();
    // The button goes away once access is possible again; keep focus on the recorder.
    if (focusIsWithRecorder()) document.getElementById('record-button')?.focus();
  };
  return (
    <div className="recorder" data-recording={state.phase === 'recording' ? 'true' : undefined}>
      {state.phase === 'explaining' ? (
        <section
          className="explain"
          aria-labelledby="explain-heading"
          onKeyDown={(e) => {
            if (e.key === 'Escape') recorder.onDismiss(); // a non-destructive dialog (interaction design)
          }}
        >
          <h3 id="explain-heading" ref={headingRef} tabIndex={-1}>
            Before you record
          </h3>
          <p id="explain-text">
            Recording uses your microphone. Your computer will ask once whether this app may use it; you can change that later in your system’s
            privacy settings. A recording is kept only for this session, until you discard it or record again.
          </p>
          <div className="actions">
            <button type="button" aria-describedby="explain-text" onClick={recorder.onContinue}>
              Continue
            </button>
            <button type="button" onClick={recorder.onDismiss}>
              Not now
            </button>
          </div>
        </section>
      ) : null}
      {state.phase === 'confirming' ? (
        <section
          className="explain"
          aria-labelledby="confirm-heading"
          onKeyDown={(e) => {
            if (e.key === 'Escape') recorder.onDecline();
          }}
        >
          <h3 id="confirm-heading" ref={confirmRef} tabIndex={-1} aria-describedby="confirm-text">
            Transcribe this recording?
          </h3>
          <p id="confirm-text">
            {`The recording is kept. Transcribing sends it to ${recorder.confirmTarget}. Nothing is sent until you choose Transcribe recording.`}
          </p>
          {recorder.confirmBlocker !== null ? <p id="confirm-blocked">{CONFIRM_BLOCKER_TEXT[recorder.confirmBlocker]}</p> : null}
          <div className="actions">
            <button
              type="button"
              aria-disabled={recorder.confirmBlocker !== null}
              aria-describedby={recorder.confirmBlocker !== null ? 'confirm-text confirm-blocked' : 'confirm-text'}
              onClick={() => recorder.confirmBlocker === null && recorder.onConfirm()}
            >
              Transcribe recording
            </button>
            <button type="button" onClick={recorder.onDecline}>
              Not now
            </button>
          </div>
        </section>
      ) : null}
      {HELD.includes(state.phase) ? (
        <p className="timer" role="timer">
          <span className="visually-hidden">Recording time </span>
          {`${clock(elapsedMs(state, now))} of ${clock(state.maxDurationMs)}`}
        </p>
      ) : null}
      <p id="record-status" className="status" role="status" tabIndex={-1} data-kind={text === '' ? undefined : statusKind(icon(state))}>
        {text === '' ? null : (
          <>
            <span aria-hidden="true" className={state.phase === 'recording' ? 'rec-dot' : undefined}>
              {icon(state)}
            </span>{' '}
            {text}
          </>
        )}
      </p>
      {showRecheck ? (
        <button type="button" onClick={() => void recheck()}>
          Check again
        </button>
      ) : null}
    </div>
  );
}
