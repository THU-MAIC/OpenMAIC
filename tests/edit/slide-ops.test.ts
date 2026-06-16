import { describe, expect, test } from 'vitest';
import {
  applySlideEditOperation,
  createSlideEditHistory,
  redoSlideEditOperation,
  undoSlideEditOperation,
} from '@/lib/edit/slide-ops';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement, PPTLineElement, PPTTextElement } from '@maic/dsl';

function textElement(overrides: Partial<PPTTextElement> = {}): PPTTextElement {
  return {
    id: 'title',
    type: 'text',
    left: 100,
    top: 80,
    width: 420,
    height: 90,
    rotate: 0,
    content: '<p>Original title</p>',
    defaultFontName: 'Inter',
    defaultColor: '#111827',
    ...overrides,
  };
}

function lineElement(overrides: Partial<PPTLineElement> = {}): PPTLineElement {
  return {
    id: 'line-1',
    type: 'line',
    left: 100,
    top: 100,
    width: 200,
    start: [0, 0],
    end: [200, 100],
    style: 'solid',
    color: '#000000',
    points: ['', ''],
    ...overrides,
  };
}

function slideContent(elements: PPTElement[] = [textElement()]): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: 'slide-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#2563eb'],
        fontColor: '#111827',
        fontName: 'Inter',
      },
      elements,
    },
  };
}

describe('applySlideEditOperation', () => {
  test('updates an element without mutating the original slide content', () => {
    const original = slideContent();

    const updated = applySlideEditOperation(original, {
      type: 'element.update',
      elementId: 'title',
      patch: { left: 160, top: 120, rotate: 12 },
    });

    expect(updated.canvas.elements[0]).toMatchObject({ left: 160, top: 120, rotate: 12 });
    expect(original.canvas.elements[0]).toMatchObject({ left: 100, top: 80, rotate: 0 });
  });

  test('updates text content only for text elements', () => {
    const original = slideContent();

    const updated = applySlideEditOperation(original, {
      type: 'text.updateContent',
      elementId: 'title',
      content: '<p>Edited title</p>',
    });

    expect(updated.canvas.elements[0]).toMatchObject({ content: '<p>Edited title</p>' });
  });

  test('deletes an element and clears its animations', () => {
    const original = slideContent([
      textElement({ id: 'title' }),
      textElement({ id: 'subtitle', content: '<p>Subtitle</p>' }),
    ]);
    original.canvas.animations = [
      {
        id: 'anim-1',
        elId: 'subtitle',
        effect: 'fade',
        type: 'in',
        duration: 600,
        trigger: 'click',
      },
    ];

    const updated = applySlideEditOperation(original, {
      type: 'element.delete',
      elementId: 'subtitle',
    });

    expect(updated.canvas.elements.map((element) => element.id)).toEqual(['title']);
    expect(updated.canvas.animations).toEqual([]);
  });

  test('reorders an element by moving it to the requested index', () => {
    const original = slideContent([
      textElement({ id: 'background' }),
      textElement({ id: 'title' }),
      textElement({ id: 'caption' }),
    ]);

    const updated = applySlideEditOperation(original, {
      type: 'element.reorder',
      elementId: 'background',
      index: 2,
    });

    expect(updated.canvas.elements.map((element) => element.id)).toEqual([
      'title',
      'caption',
      'background',
    ]);
    expect(original.canvas.elements.map((element) => element.id)).toEqual([
      'background',
      'title',
      'caption',
    ]);
  });

  test('updates multiple selected elements with the same patch', () => {
    const original = slideContent([textElement({ id: 'title' }), textElement({ id: 'caption' })]);

    const updated = applySlideEditOperation(original, {
      type: 'element.updateMany',
      elementIds: ['title', 'caption'],
      patch: { lock: true },
    });

    expect(updated.canvas.elements.map((element) => element.lock)).toEqual([true, true]);
    expect(original.canvas.elements.map((element) => element.lock)).toEqual([undefined, undefined]);
  });

  test('duplicates selected elements with caller-provided ids and offsets', () => {
    const original = slideContent([textElement({ id: 'title' })]);

    const updated = applySlideEditOperation(original, {
      type: 'element.duplicate',
      elementIds: ['title'],
      idMap: { title: 'title-copy' },
      offset: { x: 24, y: 16 },
    });

    expect(updated.canvas.elements.map((element) => element.id)).toEqual(['title', 'title-copy']);
    expect(updated.canvas.elements[1]).toMatchObject({ left: 124, top: 96 });
    expect(original.canvas.elements).toHaveLength(1);
  });

  test('deletes multiple selected elements and clears their animations', () => {
    const original = slideContent([
      textElement({ id: 'title' }),
      textElement({ id: 'caption' }),
      textElement({ id: 'footer' }),
    ]);
    original.canvas.animations = [
      { id: 'anim-1', elId: 'title', effect: 'fade', type: 'in', duration: 600, trigger: 'click' },
      { id: 'anim-2', elId: 'footer', effect: 'fade', type: 'in', duration: 600, trigger: 'click' },
    ];

    const updated = applySlideEditOperation(original, {
      type: 'element.deleteMany',
      elementIds: ['title', 'caption'],
    });

    expect(updated.canvas.elements.map((element) => element.id)).toEqual(['footer']);
    expect(updated.canvas.animations?.map((animation) => animation.elId)).toEqual(['footer']);
  });

  test('aligns selected elements horizontally to the slide canvas', () => {
    const original = slideContent([
      textElement({ id: 'title', left: 100, top: 80, width: 200, height: 90 }),
      textElement({ id: 'caption', left: 360, top: 180, width: 100, height: 60 }),
    ]);

    const updated = applySlideEditOperation(original, {
      type: 'element.align',
      elementIds: ['title', 'caption'],
      command: 'horizontal',
    });

    expect(updated.canvas.elements.map((element) => element.left)).toEqual([320, 580]);
  });

  test('removes element properties from selected elements', () => {
    const original = slideContent([
      textElement({
        id: 'title',
        outline: { width: 2, color: '#111111', style: 'solid' },
      }),
    ]);

    const updated = applySlideEditOperation(original, {
      type: 'element.removeProps',
      elementId: 'title',
      propNames: ['outline'],
    });

    expect('outline' in updated.canvas.elements[0]).toBe(false);
    expect('outline' in original.canvas.elements[0]).toBe(true);
  });
});

