import { describe, expect, it, beforeEach } from 'vitest';
import { reorderSlideElement } from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';

import { useStageStore } from '@/lib/store/stage';
import { useCourseTimeline } from '@/lib/edit/course-timeline';

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
function seed(ids: string[]) {
  useCourseTimeline.getState().clearCourse('stage-test');
  seedSlide(ids.map((id) => ({ id })));
}

function order(): string[] {
  return slideElements().map((e) => e.id);
}

describe('reorderSlideElement', () => {
  beforeEach(() => seed(['a', 'b', 'c']));

  it('to-back moves the element to the bottom (index 0)', () => {
    reorderSlideElement('c', 'back');
    expect(order()).toEqual(['c', 'a', 'b']);
  });

  it('to-front moves the element to the top (last index)', () => {
    reorderSlideElement('a', 'front');
    expect(order()).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op for an unknown element id', () => {
    reorderSlideElement('zzz', 'front');
    expect(order()).toEqual(['a', 'b', 'c']);
  });

  it('does not push an undo step when the element is already at that edge', () => {
    // 'c' is last → to-front is a no-op; 'a' is first → to-back is a no-op.
    reorderSlideElement('c', 'front');
    reorderSlideElement('a', 'back');
    expect(order()).toEqual(['a', 'b', 'c']);
    expect(useCourseTimeline.getState().lines['stage-test']?.past ?? []).toHaveLength(0);
  });
});
