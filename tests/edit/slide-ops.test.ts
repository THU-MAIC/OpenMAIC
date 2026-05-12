import { describe, expect, test } from 'vitest';
import {
  applySlideEditOperation,
  createSlideEditHistory,
  redoSlideEditOperation,
  undoSlideEditOperation,
} from '@/lib/edit/slide-ops';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement, PPTTextElement } from '@/lib/types/slides';

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
      { id: 'anim-1', elId: 'subtitle', effect: 'fade', type: 'in', duration: 600, trigger: 'click' },
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

  test('aligns selected elements to the slide canvas', () => {
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
});
