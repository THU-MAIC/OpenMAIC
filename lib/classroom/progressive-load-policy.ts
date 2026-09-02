/** Bounded pane probe schedule for the stage-link/document availability gap. */
export const PANE_AVAILABILITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export function paneAvailabilityRetryDelay(attempt: number): number | null {
  return PANE_AVAILABILITY_RETRY_DELAYS_MS[attempt] ?? null;
}

export function shouldResumeClassroomGeneration({
  loading,
  error,
  transportPersistenceFenced,
  generationStarted,
}: {
  loading: boolean;
  error: string | null;
  transportPersistenceFenced: boolean;
  generationStarted: boolean;
}): boolean {
  return !loading && !error && !transportPersistenceFenced && !generationStarted;
}
