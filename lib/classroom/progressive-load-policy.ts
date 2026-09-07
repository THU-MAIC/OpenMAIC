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

export type ClassroomAvailabilityOutcome =
  | 'loaded'
  | 'unavailable'
  | 'deleted'
  | 'failed'
  | 'cancelled';

export interface ClassroomAvailabilityController {
  loadClassroom: (isCurrent: () => boolean) => Promise<ClassroomAvailabilityOutcome>;
  onSuccess?: () => void;
  onDeleted: () => void;
  onNotFoundTimeout: () => void;
  getRetryDelay?: (attempt: number) => number | null;
  setTimeoutImpl?: (callback: () => void, ms?: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function startClassroomAvailabilityPolling(
  controller: ClassroomAvailabilityController,
): () => void {
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  const getDelay = controller.getRetryDelay ?? paneAvailabilityRetryDelay;
  const setTimeoutFn = controller.setTimeoutImpl ?? setTimeout;
  const clearTimeoutFn = controller.clearTimeoutImpl ?? clearTimeout;

  const poll = async () => {
    if (cancelled) return;
    const outcome = await controller.loadClassroom(() => !cancelled);
    if (cancelled) return;
    if (outcome === 'loaded') {
      controller.onSuccess?.();
      return;
    }
    if (outcome === 'deleted') {
      controller.onDeleted();
      return;
    }
    if (outcome !== 'unavailable') return;

    const delay = getDelay(attempt);
    attempt += 1;
    if (delay !== null) {
      retryTimer = setTimeoutFn(poll, delay);
    } else {
      controller.onNotFoundTimeout();
    }
  };

  void poll();

  return () => {
    cancelled = true;
    if (retryTimer) clearTimeoutFn(retryTimer);
  };
}
