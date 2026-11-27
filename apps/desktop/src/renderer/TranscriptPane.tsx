import { useEffect, useRef } from 'react';
import type { AudioSummary } from '../contracts/ipc.ts';
import type { JobKind, NoticeCode, RewriteBlocker, SessionState, TranscribeBlocker } from './session.ts';
import { draftStatus, rewriteBlocker, transcribeBlocker } from './session.ts';
import { modeLabel } from './DraftPane.tsx';
import { RecorderButtons, RecorderPanel } from './Recorder.tsx';
import { statusKind } from './statusKind.ts';
import type { RecorderControls } from './Recorder.tsx';
import { InspectPanel } from './Inspect.tsx';
import type { InspectControls } from './Inspect.tsx';

/** What failed, what was kept, and what can be done next. Never provider text. */
const NOTICE_TEXT: Record<NoticeCode, string> = {
  result_outdated: 'Draft not applied because the text changed while it was being written. Your edits and the previous draft are kept.',
  cancelled: 'Rewrite cancelled. Your edits and the previous draft are kept.',
  unknown_outcome: 'Response not applied: its outcome is unknown. Your edits and the previous draft are kept. New rewrites are paused. Inspect says what is known.',
  timed_out: 'Rewrite timed out. Your edits and the previous draft are kept. You can try again.',
  denied: 'Rewrite was refused because another job is running or an earlier outcome is still unknown. Your edits and the previous draft are kept. If a job is running, try again when it finishes.',
  unsupported: 'This route does not support that request. Your edits and the previous draft are kept.',
  invalid_input: 'The route rejected this input. Your edits and the previous draft are kept. Shorten the transcript or steering, then try again.',
  route_unavailable: 'The processing route is unavailable. Your edits and the previous draft are kept. You can try again.',
  provider_mismatch: 'Response not applied: it came from a different model than requested. Your edits and the previous draft are kept.',
  invalid_response: 'Response not applied: it was malformed. Your edits and the previous draft are kept. You can try again.',
  outcome_cleared: 'Unknown outcome cleared. Nothing was sent again. You can rewrite when you’re ready.',
};

/** Transcription outcomes: what happened to the audio's text, and that the user's text is kept. */
const TRANSCRIBE_NOTICE_TEXT: Record<NoticeCode, string> = {
  result_outdated: 'Transcript not applied because your text or the chosen audio changed. Your text is kept.',
  cancelled: 'Transcription cancelled. Your text is kept.',
  unknown_outcome: 'Transcript not applied: its outcome is unknown. Your text is kept. New work is paused. Inspect says what is known.',
  timed_out: 'Transcription timed out. Your text is kept. You can try again.',
  denied: 'Transcription was refused because another job is running or an earlier outcome is still unknown. Your text is kept. If a job is running, try again when it finishes.',
  unsupported: 'This route does not transcribe that audio. Your text is kept.',
  invalid_input: 'The route rejected this audio. Your text is kept. Choose another file.',
  route_unavailable: 'The transcription route is unavailable. Your text is kept. You can try again.',
  provider_mismatch: 'Transcript not applied: it came from a different model than requested. Your text is kept.',
  invalid_response: 'Transcript not applied: it was malformed. Your text is kept. You can try again.',
  outcome_cleared: 'Unknown outcome cleared. Nothing was sent again. You can transcribe when you’re ready.',
};

const BLOCKER_TEXT: Record<RewriteBlocker, string> = {
  no_route: 'Rewrite is unavailable: no processing route is set up yet.',
  pending: 'Rewriting. You can keep editing.',
  awaiting_cancellation: 'Waiting for the cancelled rewrite to finish before starting another.',
  unresolved_outcome: 'New rewrites are paused because an earlier outcome is unknown. Inspect says what is known.',
  empty_transcript: 'Type a transcript to rewrite.',
  transcript_too_large: 'The transcript is over this route’s size limit. Shorten it to rewrite.',
  steering_too_large: 'Steering is over this route’s size limit. Shorten it to rewrite.',
};

/** Blockers the user has to act on (over a limit, an unknown outcome), shown as warnings. */
const WARNING_BLOCKERS: ReadonlySet<RewriteBlocker> = new Set(['transcript_too_large', 'steering_too_large', 'unresolved_outcome']);

