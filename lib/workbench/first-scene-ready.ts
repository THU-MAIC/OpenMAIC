import { fetchStageManifest } from './stage-freshness';
import type { Scene } from '@/lib/types/stage';

/** What one readiness read found: content, no content yet, or no answer. */
export type FirstSceneProbe = 'ready' | 'not-ready' | 'failed';

/**
 * Read a course's first scene. `failed` means the read itself did not answer
 * (network error, non-OK response, malformed body), which is worth retrying;
 * `not-ready` is an answer.
 */
export async function probeFirstScene(stageId: string): Promise<FirstSceneProbe> {
  try {
    const result = await fetchStageManifest(stageId);
    if (result.status === 'transient') return 'failed';
    if (result.status !== 'ok') return 'not-ready';
    const first = [...result.manifest.scenes].sort((a, b) => a.order - b.order)[0];
    if (!first) return 'not-ready';
    const params = new URLSearchParams({ ids: first.id });
    const response = await fetch(
      `/api/stages/${encodeURIComponent(stageId)}/scenes?${params.toString()}`,
      { credentials: 'include' },
    );
    if (!response.ok) return 'failed';
    const body = (await response.json()) as { scenes?: unknown };
    if (!Array.isArray(body.scenes)) return 'failed';
    return (body.scenes as Scene[]).some(
      (scene) => scene.id === first.id && scene.stageId === stageId,
    )
      ? 'ready'
      : 'not-ready';
  } catch {
    return 'failed';
  }
}

/** A stage link names a shell. Only persisted, readable scene content can open it. */
export async function hasReadableFirstScene(stageId: string): Promise<boolean> {
  return (await probeFirstScene(stageId)) === 'ready';
}

/** Whether any of these courses is listed with a persisted scene. */
export function anyCourseHasScene(
  courseIds: readonly string[],
  courses: readonly { readonly id: string; readonly sceneCount: number }[],
): boolean {
  const ids = new Set(courseIds);
  return courses.some((course) => ids.has(course.id) && course.sceneCount > 0);
}

/**
 * Waits before each retry of a read that failed: about 30 s in all, then the
 * probe gives up until the shell triggers it again.
 */
export const FIRST_SCENE_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000];

/**
 * Read-only readiness probe, owned and cancelled by the shell's current
 * navigation. A read that fails is retried with backoff (bounded by
 * `FIRST_SCENE_RETRY_DELAYS_MS`); an answered "not ready" is not polled — the
 * shell re-runs the probe when a checkpoint or the course list changes.
 */
export function watchFirstScene(
  courseIds: readonly string[],
  onReady: (id: string) => void,
  /** Called once the probe stops on its own: ready, answered "not ready", or out of retries. */
  onSettled?: () => void,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = async (attempt: number) => {
    let failed = false;
    for (const id of courseIds) {
      const probe = await probeFirstScene(id);
      if (cancelled) return;
      if (probe === 'ready') {
        onReady(id);
        onSettled?.();
        return;
      }
      if (probe === 'failed') failed = true;
    }
    const delay = FIRST_SCENE_RETRY_DELAYS_MS[attempt];
    if (!failed || delay === undefined) {
      onSettled?.();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void check(attempt + 1);
    }, delay);
  };
  void check(0);
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };
}
