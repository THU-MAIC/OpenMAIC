/** Bounded pane probe schedule for the stage-link/document availability gap. */
export const PANE_AVAILABILITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export function paneAvailabilityRetryDelay(attempt: number): number | null {
  return PANE_AVAILABILITY_RETRY_DELAYS_MS[attempt] ?? null;
}

export type ClassroomSurfaceView = 'loading' | 'not-found' | 'error' | 'stage';

/**
 * Keep terminal load states ahead of the pane's stale-stage loading guard.
 * After bounded probing, an absent or unavailable classroom has no matching
 * stage by definition; letting that mismatch win would leave the pane spinning.
 */
export function resolveClassroomSurfaceView({
  variant,
  loading,
  error,
  notFound,
  loadedClassroomId,
  classroomId,
}: {
  variant: 'page' | 'pane';
  loading: boolean;
  error: string | null;
  notFound: boolean;
  loadedClassroomId: string | null;
  classroomId: string;
}): ClassroomSurfaceView {
  if (loading || (variant === 'pane' && !error && !notFound && loadedClassroomId !== classroomId)) {
    return 'loading';
  }
  if (notFound) return 'not-found';
  if (error) return 'error';
  return 'stage';
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