function statusLine(state: SessionState, blocker: RewriteBlocker | null, kind: JobKind, filled: boolean, draftBelow: boolean): { icon: string; text: string } {
  if (state.pending !== null) return { icon: '…', text: BLOCKER_TEXT.pending };
  if (state.transcription !== null) return { icon: '…', text: 'Transcribing the audio. You can keep editing.' };
  // While an unknown outcome holds work back, an older notice ("You can try again", "cancelled") would mislead: say it is paused.
  const pausedOverNotice = blocker === 'unresolved_outcome' && state.notice !== 'unknown_outcome';
  // A cancel is the user's own choice, so it is information, not a warning; a cleared gate is good news.
  if (state.notice !== null && !pausedOverNotice) {
    const icon = state.notice === 'cancelled' ? 'ⓘ' : state.notice === 'outcome_cleared' ? '✓' : '⚠';
    return { icon, text: (kind === 'transcribe' ? TRANSCRIBE_NOTICE_TEXT : NOTICE_TEXT)[state.notice] };
  }
  if (state.candidate !== null) return { icon: 'ⓘ', text: 'A transcript from the audio is ready. Replace your text with it, or keep your text.' };
  if (filled) return { icon: '✓', text: 'Transcript added from the audio. Review it before you rewrite.' };
  if (blocker !== null) return { icon: WARNING_BLOCKERS.has(blocker) ? '⚠' : 'ⓘ', text: BLOCKER_TEXT[blocker] };
  if (draftStatus(state) === 'current') {
    // From the UI review, the owner's choice: in one column the draft can arrive out of sight.
    return { icon: '✓', text: draftBelow ? 'Draft ready for review. It’s below the transcript; scroll down to read and copy it.' : 'Draft ready for review.' };
  }
  return { icon: 'ⓘ', text: 'Ready to rewrite.' };
}

/** The first-send confirmation for a route that leaves the app (route card 07's consent step). */
export interface SendConfirm {
  /** The route's label and exact identity, e.g. "Local base model (test text only)". */
  readonly label: string;
  readonly identity: string;
  /** Where it runs, in words, e.g. "a separate service on this Mac". */
  readonly destination: string;
  /** Why Send cannot work right now, or null. */
  readonly blocker: RewriteBlocker | null;
  readonly onSend: () => void;
  readonly onDecline: () => void;
}

/** Asks once before text first leaves the app. Focus moves to its heading; Not now and Escape decline. */
function SendConfirmation({ confirm }: { readonly confirm: SendConfirm }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section
      className="explain"
      aria-labelledby="send-heading"
      onKeyDown={(e) => {
        if (e.key === 'Escape') confirm.onDecline();
      }}
    >
      <h3 id="send-heading" ref={heading} tabIndex={-1} aria-describedby="send-text">
        {`Send to ${confirm.label}?`}
      </h3>
      <p id="send-text">
        {`Rewriting sends your transcript and steering to ${confirm.label}: the model ${confirm.identity}, ${confirm.destination} that may keep a copy. Nothing is sent until you choose Send. This session will not ask again.`}
      </p>
      {confirm.blocker !== null ? <p id="send-blocked">{BLOCKER_TEXT[confirm.blocker]}</p> : null}
      <div className="actions">
        <button
          type="button"
          className="primary"
          aria-disabled={confirm.blocker !== null}
          aria-describedby={confirm.blocker !== null ? 'send-text send-blocked' : 'send-text'}
          onClick={() => confirm.blocker === null && confirm.onSend()}
        >
          Send
        </button>
        <button type="button" onClick={confirm.onDecline}>
          Not now
        </button>
      </div>
    </section>
  );
}

/** Audio input for the source pane: the import and transcribe actions and what they produced. */
export interface AudioControls {
  readonly canImport: boolean;
  readonly canTranscribe: boolean;
  readonly summary: AudioSummary | null;
  /** A refusal or problem from the last import, in words; null when there is none. */
  readonly note: string | null;
  /** Record controls when main offers capture; null hides them. */
  readonly recorder: RecorderControls | null;
  /** A recording is being set up, held or settled: other audio input waits for it. */
  readonly recording: boolean;
  readonly onImport: () => void;
  readonly onTranscribe: () => void;
  readonly onReplace: () => void;
  readonly onKeep: () => void;
}

/** Why chosen audio can't be transcribed right now; a running job is announced by the main status line. */
const TRANSCRIBE_BLOCKER_TEXT: Partial<Record<TranscribeBlocker, string>> = {
  candidate_open: 'Replace or keep the waiting transcript before transcribing again.',
  awaiting_cancellation: 'Waiting for the cancelled job to finish before transcribing.',
  unresolved_outcome: 'Transcribing is paused because an earlier outcome is unknown.',
};

function seconds(durationMs: number): string {
  return durationMs < 50 ? 'under 0.1 seconds' : `${(durationMs / 1000).toFixed(1)} seconds`;
}

function audioStatus(audio: AudioControls, blocker: TranscribeBlocker | null): { icon: string; text: string } {
  const ready = audio.summary === null ? null : seconds(audio.summary.durationMs);
  // A failed import leaves the earlier audio chosen, so say both.
  if (audio.note !== null) return { icon: '⚠', text: ready === null ? audio.note : `${audio.note} The earlier audio (${ready}) is still chosen.` };
  if (ready === null) return { icon: 'ⓘ', text: 'No audio chosen.' };
  const why = blocker === null ? undefined : TRANSCRIBE_BLOCKER_TEXT[blocker];
  // Ready but waiting on something is information, not a success.
  return why === undefined ? { icon: '✓', text: `Audio ready: ${ready} of WAV.` } : { icon: 'ⓘ', text: `Audio ready: ${ready} of WAV. ${why}` };
}

