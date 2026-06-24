import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  replaceImageSrc,
  toggleImageFlip,
} from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import type { PPTImageElement } from '@maic/dsl';

/* eslint-disable @typescript-eslint/no-explicit-any */
function seedImage() {
  useSlideEditSession.setState({
    sceneId: null,
    history: {
      past: [],
      present: {
        type: 'slide',
        canvas: { id: 's', elements: [{ id: 'img', type: 'image', src: 'a.png' }] },
      } as any,
      future: [],
    },
  } as any);
}
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
