'use client';

/**
 * Per-reasoning-block timing, so each thinking panel shows how long the model
 * spent on THAT block. A multi-step agent reasons in several turns (read →
 * reason → edit → reason → answer), producing multiple reasoning blocks; a single
 * per-message timer would freeze on the first tool call while later blocks keep
 * streaming. So timers are keyed per block (`${messageId}:${ordinal}`): a block
 * starts on first observation and ends when a LATER part follows it (the model
 * moved on). The last reasoning block stays open — ticking live — until something
 * follows it or the run finalizes. The pure reducer is unit-tested; the store is
 * a thin reactive wrapper the runtime drives and the panel reads.
 */
import { create } from 'zustand';

export interface ThinkTimer {
  startedAt: number;
  endedAt?: number;
}

/** Pure transition: start on first observation; end once a later part follows. */
export function nextThinkTimer(
  prev: ThinkTimer | undefined,
  opts: { end: boolean; now: number },
): ThinkTimer {
  const { end, now } = opts;
  if (!prev) return { startedAt: now };
  if (prev.endedAt == null && end) return { ...prev, endedAt: now };
  return prev;
}

/** Human-readable elapsed: one decimal under 10s, whole seconds beyond. */
export function formatThinkDuration(ms: number): string {
  const clamped = ms < 0 ? 0 : ms;
  const s = clamped / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

interface ThinkingTimersState {
  timers: Record<string, ThinkTimer>;
  /** Fold an observation for one block; no-op if state is unchanged. */
  observe(key: string, opts: { end: boolean; now: number }): void;
  /** Force-close every still-open timer whose key starts with `prefix`. */
  endAll(prefix: string, now: number): void;
  /** Restore a finished timer from a persisted duration (post-refresh). */
  seed(key: string, durationMs: number): void;
  clear(): void;
}

export const useThinkingTimers = create<ThinkingTimersState>((set, get) => ({
  timers: {},
  observe: (key, opts) => {
    const prev = get().timers[key];
    const next = nextThinkTimer(prev, opts);
    if (next === prev) return;
    set((s) => ({ timers: { ...s.timers, [key]: next } }));
  },
  endAll: (prefix, now) => {
    const timers = get().timers;
    let changed = false;
    const updated = { ...timers };
    for (const [key, t] of Object.entries(timers)) {
      if (key.startsWith(prefix) && t.endedAt == null) {
        updated[key] = { ...t, endedAt: now };
        changed = true;
      }
    }
    if (changed) set({ timers: updated });
  },
  seed: (key, durationMs) =>
    set((s) => ({ timers: { ...s.timers, [key]: { startedAt: 0, endedAt: durationMs } } })),
  clear: () => set({ timers: {} }),
}));
