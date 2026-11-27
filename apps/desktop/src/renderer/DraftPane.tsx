import { useState } from 'react';
import { copyEligibility, draftStatus } from './session.ts';
import type { SessionState } from './session.ts';
import type { RouteMode } from '../contracts/session.ts';
import { statusKind } from './statusKind.ts';

/** Fixture output is always labelled synthetic, never "local AI". */
export function modeLabel(mode: RouteMode): string {
  if (mode === 'fixture') return 'Synthetic fixture';
  if (mode === 'base') return 'Base model';
  return 'Personalized model';
}

/**
 * What one copy attempt did. `expired`: main no longer holds this draft
 * (its handle was closed or evicted), so copying it again cannot work.
 * `failed`: anything else, such as the clipboard write throwing.
 */
export type CopyOutcome = 'copied' | 'expired' | 'failed';

/** Read-only preview. Text is rendered as text, never as HTML. */
export function DraftPane({
  state,
  onCopy,
}: {
  readonly state: SessionState;
  readonly onCopy: (() => Promise<CopyOutcome>) | null;
}) {
  const draft = state.draft;
  const status = draftStatus(state);
  const eligibility = copyEligibility(state);
  const canCopy = onCopy !== null && eligibility.allowed;
  // The last copy result, shown only while the same draft is on screen.
  const [copied, setCopied] = useState<{ handle: string; outcome: CopyOutcome } | null>(null);
  const copyNote = copied !== null && copied.handle === draft?.draftHandle ? copied : null;

  const copy = async () => {
    if (!canCopy) return;
    const handle = eligibility.draftHandle;
    setCopied({ handle, outcome: await onCopy() });
  };
  // The exact model, not the route's name: the header names the route and where it runs (UI review).
  // A draft can only come from the session's route (main and the reducer refuse any other mode or identity).
  // Fixture output still says it is synthetic here, next to the draft, since the header scrolls away.
  const source = draft ?? state.route;
  const model = source === null ? null : source.mode === 'fixture' ? `Model: ${source.identity} (synthetic)` : `Model: ${source.identity}`;
  return (
    <section className="pane draft" aria-labelledby="draft-heading">
      <h2 id="draft-heading">Draft</h2>
      {model === null ? null : <p className="identity">{model}</p>}
      <p id="preview-label" className="preview-label">
        {status === 'previous' ? 'Previous draft' : status === 'current' ? 'Current draft' : 'Draft preview'}
      </p>
      <div
        className="preview"
        role="textbox"
        aria-readonly="true"
        aria-multiline="true"
        aria-labelledby="preview-label"
        tabIndex={0}
      >
        {draft === null ? <span className="empty">Nothing generated yet</span> : draft.text}
      </div>
      <div className="actions">
        {/* A stale draft is copied only from a button that names it as the previous draft. */}
        <button id="copy-draft" type="button" className="primary" aria-disabled={!canCopy} aria-describedby="copy-status" onClick={() => void copy()}>
          {status === 'previous' ? 'Copy previous draft' : 'Copy draft'}
        </button>
      </div>
      <p id="copy-status" className="status" role="status" data-kind={copyNote === null ? undefined : statusKind(copyNote.outcome === 'copied' ? '✓' : '⚠')}>
        {copyNote === null ? '' : copyNote.outcome === 'copied' ? (
          <>
            <span aria-hidden="true">✓ </span>Draft copied to the clipboard.
          </>
        ) : copyNote.outcome === 'expired' ? (
          <>
            <span aria-hidden="true">⚠ </span>This draft can no longer be copied. Rewrite to get a new one.
          </>
        ) : (
          <>
            <span aria-hidden="true">⚠ </span>Couldn’t copy the draft. It is still shown here. Try copying again.
          </>
        )}
      </p>
    </section>
  );
}