export function TranscriptPane(props: {
  readonly state: SessionState;
  readonly kind: JobKind;
  /** A transcription just filled the empty transcript. */
  readonly filled: boolean;
  readonly audio: AudioControls;
  readonly onTranscript: (text: string) => void;
  readonly onSteering: (text: string) => void;
  readonly onRewrite: () => void;
  readonly onCancel: () => void;
  /** Before the first send to a route that leaves the app: where the text would go, and the answers. */
  readonly sendConfirm: SendConfirm | null;
  /** The panes are stacked and the current draft arrived with Copy draft out of sight, not yet seen. */
  readonly draftBelow: boolean;
  /** While an unknown outcome holds new work back: the Inspect button and, when open, its panel. */
  readonly inspect: (InspectControls & { readonly open: boolean; readonly onOpen: () => void }) | null;
}) {
  const { state, audio } = props;
  const blocker = rewriteBlocker(state);
  const status = statusLine(state, blocker, props.kind, props.filled, props.draftBelow);
  const canCancel = state.pending !== null || state.transcription !== null;
  const asrBlocker = transcribeBlocker(state);
  const canTranscribe = audio.canTranscribe && !audio.recording && state.selectedAsset !== null && asrBlocker === null;
  const canImport = !audio.recording;
  // While a recording is held, the recorder's status says why the other audio actions wait.
  const describedBy = audio.recording ? 'audio-status record-status' : 'audio-status';
  const heard = audioStatus(audio, asrBlocker);
  const candidate = state.candidate;
  const editor = useRef<HTMLTextAreaElement>(null);
  // The candidate's buttons disappear with it, so focus moves to the text it decided about.
  const decide = (choice: () => void) => () => {
    choice();
    editor.current?.focus();
  };
  return (
    <section className="pane source" aria-labelledby="source-heading">
      <h2 id="source-heading">Source</h2>
      {audio.canImport || audio.canTranscribe || audio.recorder !== null ? (
        <div className="audio" role="group" aria-labelledby="audio-label">
          <span id="audio-label" className="visually-hidden">Audio input</span>
          <div className="actions">
            {audio.canImport ? (
              <button type="button" aria-disabled={!canImport} aria-describedby={describedBy} onClick={() => canImport && audio.onImport()}>
                Import audio
              </button>
            ) : null}
            {audio.recorder !== null ? <RecorderButtons recorder={audio.recorder} /> : null}
            {audio.canTranscribe ? (
              <button
                type="button"
                aria-disabled={!canTranscribe}
                aria-describedby={describedBy}
                onClick={() => canTranscribe && audio.onTranscribe()}
              >
                Transcribe
              </button>
            ) : null}
          </div>
          <p id="audio-status" className="status" role="status" data-kind={statusKind(heard.icon)}>
            <span aria-hidden="true">{heard.icon}</span> {heard.text}
          </p>
          {audio.recorder !== null ? <RecorderPanel recorder={audio.recorder} /> : null}
        </div>
      ) : null}
      {candidate !== null ? (
        <section className="candidate" aria-labelledby="candidate-heading">
          <h3 id="candidate-heading">Transcript from audio</h3>
          <p className="identity">{`${modeLabel(candidate.mode)} · ${candidate.identity}`}</p>
          {/* Shown as text, separate from the editor; nothing changes until Replace. */}
          <p className="candidate-text">{candidate.text}</p>
          <div className="actions">
            <button type="button" onClick={decide(audio.onReplace)}>
              Replace transcript
            </button>
            <button type="button" onClick={decide(audio.onKeep)}>
              Keep existing
            </button>
          </div>
        </section>
      ) : null}
      <label htmlFor="transcript">Transcript</label>
      <textarea
        ref={editor}
        id="transcript"
        className="editor"
        rows={8}
        value={state.transcript}
        onChange={(e) => props.onTranscript(e.target.value)}
      />
      <label htmlFor="steering">Steering (optional)</label>
      <textarea
        id="steering"
        className="editor"
        rows={3}
        value={state.steering}
        onChange={(e) => props.onSteering(e.target.value)}
      />
      <div className="actions">
        {/* aria-disabled keeps focus on the button while state changes under it. */}
        <button
          id="rewrite-button"
          type="button"
          className="primary"
          aria-disabled={blocker !== null}
          aria-describedby="source-status"
          onClick={() => blocker === null && props.onRewrite()}
        >
          Rewrite
        </button>
        <button type="button" aria-disabled={!canCancel} onClick={() => canCancel && props.onCancel()}>
          Cancel
        </button>
        {props.inspect !== null ? (
          <button
            id="inspect-button"
            type="button"
            aria-expanded={props.inspect.open}
            aria-controls={props.inspect.open ? 'inspect-panel' : undefined}
            onClick={props.inspect.open ? props.inspect.onClose : props.inspect.onOpen}
          >
            Inspect unknown outcome
          </button>
        ) : null}
      </div>
      {props.sendConfirm !== null ? <SendConfirmation confirm={props.sendConfirm} /> : null}
      {props.inspect !== null && props.inspect.open ? <InspectPanel controls={props.inspect} /> : null}
      <p id="source-status" className="status" role="status" tabIndex={-1} data-kind={statusKind(status.icon)}>
        <span aria-hidden="true">{status.icon}</span> {status.text}
      </p>
    </section>
  );
}
