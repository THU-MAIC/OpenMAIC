'use client';

import { useCallback } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createBlankEditableScene, insertSceneAtIndex } from '@/lib/edit/scene-defaults';
import type { EditableSceneType } from '@/lib/edit/scene-defaults';
import { useStageStore } from '@/lib/store/stage';

/** Insert a blank page at an index in the deck, and go to it. */
export function useInsertSceneAt() {
  const { t } = useI18n();
  const setScenes = useStageStore.use.setScenes();
  const setCurrentSceneId = useStageStore.use.setCurrentSceneId();
  return useCallback(
    (insertIndex: number, type: EditableSceneType) => {
      const { stage, scenes } = useStageStore.getState();
      if (!stage) return;
      const title = type === 'slide' ? t('edit.nav.untitledSlide') : t('edit.sceneType.quiz');
      const scene = createBlankEditableScene(type, stage.id, title, insertIndex + 1);
      setScenes(insertSceneAtIndex(scenes, scene, insertIndex));
      setCurrentSceneId(scene.id);
    },
    [setCurrentSceneId, setScenes, t],
  );
}
