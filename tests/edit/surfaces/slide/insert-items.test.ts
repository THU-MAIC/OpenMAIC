import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildInsertItems, buildFloatingActions } from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';

describe('slide insert palette', () => {
  beforeEach(() => {
    useSlideEditSession.setState({ history: { past: [], present: { type: 'slide', canvas: { id: 's', elements: [] } } as any, future: [] } } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes a text-box and an image insert item', () => {
    const items = buildInsertItems((k) => k);
    expect(items.map((i) => i.id)).toEqual(['insert-text', 'insert-image']);
    expect(items[1].popoverContent).toBeTypeOf('function');
    expect(items[0].onInvoke).toBeTypeOf('function');
  });

  it('text-box invoke dispatches element.add with a text element', () => {
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    buildInsertItems((k) => k)[0].onInvoke();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'element.add', element: expect.objectContaining({ type: 'text' }) }),
    );
  });

  it('no longer contributes a geometry floating action', () => {
    const actions = buildFloatingActions((k) => k, undefined);
    expect(actions.find((a) => a.id === 'geometry')).toBeUndefined();
  });
});
