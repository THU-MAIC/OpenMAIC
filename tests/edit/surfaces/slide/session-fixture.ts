import type { PPTElement } from '@openmaic/dsl';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import { createDefaultSlide } from '@/lib/edit/slide-edit-elements';
import { useStageStore } from '@/lib/store/stage';
import type { SlideContent } from '@/lib/types/stage';

/** Seed the same canonical content the edit session will guard before each write. */
export function seedSlideSession(elements: PPTElement[] = []): void {
  const content: SlideContent = {
    type: 'slide',
    canvas: { ...createDefaultSlide('s'), elements },
  };
  useStageStore.setState({
    stage: null,
    scenes: [
      { id: 'scene-1', stageId: 'stage-1', title: 'Slide', order: 1, type: 'slide', content },
    ],
    currentSceneId: 'scene-1',
  });
  useSlideEditSession.getState().seed('scene-1', content);
}
