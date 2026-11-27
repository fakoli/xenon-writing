/**
 * The Inspect step (the local base rewrite route): what is and isn't known about
 * an unknown outcome, and one explicit Acknowledge where the route's card
 * allows it. An inline region like the first-send confirmation, not a modal:
 * focus moves to its heading when it opens, Escape or Close returns focus to
 * the Inspect button, and after an acknowledgment focus goes to the status line.
 */
import { useEffect, useRef } from 'react';
import type { InspectFacts } from './inspectFacts.ts';
import { MISSING_DETAILS } from './inspectFacts.ts';

export type AcknowledgeStatus = 'idle' | 'sending' | 'failed';

export interface InspectControls {
  readonly entries: readonly InspectFacts[];
  /** This session holds an unknown outcome main sent no report for. */
  readonly missing: boolean;
  readonly status: AcknowledgeStatus;
  readonly onAcknowledge: (jobId: string) => void;
  readonly onClose: () => void;
}

export function InspectPanel({ controls }: { readonly controls: InspectControls }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const { entries, status } = controls;
  const several = entries.length > 1;
  const sending = status === 'sending';
  return (
    <section
      id="inspect-panel"
      className="explain inspect"
      aria-labelledby="inspect-heading"
      onKeyDown={(e) => {
        if (e.key === 'Escape') controls.onClose();
      }}
    >
      <h3 id="inspect-heading" ref={heading} tabIndex={-1}>
        {several ? 'Unknown outcomes' : 'Unknown outcome'}
      </h3>
      {entries.map((entry, index) => (
        <div key={entry.jobId} className="inspect-outcome">
          <h4 id={`inspect-known-${index}`}>What is known</h4>
          <ul aria-labelledby={`inspect-known-${index}`}>
            {entry.known.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <h4 id={`inspect-unknown-${index}`}>What isn’t known</h4>
          <ul aria-labelledby={`inspect-unknown-${index}`}>
            <li>{entry.unknown}</li>
          </ul>
          {entry.next.map((line, i) => (
            <p key={line} id={`inspect-next-${index}-${i}`}>
              {line}
            </p>
          ))}
        </div>
      ))}
      {controls.missing ? <p>{MISSING_DETAILS}</p> : null}
      {/* Always mounted, so a screen reader announces it when it fills in. */}
      <p id="inspect-status" className="status" role="status" data-kind={status === 'failed' ? 'warning' : status === 'sending' ? 'progress' : undefined}>
        {status === 'failed' ? (
          <>
            <span aria-hidden="true">⚠ </span>Couldn’t acknowledge it, so new work stays paused. Try again, or quit and reopen Xenon Writing.
          </>
        ) : status === 'sending' ? (
          <>
            <span aria-hidden="true">… </span>Acknowledging.
          </>
        ) : (
          ''
        )}
      </p>
      <div className="actions">
        {entries.map((entry, index) =>
          entry.canAcknowledge ? (
            <button
              key={entry.jobId}
              type="button"
              className="primary"
              aria-disabled={sending}
              aria-describedby={`inspect-next-${index}-1 inspect-status`}
              // aria-disabled while one is in flight; the Composer ignores a second press until it settles.
              onClick={() => controls.onAcknowledge(entry.jobId)}
            >
              {several ? `Acknowledge ${entry.name}` : 'Acknowledge'}
            </button>
          ) : null,
        )}
        <button type="button" onClick={controls.onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
