'use client';

import { drainProjectRuntime } from '@/lib/pbl/v2/runtime/drain';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { onStageSaved } from '@/lib/store/stage-save-signal';

let installedUnsubscribe: (() => void) | null = null;

export function installPblDrainOnSave(): () => void {
  if (installedUnsubscribe) return installedUnsubscribe;

  const unsubscribeSignal = onStageSaved(({ stageId, pblScenes }) => {
    for (const { sceneId, project } of pblScenes) {
      void drainProjectRuntime({
        stageId,
        sceneId,
        project: project as PBLProjectV2,
      }).catch((error) => {
        console.warn(`Failed to drain PBL runtime events for stage ${stageId}:`, error);
      });
    }
  });

  const uninstall = () => {
    if (installedUnsubscribe !== uninstall) return;
    unsubscribeSignal();
    installedUnsubscribe = null;
  };

  installedUnsubscribe = uninstall;
  return uninstall;
}
