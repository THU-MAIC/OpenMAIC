import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  replaceImageSrc,
  toggleImageFlip,
} from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import type { PPTImageElement } from '@openmaic/dsl';

import { useStageStore } from '@/lib/store/stage';

/* eslint-disable @typescript-eslint/no-explicit-any */
function seedSlide(elements: unknown[]) {
  useStageStore.setState({
    stage: { id: 'stage-test', name: 'Course' } as any,
    scenes: [
      {
        id: 'scene-test',
        stageId: 'stage-test',
        type: 'slide',
        title: 'Page',
        order: 1,
        content: { type: 'slide', schemaVersion: 1, canvas: { id: 's', elements } },
      } as any,
    ],
    currentSceneId: 'scene-test',
  });
  useSlideEditSession.setState({ sceneId: 'scene-test' });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
function seedImage() {
  seedSlide([{ id: 'img', type: 'image', src: 'a.png' }]);
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const img = (over: Partial<PPTImageElement>) =>
  ({ id: 'img', type: 'image', src: 'a.png', ...over }) as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('image surface helpers', () => {
  beforeEach(seedImage);
  afterEach(() => vi.restoreAllMocks());

  it('replaceImageSrc updates src and clears the stale crop', () => {
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    replaceImageSrc('img', 'b.png');
    expect(spy).toHaveBeenCalledWith({
      type: 'element.update',
      elementId: 'img',
      patch: { src: 'b.png', clip: undefined },
    });
  });

  it('toggleImageFlip H toggles flipH from its current value', () => {
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    toggleImageFlip(img({ flipH: false }), 'H');
    expect(spy).toHaveBeenCalledWith({
      type: 'element.update',
      elementId: 'img',
      patch: { flipH: true },
    });
  });

  it('toggleImageFlip V toggles flipV from its current value', () => {
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    toggleImageFlip(img({ flipV: true }), 'V');
    expect(spy).toHaveBeenCalledWith({
      type: 'element.update',
      elementId: 'img',
      patch: { flipV: false },
    });
  });
});
