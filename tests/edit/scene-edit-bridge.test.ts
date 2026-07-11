import { describe, expect, it } from 'vitest';
import {
  createDefaultImageElement,
  createDefaultSlide,
  createDefaultTextElement,
} from '@/lib/edit/slide-edit-elements';
import { commitSlideEdit, deriveSlideEditOperations } from '@/lib/edit/scene-edit-bridge';
import {
  createSlideEditHistory,
  redoSlideEditOperation,
  undoSlideEditOperation,
} from '@/lib/edit/slide-ops';
import type { PPTTextElement } from '@openmaic/dsl';
import type { SlideContent } from '@/lib/types/stage';

// The fixture's element 0 is always the default text element; narrow so
// tests can touch text-only geometry props (PPTLineElement has no
// height/rotate, so the bare union does not expose them).
const txt = (c: SlideContent) => c.canvas.elements[0] as PPTTextElement;

/**
 * The slide renderer commits geometry edits by handing the surface a whole
 * post-edit SlideContent (via the scene-context bridge). `deriveSlideEditOperations`
 * turns that snapshot diff back into the canonical slide-ops the kernel + PPTX
 * export understand, so the surface owns a real op/undo history instead of an
 * opaque content blob.
 */
function makeContent(): SlideContent {
  const slide = createDefaultSlide('slide-1');
  slide.elements.push(createDefaultTextElement('text-1'));
  return { type: 'slide', canvas: slide };
}

function clone(content: SlideContent): SlideContent {
  return structuredClone(content);
}

describe('deriveSlideEditOperations', () => {
  it('returns no ops when nothing changed', () => {
    const prev = makeContent();
    const next = clone(prev);
    expect(deriveSlideEditOperations(prev, next)).toEqual([]);
  });

  it('emits a single element.update with only the moved geometry keys', () => {
    const prev = makeContent();
    const next = clone(prev);
    next.canvas.elements[0].left = 320;
    next.canvas.elements[0].top = 240;

    expect(deriveSlideEditOperations(prev, next)).toEqual([
      { type: 'element.update', elementId: 'text-1', patch: { left: 320, top: 240 } },
    ]);
  });

  it('captures resize (width/height) and rotate in the patch', () => {
    const prev = makeContent();
    const next = clone(prev);
    txt(next).width = 500;
    txt(next).height = 300;
    txt(next).rotate = 45;

    expect(deriveSlideEditOperations(prev, next)).toEqual([
      {
        type: 'element.update',
        elementId: 'text-1',
        patch: { width: 500, height: 300, rotate: 45 },
      },
    ]);
  });

  it('emits one element.update per changed element for a multi-element move', () => {
    const prev = makeContent();
    prev.canvas.elements.push(createDefaultImageElement('img-1', 'https://example.com/a.png'));
    const next = clone(prev);
    next.canvas.elements[0].left += 10;
    next.canvas.elements[1].top += 25;

    const ops = deriveSlideEditOperations(prev, next);
    expect(ops).toHaveLength(2);
    expect(ops).toContainEqual({
      type: 'element.update',
      elementId: 'text-1',
      patch: { left: prev.canvas.elements[0].left + 10 },
    });
    expect(ops).toContainEqual({
      type: 'element.update',
      elementId: 'img-1',
      patch: { top: prev.canvas.elements[1].top + 25 },
    });
  });

  it('emits element.add for a new element with its insertion index', () => {
    const prev = makeContent();
    const next = clone(prev);
    const added = createDefaultImageElement('img-9', 'https://example.com/x.png');
    next.canvas.elements.push(added);

    expect(deriveSlideEditOperations(prev, next)).toEqual([
      { type: 'element.add', element: added, index: 1 },
    ]);
  });

  it('emits element.delete for a removed element', () => {
    const prev = makeContent();
    prev.canvas.elements.push(createDefaultImageElement('img-1', 'https://example.com/a.png'));
    const next = clone(prev);
    next.canvas.elements = next.canvas.elements.filter((el) => el.id !== 'img-1');

    expect(deriveSlideEditOperations(prev, next)).toEqual([
      { type: 'element.delete', elementId: 'img-1' },
    ]);
  });

  it('emits element.removeProps when a top-level prop is dropped', () => {
    const prev = makeContent();
    const next = clone(prev);
    delete txt(next).lineHeight;

    expect(deriveSlideEditOperations(prev, next)).toEqual([
      { type: 'element.removeProps', elementId: 'text-1', propNames: ['lineHeight'] },
    ]);
  });

  it('emits slide.update for canvas-meta changes (not elements)', () => {
    const prev = makeContent();
    const next = clone(prev);
    next.canvas.background = { type: 'solid', color: '#ff0000' };

    expect(deriveSlideEditOperations(prev, next)).toEqual([
      { type: 'slide.update', patch: { background: { type: 'solid', color: '#ff0000' } } },
    ]);
  });
});

describe('commitSlideEdit', () => {
  it('records a single-element commit as one undo step', () => {
    const history = createSlideEditHistory(makeContent());
    const next = clone(history.present);
    next.canvas.elements[0].left = 400;

    const after = commitSlideEdit(history, next);

    expect(after.past).toHaveLength(1);
    expect(after.future).toEqual([]);
    expect(after.present.canvas.elements[0].left).toBe(400);
    // The undo target is the pre-commit content.
    expect(undoSlideEditOperation(after).present.canvas.elements[0].left).toBe(
      history.present.canvas.elements[0].left,
    );
  });

  it('coalesces a multi-element commit into exactly one undo step', () => {
    const base = makeContent();
    base.canvas.elements.push(createDefaultImageElement('img-1', 'https://example.com/a.png'));
    const history = createSlideEditHistory(base);
    const next = clone(history.present);
    next.canvas.elements[0].left += 30;
    next.canvas.elements[1].top += 30;

    const after = commitSlideEdit(history, next);

    expect(after.past).toHaveLength(1);
    const undone = undoSlideEditOperation(after);
    expect(undone.present.canvas.elements[0].left).toBe(base.canvas.elements[0].left);
    expect(undone.present.canvas.elements[1].top).toBe(base.canvas.elements[1].top);
  });

  it('is a no-op when the committed content is unchanged', () => {
    const history = createSlideEditHistory(makeContent());
    const after = commitSlideEdit(history, clone(history.present));
    expect(after).toBe(history);
  });

  it('clears the redo stack on a fresh commit after undo', () => {
    const history = createSlideEditHistory(makeContent());
    const moved = clone(history.present);
    moved.canvas.elements[0].left = 200;
    const afterMove = commitSlideEdit(history, moved);
    const afterUndo = undoSlideEditOperation(afterMove);
    expect(redoSlideEditOperation(afterUndo).present.canvas.elements[0].left).toBe(200);

    const resized = clone(afterUndo.present);
    resized.canvas.elements[0].width = 999;
    const afterCommit = commitSlideEdit(afterUndo, resized);

    expect(afterCommit.future).toEqual([]);
    expect(afterCommit.present.canvas.elements[0].width).toBe(999);
  });
});
