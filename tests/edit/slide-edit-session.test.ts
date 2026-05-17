import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import { createSlideEditHistory } from '@/lib/edit/slide-ops';
import { hasPersistedSlideHistory } from '@/lib/edit/slide-history-persistence';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import type { PPTTextElement } from '@/lib/types/slides';
import type { SlideContent } from '@/lib/types/stage';

// In-memory localStorage so persist/clear is observable (the node test
// env has none; slide-history-persistence swallows the absence silently).
const mem = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() {
    return mem.size;
  },
} as Storage;

// Fixture element 0 is the default text element; narrow so we can read
// text-only geometry props off the PPTElement union.
const rotateOf = (c: SlideContent) => (c.canvas.elements[0] as PPTTextElement).rotate;

/**
 * Module-level session store shared by the slide surface's `useSurfaceState`
 * and its `CanvasComponent` (EditShell invokes them as siblings, so the
 * SlideEditHistory cannot live in a single component's state). The store is
 * pure orchestration over the already-tested kernel + bridge; these tests
 * pin the history transitions (localStorage persistence degrades silently
 * in the node test env and is covered by slide-history-persistence itself).
 */
function makeContent(): SlideContent {
  const slide = createDefaultSlide('slide-1');
  slide.elements.push(createDefaultTextElement('text-1'));
  return { type: 'slide', canvas: slide };
}

describe('useSlideEditSession', () => {
  beforeEach(() => {
    useSlideEditSession.getState().end();
    mem.clear();
  });

  it('clears persisted history once undo returns to baseline (no stale restore prompt)', () => {
    // Edit → undo back to baseline → exit. past is empty again, so there
    // is nothing to restore; the persisted key must be gone, otherwise
    // re-entry would fire a spurious SlideHistoryRestorePrompt.
    useSlideEditSession.getState().seed('scene-1', makeContent());
    expect(hasPersistedSlideHistory('scene-1')).toBe(false); // seed never persists
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { left: 200 },
    });
    expect(hasPersistedSlideHistory('scene-1')).toBe(true); // a real edit persists
    useSlideEditSession.getState().undo();
    expect(useSlideEditSession.getState().history?.past).toEqual([]);
    expect(hasPersistedSlideHistory('scene-1')).toBe(false); // back to pristine → cleared
  });

  it('seed creates a fresh history pinned to the scene', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const { sceneId, history } = useSlideEditSession.getState();
    expect(sceneId).toBe('scene-1');
    expect(history?.past).toEqual([]);
    expect(history?.future).toEqual([]);
    expect(history?.present.canvas.elements[0].id).toBe('text-1');
  });

  it('applyOp advances history by one undo step', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { left: 500 },
    });
    const { history } = useSlideEditSession.getState();
    expect(history?.past).toHaveLength(1);
    expect(history?.present.canvas.elements[0].left).toBe(500);
  });

  it('applyOp ignores a no-op against a missing element', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'does-not-exist',
      patch: { left: 1 },
    });
    expect(useSlideEditSession.getState().history?.past).toEqual([]);
  });

  it('absorbs non-user renderer commits into the baseline (no undo step)', () => {
    // The slide renderer normalizes content via a ResizeObserver (text
    // auto-height) with no user gesture; that must not become an
    // undoable, persisted "edit" that later triggers the restore prompt.
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const normalized = structuredClone(useSlideEditSession.getState().history!.present);
    (normalized.canvas.elements[0] as PPTTextElement).height = 999;
    useSlideEditSession.getState().commitContent(normalized, false);
    const { history } = useSlideEditSession.getState();
    expect(history?.past).toEqual([]);
    expect((history!.present.canvas.elements[0] as PPTTextElement).height).toBe(999);
  });

  it('records a user-driven commit as one undo transaction', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const next = structuredClone(useSlideEditSession.getState().history!.present);
    next.canvas.elements[0].left = 88;
    next.canvas.elements[0].top = 99;
    useSlideEditSession.getState().commitContent(next, true);
    const { history } = useSlideEditSession.getState();
    expect(history?.past).toHaveLength(1);
    expect(history?.present.canvas.elements[0]).toMatchObject({ left: 88, top: 99 });
  });

  it('a non-user commit after a user edit preserves the undo stack', () => {
    // Text auto-height reflows AFTER a user resizes a text box, with no
    // gesture in flight — that ResizeObserver commit must not wipe the
    // undo step the resize just created.
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
    // Undo still returns to the pre-resize width.
    useSlideEditSession.getState().undo();
    expect(useSlideEditSession.getState().history?.present.canvas.elements[0].width).toBe(
      makeContent().canvas.elements[0].width,
    );
  });

  it('undo / redo move between history states', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { rotate: 30 },
    });
    useSlideEditSession.getState().undo();
    expect(rotateOf(useSlideEditSession.getState().history!.present)).toBe(0);
    useSlideEditSession.getState().redo();
    expect(rotateOf(useSlideEditSession.getState().history!.present)).toBe(30);
  });

  it('restore adopts a persisted history wholesale', () => {
    const persisted = createSlideEditHistory(makeContent());
    persisted.past.push(makeContent());
    useSlideEditSession.getState().restore('scene-1', persisted);
    const { sceneId, history } = useSlideEditSession.getState();
    expect(sceneId).toBe('scene-1');
    expect(history?.past).toHaveLength(1);
  });

  it('seed has no pending restore in a clean env', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    expect(useSlideEditSession.getState().pendingRestore).toBe(false);
  });

  it('a non-user commit never persists or grows history even repeatedly', () => {
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
  });

  it('end clears the session', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().end();
    expect(useSlideEditSession.getState().sceneId).toBeNull();
    expect(useSlideEditSession.getState().history).toBeNull();
  });
});
