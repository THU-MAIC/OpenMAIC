import { fetchScenesByIds, fetchStageManifest } from './stage-freshness';

/** A stage link names a shell. Only persisted, readable scene content can open it. */
export async function hasReadableFirstScene(stageId: string): Promise<boolean> {
  try {
    const result = await fetchStageManifest(stageId);
    if (result.status !== 'ok') return false;
    const first = [...result.manifest.scenes].sort((a, b) => a.order - b.order)[0];
    if (!first) return false;
    const scenes = await fetchScenesByIds(stageId, [first.id]);
    return scenes.some((scene) => scene.id === first.id && scene.stageId === stageId);
  } catch {
    return false;
  }
}

/** Whether any of these courses is listed with a persisted scene. */
export function anyCourseHasScene(
  courseIds: readonly string[],
  courses: readonly { readonly id: string; readonly sceneCount: number }[],
): boolean {
  const ids = new Set(courseIds);
  return courses.some((course) => ids.has(course.id) && course.sceneCount > 0);
}

/** Read-only readiness probe, owned and cancelled by the shell's current navigation. */
export function watchFirstScene(
  courseIds: readonly string[],
  onReady: (id: string) => void,
): () => void {
  let cancelled = false;
  const check = async () => {
    for (const id of courseIds) {
      const ready = await hasReadableFirstScene(id);
      if (cancelled) return;
      if (ready) {
        onReady(id);
        return;
      }
    }
  };
  void check();
  return () => {
    cancelled = true;
  };
}
