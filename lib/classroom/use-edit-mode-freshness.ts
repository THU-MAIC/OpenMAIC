'use client';

import { useStageStore } from '@/lib/store/stage';
import { useStageFreshnessSync } from '@/lib/workbench/use-workbench-session';

/**
 * The freshness sync for the standalone classroom page, while it is in Edit. A
 * save writes this tab's copy of the scene, so the copy must not lag behind the
 * server; playback writes no course content and stays out of it, as does a viewer
 * who cannot edit. The workspace pane is left to the sync its host runs.
 */
export function useEditModeFreshness(classroomId: string, variant: 'page' | 'pane'): void {
  const editing = useStageStore(
    (state) => state.mode === 'edit' && !state.readOnly && state.stage?.id === classroomId,
  );
  useStageFreshnessSync(variant === 'page' && editing ? classroomId : null);
}
