/**
 * Per-stage brake for chat autosave.
 *
 * After a failed session save, the next autosave tick would otherwise start a
 * fresh `saveChatSessions`. The planner then opens a new `…:generation:N`
 * runtime session. `syncOne` bounds a single save, but every tick starts over —
 * one 503 became 67 generations and ~700 requests in six minutes.
 *
 * This sits above the sync in `saveStageChats`: skip while cooling down, clear
 * on success, grow 5 s → 15 s → 45 s → 2 min → 5 min cap. Lock-unavailable
 * rethrows stay unbraked so callers can still retry those immediately.
 *
 * Out of scope: the store 503 itself. This only stops the runaway retry storm
 * and logs the store's status/code/message once per trip.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('ChatSaveBrake');

const SCHEDULE_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

interface BrakeState {
  failures: number;
  nextAllowedAt: number;
}

const states = new Map<string, BrakeState>();

function describeError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const e = error as { status?: unknown; code?: unknown; message?: unknown; name?: unknown };
  const parts = [
    typeof e.status === 'number' ? `HTTP ${e.status}` : undefined,
    typeof e.code === 'string' ? e.code : undefined,
    typeof e.message === 'string' ? e.message : String(e.name ?? 'error'),
  ].filter(Boolean);
  return parts.join(' · ');
}

export const chatSaveBrake = {
  /** May a save for this stage start now? */
  allows(stageId: string, now: number = Date.now()): boolean {
    const state = states.get(stageId);
    return !state || now >= state.nextAllowedAt;
  },

  /** A save failed: extend the cooldown and log the store's answer once per trip. */
  recordFailure(stageId: string, error: unknown, now: number = Date.now()): number {
    const previous = states.get(stageId);
    const failures = (previous?.failures ?? 0) + 1;
    const delay = SCHEDULE_MS[Math.min(failures, SCHEDULE_MS.length) - 1]!;
    states.set(stageId, { failures, nextAllowedAt: now + delay });
    log.warn(
      `chat save for stage ${JSON.stringify(stageId)} failed (${describeError(error)}); ` +
        `holding autosave for ${Math.round(delay / 1000)} s (failure #${failures})`,
    );
    return delay;
  },

  /** A save succeeded: release the brake. */
  recordSuccess(stageId: string): void {
    states.delete(stageId);
  },

  /** Test hook. */
  resetAll(): void {
    states.clear();
  },
};
