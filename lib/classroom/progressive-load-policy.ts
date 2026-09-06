import {
  mayStartOwnerGeneration,
  type ClassroomGenerationOwnership,
} from './stage-ownership-signal';

/** Bounded pane probe schedule for the stage-link/document availability gap. */
export const PANE_AVAILABILITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export function paneAvailabilityRetryDelay(attempt: number): number | null {
  return PANE_AVAILABILITY_RETRY_DELAYS_MS[attempt] ?? null;
}

/**
 * Progressive-load state plus the ownership gate, in one decision.
 *
 * `serverBackedMedia` and `ownership` are required rather than defaulted: a
 * caller that forgets them would silently open the budget to every viewer,
 * which is exactly the failure the gate exists to prevent.
 */
export function shouldResumeClassroomGeneration({
  loading,
  error,
  transportPersistenceFenced,
  generationStarted,
  serverBackedMedia,
  ownership,
}: {
  loading: boolean;
  error: string | null;
  transportPersistenceFenced: boolean;
  generationStarted: boolean;
  serverBackedMedia: boolean;
  ownership: ClassroomGenerationOwnership;
}): boolean {
  if (loading || error || transportPersistenceFenced || generationStarted) return false;
  return mayStartOwnerGeneration(serverBackedMedia, ownership);
}