describe('element.add', () => {
  test('appends to the end when no index is given', () => {
    const original = slideContent([textElement({ id: 'a' })]);
    const updated = applySlideEditOperation(original, {
      type: 'element.add',
      element: textElement({ id: 'b' }),
    });

    expect(updated.canvas.elements.map((e) => e.id)).toEqual(['a', 'b']);
  });

  test('inserts at the requested index', () => {
    const original = slideContent([textElement({ id: 'a' }), textElement({ id: 'c' })]);
    const updated = applySlideEditOperation(original, {
      type: 'element.add',
      element: textElement({ id: 'b' }),
      index: 1,
    });

    expect(updated.canvas.elements.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  test('clamps out-of-range index to the end of the list', () => {
    const original = slideContent([textElement({ id: 'a' })]);
    const updated = applySlideEditOperation(original, {
      type: 'element.add',
      element: textElement({ id: 'b' }),
      index: 999,
    });

    expect(updated.canvas.elements.map((e) => e.id)).toEqual(['a', 'b']);
  });

  test('clamps negative index to 0', () => {
    const original = slideContent([textElement({ id: 'a' })]);
    const updated = applySlideEditOperation(original, {
      type: 'element.add',
      element: textElement({ id: 'b' }),
      index: -5,
    });

    expect(updated.canvas.elements.map((e) => e.id)).toEqual(['b', 'a']);
  });

  test('throws when the new id collides with an existing element', () => {
    const original = slideContent([textElement({ id: 'title' })]);
    expect(() =>
      applySlideEditOperation(original, {
        type: 'element.add',
        element: textElement({ id: 'title', content: '<p>Dup</p>' }),
      }),
    ).toThrow(/already exists/);
  });
});

describe('slide.update contract', () => {
  test('rejects element / animation collections at runtime even via type cast', () => {
    const original = slideContent();
    expect(() =>
      applySlideEditOperation(original, {
        type: 'slide.update',
        // `as never` defeats the SlideMetaPatch type narrowing — the runtime
        // guard is the second line of defense for misuse from JS callers or
        // anywhere a cast slips through.
        patch: { elements: [] } as never,
      }),
    ).toThrow(/dedicated/);
  });

  test('applies meta-only patches (theme/background) successfully', () => {
    const original = slideContent();
    const updated = applySlideEditOperation(original, {
      type: 'slide.update',
      patch: { background: { type: 'solid', color: '#000000' } },
    });
    expect(updated.canvas.background).toEqual({ type: 'solid', color: '#000000' });
  });
});

describe('element.duplicate contract', () => {
  test('uses the default offset {x:20, y:20} when no offset is given', () => {
    const original = slideContent([textElement({ id: 'a', left: 100, top: 50 })]);

    const updated = applySlideEditOperation(original, {
      type: 'element.duplicate',
      elementIds: ['a'],
      idMap: { a: 'a-copy' },
    });

    expect(updated.canvas.elements[1]).toMatchObject({ id: 'a-copy', left: 120, top: 70 });
  });

  test('throws when idMap is missing an entry for a selected id', () => {
    const original = slideContent([textElement({ id: 'a' }), textElement({ id: 'b' })]);

    expect(() =>
      applySlideEditOperation(original, {
        type: 'element.duplicate',
        elementIds: ['a', 'b'],
        idMap: { a: 'a-copy' },
      }),
    ).toThrow(/missing entries/);
  });

  test('throws when a new id would collide with an existing element', () => {
    const original = slideContent([textElement({ id: 'a' }), textElement({ id: 'b' })]);

    expect(() =>
      applySlideEditOperation(original, {
        type: 'element.duplicate',
        elementIds: ['a'],
        idMap: { a: 'b' },
      }),
    ).toThrow(/collide/);
  });

  test('deep-clones nested fields so the duplicate cannot leak mutations to the source', () => {
    // A line element carries a mutable tuple (start). A shallow spread would
    // share the same array between source and duplicate; a subsequent op
    // that mutates the duplicate's start in place would silently mutate the
    // source too. After the deep clone the two are independent.
    const original = slideContent([lineElement({ id: 'l1', start: [0, 0], end: [10, 10] })]);
    const updated = applySlideEditOperation(original, {
      type: 'element.duplicate',
      elementIds: ['l1'],
      idMap: { l1: 'l1-copy' },
    });
    const source = updated.canvas.elements[0] as PPTLineElement;
    const dup = updated.canvas.elements[1] as PPTLineElement;
    expect(source.start).not.toBe(dup.start);
    expect(source.end).not.toBe(dup.end);
    expect(source.points).not.toBe(dup.points);
  });
});

describe('element.align all directions', () => {
  function twoBoxes(): SlideContent {
    return slideContent([
      textElement({ id: 'a', left: 100, top: 80, width: 200, height: 90 }),
      textElement({ id: 'b', left: 360, top: 180, width: 100, height: 60 }),
    ]);
  }

  test('top aligns the group to the top edge of the canvas', () => {
    const updated = applySlideEditOperation(twoBoxes(), {
      type: 'element.align',
      elementIds: ['a', 'b'],
      command: 'top',
    });
    // group's minY is 80, so subtract 80 from each top
    expect(updated.canvas.elements.map((e) => e.top)).toEqual([0, 100]);
  });

  test('bottom aligns the group to the bottom edge of the canvas', () => {
    const updated = applySlideEditOperation(twoBoxes(), {
      type: 'element.align',
      elementIds: ['a', 'b'],
      command: 'bottom',
    });
    // viewportHeight = 1000 * 0.5625 = 562.5; group's maxY = max(80+90, 180+60) = 240
    // offsetY = 240 - 562.5 = -322.5; new tops = 80 - (-322.5) = 402.5, 180 - (-322.5) = 502.5
    expect(updated.canvas.elements.map((e) => e.top)).toEqual([402.5, 502.5]);
  });

  test('left aligns the group to the left edge of the canvas', () => {
    const updated = applySlideEditOperation(twoBoxes(), {
      type: 'element.align',
      elementIds: ['a', 'b'],
      command: 'left',
    });
    // group's minX = 100, so subtract 100 from each left
    expect(updated.canvas.elements.map((e) => e.left)).toEqual([0, 260]);
  });

  test('right aligns the group to the right edge of the canvas', () => {
    const updated = applySlideEditOperation(twoBoxes(), {
      type: 'element.align',
      elementIds: ['a', 'b'],
      command: 'right',
    });
    // viewportWidth = 1000; group's maxX = max(100+200, 360+100) = 460
    // offsetX = 460 - 1000 = -540; new lefts = 100 - (-540) = 640, 360 - (-540) = 900
    expect(updated.canvas.elements.map((e) => e.left)).toEqual([640, 900]);
  });

  test('vertical centers the group on the vertical axis', () => {
    const updated = applySlideEditOperation(twoBoxes(), {
      type: 'element.align',
      elementIds: ['a', 'b'],
      command: 'vertical',
    });
    // group's midY = 80 + (240 - 80) / 2 = 160; canvasMidY = 562.5 / 2 = 281.25
    // offsetY = 160 - 281.25 = -121.25
    expect(updated.canvas.elements.map((e) => e.top)).toEqual([201.25, 301.25]);
  });

  test('center centers the group on both axes', () => {
    const updated = applySlideEditOperation(twoBoxes(), {
      type: 'element.align',
      elementIds: ['a', 'b'],
      command: 'center',
    });
    expect(updated.canvas.elements.map((e) => e.left)).toEqual([320, 580]);
    expect(updated.canvas.elements.map((e) => e.top)).toEqual([201.25, 301.25]);
  });

  test('uses canonical geometry for line elements (start/end, not width/height=0)', () => {
    // A line visually spanning (left+0, top+0) to (left+200, top+100).
    // The old local fork ignored start/end and treated the line as height 0,
    // so 'bottom' would have aligned by line.top alone. The canonical helper
    // uses start/end so the real extent (top..top+end[1]) drives the offset.
    const original = slideContent([
      lineElement({ id: 'line-1', left: 100, top: 50, start: [0, 0], end: [200, 100] }),
    ]);
    const updated = applySlideEditOperation(original, {
      type: 'element.align',
      elementIds: ['line-1'],
      command: 'bottom',
    });
    // viewportHeight = 562.5; line maxY = top + end[1] = 50 + 100 = 150
    // offsetY = 150 - 562.5 = -412.5; new top = 50 - (-412.5) = 462.5
    expect(updated.canvas.elements[0].top).toBe(462.5);
  });

  test('uses rotated bounding box for rotated elements', () => {
    // A 100×100 square rotated 45° fills an axis-aligned box wider than 100,
    // anchored at its center. The canonical helper accounts for rotation;
    // the old local fork used the unrotated rect and would put left at 0.
    const original = slideContent([
      textElement({ id: 'r', left: 100, top: 100, width: 100, height: 100, rotate: 45 }),
    ]);
    const updated = applySlideEditOperation(original, {
      type: 'element.align',
      elementIds: ['r'],
      command: 'left',
    });
    // Pre-fix: unrotated minX = 100 → after align left, left ends at 0.
    // Post-fix: rotated OOBB minX < 100 → after align, left ends > 0.
    expect(updated.canvas.elements[0].left).toBeGreaterThan(0);
    expect(updated.canvas.elements[0].left).toBeLessThan(100);
  });
});

describe('no-op operations skip history push', () => {
  test('element.update against a missing id returns the same content reference', () => {
    const original = slideContent();
    const updated = applySlideEditOperation(original, {
      type: 'element.update',
      elementId: 'nope',
      patch: { left: 999 },
    });
    expect(updated).toBe(original);
  });

  test('element.delete against a missing id returns the same content reference', () => {
    const original = slideContent();
    const updated = applySlideEditOperation(original, {
      type: 'element.delete',
      elementId: 'nope',
    });
    expect(updated).toBe(original);
  });

  test('element.deleteMany against unmatched ids returns the same content reference', () => {
    const original = slideContent();
    const updated = applySlideEditOperation(original, {
      type: 'element.deleteMany',
      elementIds: ['nope-1', 'nope-2'],
    });
    expect(updated).toBe(original);
  });

  test('element.reorder against a missing id returns the same content reference', () => {
    const original = slideContent();
    const updated = applySlideEditOperation(original, {
      type: 'element.reorder',
      elementId: 'nope',
      index: 0,
    });
    expect(updated).toBe(original);
  });

  test('element.removeProps against a missing id returns the same content reference', () => {
    const original = slideContent();
    const updated = applySlideEditOperation(original, {
      type: 'element.removeProps',
      elementId: 'nope',
      propNames: ['outline'],
    });
    expect(updated).toBe(original);
  });

  test('text.updateContent against a missing id returns the same content reference', () => {
    const original = slideContent();
    const updated = applySlideEditOperation(original, {
      type: 'text.updateContent',
      elementId: 'nope',
      content: '<p>X</p>',
    });
    expect(updated).toBe(original);
  });

  test('element.align with empty selection returns the same content reference', () => {
    const original = slideContent();
    const updated = applySlideEditOperation(original, {
      type: 'element.align',
      elementIds: [],
      command: 'center',
    });
    expect(updated).toBe(original);
  });

  test('history is unchanged when the underlying op is a no-op', () => {
    const original = slideContent();
    const history = createSlideEditHistory(original);
    const next = applySlideEditOperation(history, {
      type: 'element.update',
      elementId: 'nope',
      patch: { left: 1 },
    });
    expect(next).toBe(history);
    expect(next.past).toHaveLength(0);
  });
});

describe('slide edit history', () => {
  test('undoes and redoes operations using immutable snapshots', () => {
    const original = slideContent();
    let history = createSlideEditHistory(original);

    history = applySlideEditOperation(history, {
      type: 'element.update',
      elementId: 'title',
      patch: { left: 200 },
    });
    expect(history.present.canvas.elements[0].left).toBe(200);

    history = undoSlideEditOperation(history);
    expect(history.present.canvas.elements[0].left).toBe(100);

    history = redoSlideEditOperation(history);
    expect(history.present.canvas.elements[0].left).toBe(200);
  });

  test('clears the redo stack after a new op following undo', () => {
    let history = createSlideEditHistory(slideContent());

    history = applySlideEditOperation(history, {
      type: 'element.update',
      elementId: 'title',
      patch: { left: 200 },
    });
    history = undoSlideEditOperation(history);
    expect(history.future).toHaveLength(1);

    // A new op branches the timeline and should drop the redo stack.
    history = applySlideEditOperation(history, {
      type: 'element.update',
      elementId: 'title',
      patch: { left: 300 },
    });
    expect(history.future).toEqual([]);
    expect(history.present.canvas.elements[0].left).toBe(300);
  });

  test('caps past length so long edit sessions do not grow unbounded', () => {
    let history = createSlideEditHistory(slideContent());
    // More ops than MAX_HISTORY (50) — past should be clamped, present is current.
    for (let i = 0; i < 70; i++) {
      history = applySlideEditOperation(history, {
        type: 'element.update',
        elementId: 'title',
        patch: { left: 100 + i },
      });
    }
    expect(history.past.length).toBeLessThanOrEqual(50);
    expect(history.present.canvas.elements[0].left).toBe(169);
  });
});
