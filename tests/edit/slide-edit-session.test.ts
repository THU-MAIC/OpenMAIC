import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import type { PPTTextElement } from '@/lib/types/slides';
import type { SlideContent } from '@/lib/types/stage';

// Mock the canonical stage store so we can assert write-through: every
// history move in the session (applyOp / user commit / non-user commit /
// undo / redo) must call updateScene with the new content. Seed must NOT
// touch the stage store (it only adopts the existing content as the
// in-memory baseline).
const updateScene = vi.fn();
vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: () => ({ updateScene }) },
}));

// Imported AFTER the mock setup (vi.mock is hoisted by Vitest).
const { useSlideEditSession } = await import('@/components/edit/surfaces/slide/slide-edit-session');

// Fixture element 0 is the default text element; narrow so we can read
// text-only geometry props off the PPTElement union.
const rotateOf = (c: SlideContent) => (c.canvas.elements[0] as PPTTextElement).rotate;

function makeContent(): SlideContent {
  const slide = createDefaultSlide('slide-1');
  slide.elements.push(createDefaultTextElement('text-1'));
  return { type: 'slide', canvas: slide };
}

describe('useSlideEditSession (auto-save to stage store)', () => {
  beforeEach(() => {
    useSlideEditSession.getState().end();
    updateScene.mockClear();
  });

  it('seed adopts a baseline without touching the stage store', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const { sceneId, history } = useSlideEditSession.getState();
    expect(sceneId).toBe('scene-1');
    expect(history?.past).toEqual([]);
    expect(history?.future).toEqual([]);
    expect(history?.present.canvas.elements[0].id).toBe('text-1');
    // The stage already has this content; redundant writes are noise.
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('applyOp advances history by one step AND writes through to the stage store', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { left: 500 },
    });
    const { history } = useSlideEditSession.getState();
    expect(history?.past).toHaveLength(1);
    expect(history?.present.canvas.elements[0].left).toBe(500);
    // Stage store sees the new content.
    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(updateScene).toHaveBeenCalledWith(
      'scene-1',
      expect.objectContaining({ content: history!.present }),
    );
  });

  it('applyOp ignores a no-op against a missing element (no stage write)', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'does-not-exist',
      patch: { left: 1 },
    });
    expect(useSlideEditSession.getState().history?.past).toEqual([]);
    // The kernel returns the same history reference; replace() short-circuits.
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('user-driven commit records one undo step + writes through', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const next = structuredClone(useSlideEditSession.getState().history!.present);
    next.canvas.elements[0].left = 88;
    next.canvas.elements[0].top = 99;
    useSlideEditSession.getState().commitContent(next, true);
    const { history } = useSlideEditSession.getState();
    expect(history?.past).toHaveLength(1);
    expect(history?.present.canvas.elements[0]).toMatchObject({ left: 88, top: 99 });
    expect(updateScene).toHaveBeenCalledTimes(1);
  });

  it('non-user (ResizeObserver) commit folds into present without an undo step AND still writes through', () => {
    // Auto-fit height IS the new canonical state, so it must reach the
    // stage store. But it must NOT push an undo step (the reflow can
    // chase a user resize; wiping past/future would silently break undo).
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const normalized = structuredClone(useSlideEditSession.getState().history!.present);
    (normalized.canvas.elements[0] as PPTTextElement).height = 999;
    useSlideEditSession.getState().commitContent(normalized, false);
    const { history } = useSlideEditSession.getState();
    expect(history?.past).toEqual([]);
    expect((history!.present.canvas.elements[0] as PPTTextElement).height).toBe(999);
    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(updateScene).toHaveBeenCalledWith(
      'scene-1',
      expect.objectContaining({ content: history!.present }),
    );
  });

  it('a non-user commit after a user edit preserves the undo stack (and writes through both)', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const resized = structuredClone(useSlideEditSession.getState().history!.present);
    resized.canvas.elements[0].width = 640;
    useSlideEditSession.getState().commitContent(resized, true);
    expect(useSlideEditSession.getState().history?.past).toHaveLength(1);

    const reflowed = structuredClone(useSlideEditSession.getState().history!.present);
    (reflowed.canvas.elements[0] as PPTTextElement).height = 333;
    useSlideEditSession.getState().commitContent(reflowed, false);

    const { history } = useSlideEditSession.getState();
    expect(history?.past).toHaveLength(1); // undo step survives
    expect((history!.present.canvas.elements[0] as PPTTextElement).height).toBe(333);
    expect(updateScene).toHaveBeenCalledTimes(2); // user commit + non-user commit
    // Undo returns to the pre-resize width, and writes that through too.
    updateScene.mockClear();
    useSlideEditSession.getState().undo();
    expect(useSlideEditSession.getState().history?.present.canvas.elements[0].width).toBe(
      makeContent().canvas.elements[0].width,
    );
    expect(updateScene).toHaveBeenCalledTimes(1);
  });

  it('a non-user commit after an undo clears the stale redo branch (no resurrected content)', () => {
    // Regression: user edit → undo (content moves to `future`) → the
    // ResizeObserver auto-height normalization fires a non-user commit. If
    // that commit folds into `present` but keeps the now-stale `future[0]`,
    // a later redo resurrects the pre-undo snapshot and silently discards
    // the normalization (canvas/store diverge). The non-user commit must
    // clear `future` so redo is a no-op.
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const resized = structuredClone(useSlideEditSession.getState().history!.present);
    resized.canvas.elements[0].width = 640;
    useSlideEditSession.getState().commitContent(resized, true);
    expect(useSlideEditSession.getState().history?.past).toHaveLength(1);

    // Undo pushes the resized snapshot onto `future`.
    useSlideEditSession.getState().undo();
    expect(useSlideEditSession.getState().history?.future).toHaveLength(1);
    expect(useSlideEditSession.getState().history?.present.canvas.elements[0].width).toBe(
      makeContent().canvas.elements[0].width,
    );

    // Non-user (auto-height) commit lands on the undone present.
    const reflowed = structuredClone(useSlideEditSession.getState().history!.present);
    (reflowed.canvas.elements[0] as PPTTextElement).height = 333;
    useSlideEditSession.getState().commitContent(reflowed, false);

    const afterReflow = useSlideEditSession.getState().history;
    expect(afterReflow?.future).toEqual([]); // stale redo branch dropped
    expect((afterReflow!.present.canvas.elements[0] as PPTTextElement).height).toBe(333);

    // Redo must be a no-op now: it cannot resurrect the stale width=640.
    updateScene.mockClear();
    useSlideEditSession.getState().redo();
    const afterRedo = useSlideEditSession.getState().history;
    expect(afterRedo?.present.canvas.elements[0].width).toBe(
      makeContent().canvas.elements[0].width,
    );
    expect((afterRedo!.present.canvas.elements[0] as PPTTextElement).height).toBe(333);
    // future was empty → redo short-circuits to the same ref → no write-through.
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('undo / redo move between history states AND write through on each move', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { rotate: 30 },
    });
    updateScene.mockClear();
    useSlideEditSession.getState().undo();
    expect(rotateOf(useSlideEditSession.getState().history!.present)).toBe(0);
    expect(updateScene).toHaveBeenCalledTimes(1);
    useSlideEditSession.getState().redo();
    expect(rotateOf(useSlideEditSession.getState().history!.present)).toBe(30);
    expect(updateScene).toHaveBeenCalledTimes(2);
  });

  it('repeated non-user commits each write through but never grow past/future', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    for (let i = 0; i < 3; i++) {
      const n = structuredClone(useSlideEditSession.getState().history!.present);
      (n.canvas.elements[0] as PPTTextElement).height = 100 + i;
      useSlideEditSession.getState().commitContent(n, false);
    }
    expect(useSlideEditSession.getState().history?.past).toEqual([]);
    expect(
      (useSlideEditSession.getState().history!.present.canvas.elements[0] as PPTTextElement).height,
    ).toBe(102);
    expect(updateScene).toHaveBeenCalledTimes(3);
  });

  it('end clears the session (no further write-through possible)', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().end();
    expect(useSlideEditSession.getState().sceneId).toBeNull();
    expect(useSlideEditSession.getState().history).toBeNull();
    // applyOp after end must be a no-op (no sceneId → no writeThrough either).
    updateScene.mockClear();
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { left: 1 },
    });
    expect(updateScene).not.toHaveBeenCalled();
  });
});
