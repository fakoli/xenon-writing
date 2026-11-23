/** Deterministic timers for tests: due callbacks run in time order, ties in creation order. */
import type { Clock } from '../../src/main/jobs.ts';

/** Lets pending promise reactions run. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function fakeClock(): Clock & { advance(ms: number): Promise<void>; readonly pending: number } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    async advance(ms) {
      const target = now + ms;
      await settle();
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) {
          if (entry[1].at > target) continue;
          if (next === undefined || entry[1].at < next[1].at) next = entry;
        }
        if (next === undefined) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = target;
    },
    get pending() {
      return timers.size;
    },
  };
}
