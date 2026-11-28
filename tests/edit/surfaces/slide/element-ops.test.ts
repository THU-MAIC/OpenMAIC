import { describe, it, expect, vi, afterEach } from 'vitest';
import { deleteSlideElement } from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import { createDefaultLatexElement } from '@/lib/edit/slide-edit-elements';

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
const slideElements = () =>
  (useStageStore.getState().scenes[0].content as any).canvas.elements as { id: string }[];
/* eslint-enable @typescript-eslint/no-explicit-any */
const seedSlideSession = (elements: unknown[] = []) => seedSlide(elements);

describe('slide element defaults', () => {
  it('creates a renderer Latex element with the shared editor result', () => {
    expect(
      createDefaultLatexElement('formula-1', {
        latex: '\\frac{a}{b}',
        html: '<span class="katex">a/b</span>',
        width: 160,
        height: 60,
      }),
    ).toEqual({
      id: 'formula-1',
      type: 'latex',
      left: 160,
      top: 160,
      width: 160,
      height: 60,
      rotate: 0,
      latex: '\\frac{a}{b}',
      html: '<span class="katex">a/b</span>',
      color: '#333333',
      align: 'center',
      fixedRatio: true,
    });
  });
});

describe('slide element deletion', () => {
  afterEach(() => vi.restoreAllMocks());

  it('deleteSlideElement deletes an existing element through the canonical operation', () => {
    seedSlideSession([{ id: 'img-9', type: 'image', src: 'image.png' }]);
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');

    deleteSlideElement('img-9');

    expect(spy).toHaveBeenCalledWith({ type: 'element.delete', elementId: 'img-9' });
    expect(slideElements()).toEqual([]);
  });
});
