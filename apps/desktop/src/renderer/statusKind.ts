/**
 * Which kind a status line is, from the icon it already shows (UI review). The kind sets the line's color through `data-kind`; the icon
 * and the words still carry the meaning, so color never stands alone.
 */
export type StatusKind = 'warning' | 'success' | 'progress' | 'recording' | 'info';

const KINDS: Readonly<Record<string, StatusKind>> = { '⚠': 'warning', '✓': 'success', '…': 'progress', '●': 'recording' };

export function statusKind(icon: string): StatusKind {
  return KINDS[icon] ?? 'info';
}
