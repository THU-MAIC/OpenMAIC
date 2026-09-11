/** Bounded pane probe schedule for the stage-link/document availability gap. */
export const PANE_AVAILABILITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export function paneAvailabilityRetryDelay(attempt: number): number | null {
  return PANE_AVAILABILITY_RETRY_DELAYS_MS[attempt] ?? null;
}

/**
 * Progressive-load state plus the ownership gate, in one decision.
 *
 * `mayGenerate` is required rather than defaulted: a caller that forgot it
 * would silently open the operator's budget to every viewer, which is exactly
 * the failure the gate exists to prevent. It is the same value the surface
 * uses to decide whether to offer a retry affordance at all.
 */
export function shouldResumeClassroomGeneration({
  loading,
  error,
  transportPersistenceFenced,
  generationStarted,
  mayGenerate,
}: {
  loading: boolean;
  error: string | null;
  transportPersistenceFenced: boolean;
  generationStarted: boolean;
  mayGenerate: boolean;
}): boolean {
  return !loading && !error && !transportPersistenceFenced && !generationStarted && mayGenerate;
}
