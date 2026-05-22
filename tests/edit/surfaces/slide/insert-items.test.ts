import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildInsertItems,
  buildFloatingActions,
} from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import {
  createDefaultImageElement,
  createDefaultTextElement,
} from '@/lib/edit/slide-edit-elements';

describe('slide insert palette', () => {
  beforeEach(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    useSlideEditSession.setState({
      history: {
        past: [],
        present: { type: 'slide', canvas: { id: 's', elements: [] } } as any,
        future: [],
      },
    } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
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
      expect.objectContaining({
        type: 'element.add',
        element: expect.objectContaining({ type: 'text' }),
      }),
    );
  });

  it('no longer contributes a geometry floating action', () => {
    const actions = buildFloatingActions((k) => k, undefined);
    expect(actions.find((a) => a.id === 'geometry')).toBeUndefined();
  });
});

describe('slide floating actions', () => {
  beforeEach(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    useSlideEditSession.setState({
      history: {
        past: [],
        present: { type: 'slide', canvas: { id: 's', elements: [] } } as any,
        future: [],
      },
    } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns no actions when nothing is selected', () => {
    expect(buildFloatingActions((k) => k, undefined)).toEqual([]);
  });

  it('a selected text element gets the text-format bar plus a delete action', () => {
    const actions = buildFloatingActions((k) => k, createDefaultTextElement('text-9'));
    expect(actions.map((a) => a.id)).toEqual(['text-format', 'delete']);
  });

  it('a selected image element gets only a delete action (no text-format)', () => {
    const actions = buildFloatingActions((k) => k, createDefaultImageElement('img-9', 'gen_img_x'));
    expect(actions.map((a) => a.id)).toEqual(['delete']);
  });

  it('the delete action dispatches element.delete for the selected element', () => {
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    const del = buildFloatingActions(
      (k) => k,
      createDefaultImageElement('img-9', 'gen_img_x'),
    ).find((a) => a.id === 'delete');
    del?.onInvoke?.();
    expect(spy).toHaveBeenCalledWith({ type: 'element.delete', elementId: 'img-9' });
  });
});
