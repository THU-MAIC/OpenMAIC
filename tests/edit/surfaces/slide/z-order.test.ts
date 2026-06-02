import { describe, expect, it, beforeEach } from 'vitest';
import { reorderSlideElement } from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';

/* eslint-disable @typescript-eslint/no-explicit-any */
function seed(ids: string[]) {
  useSlideEditSession.setState({
    sceneId: null,
    history: {
      past: [],
      present: {
        type: 'slide',
        canvas: { id: 's', elements: ids.map((id) => ({ id })) },
      } as any,
      future: [],
    },
  } as any);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function order(): string[] {
  return useSlideEditSession.getState().history!.present.canvas.elements.map((e) => e.id);
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
    expect(useSlideEditSession.getState().history!.past).toHaveLength(0);
  });
});
