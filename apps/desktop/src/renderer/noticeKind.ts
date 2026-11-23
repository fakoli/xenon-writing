import type { JobKind, SessionAction, SessionState } from './session.ts';

/**
 * Which job a newly shown notice is about. The reducer keeps one notice; what
 * the action ended says whether it concerns a rewrite or a transcription.
 */
export function noticeKind(prev: SessionState, next: SessionState, action: SessionAction, current: JobKind): JobKind {
  if (next.notice === null) return current;
  // A job that just ended (settled, cancelled or abandoned) owns the notice it left.
  if (prev.pending !== null && next.pending === null) return 'rewrite';
  if (prev.transcription !== null && next.transcription === null) return 'transcribe';
  // Typing over, or choosing audio past, a waiting candidate is about that transcript.
  if (prev.candidate !== null && next.candidate === null && action.type !== 'candidate.keep') return 'transcribe';
  if (next.notice === prev.notice) return current;
  // A late terminal for a job that already left (abandoned or unresolved).
  if (action.type.startsWith('rewrite.')) return 'rewrite';
  if (action.type.startsWith('transcribe.')) return 'transcribe';
  return current;
}

/** True when a transcription just filled an empty transcript, so the shell can say so. */
export function filledFromAudio(prev: SessionState, next: SessionState): boolean {
  return prev.transcription !== null && next.transcription === null && prev.transcript === '' && next.transcript !== '';
}
