/**
 * Chat autosave brake.
 *
 * Measured on a v1.0.3 deployment with server-backed persistence: once the record
 * append succeeded, `PATCH …/sessions/<id>/status` and `DELETE …/sessions/<id>`
 * answered 503; the sync loop then opened the SAME chat as a new
 * `…:generation:N` session on every autosave — 67 generations for one scene,
 * ~700 requests in 6 minutes, and a growing table of empty runtime sessions.
 * `syncOne` bounds one save (8 attempts × 8 plan steps with backoff) but every
 * autosave tick starts a fresh save, so the schedule restarts from zero.
 *
 * This brake sits above the sync: after a save fails for a transport/server
 * reason, further saves for that stage are skipped until a growing cooldown
 * elapses (5 s → 15 s → 45 s → 2 min → 5 min cap). A successful save clears
 * it. Deterministic client-side rejections (400/401/403/413, validation) are
 * not braked — retrying them is pointless but harmless, and they already throw.
 *
 * It also logs, once per trip, the HTTP status/code/message the store
 * returned: the client wrapper swallows that body today, which is why the 503
 * could not be read from the browser.
 */

const SCHEDULE_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

interface BrakeState {
  failures: number;
  nextAllowedAt: number;
}

const states = new Map<string, BrakeState>();

function describe(error: unknown): string {
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
    const delay = SCHEDULE_MS[Math.min(failures, SCHEDULE_MS.length) - 1];
    states.set(stageId, { failures, nextAllowedAt: now + delay });
    console.warn(
      `[ChatSaveBrake] chat save for stage ${JSON.stringify(stageId)} failed (${describe(error)}); ` +
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
