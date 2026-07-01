import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  buildInsertItems,
  updateSlideBackground,
} from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';

/* eslint-disable @typescript-eslint/no-explicit-any */
function seedEmpty() {
  useSlideEditSession.setState({
    sceneId: null,
    history: {
      past: [],
      present: { type: 'slide', canvas: { id: 's', elements: [] } } as any,
      future: [],
    },
  } as any);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('slide background', () => {
  beforeEach(seedEmpty);
  afterEach(() => vi.restoreAllMocks());

  it('exposes a slide-background insert item with a popover', () => {
    const items = buildInsertItems((k) => k, undefined);
    const bg = items.find((i) => i.id === 'slide-background');
    expect(bg).toBeDefined();
    expect(bg!.popoverContent).toBeTypeOf('function');
  });

  it('updateSlideBackground dispatches a slide.update with a solid background', () => {
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    updateSlideBackground({ type: 'solid', color: '#ff0000' });
    expect(spy).toHaveBeenCalledWith({
      type: 'slide.update',
      patch: { background: { type: 'solid', color: '#ff0000' } },
    });
  });

  it('updateSlideBackground dispatches a slide.update with an image background', () => {
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    updateSlideBackground({ type: 'image', image: { src: 'x.png', size: 'cover' } });
    expect(spy).toHaveBeenCalledWith({
      type: 'slide.update',
      patch: { background: { type: 'image', image: { src: 'x.png', size: 'cover' } } },
    });
  });
});
