import { describe, expect, it } from 'vitest';
import type { AlignCommand, EditIntent, ReorderCommand } from '@openmaic/renderer/editing';
import type { PPTElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import { applyRendererEditIntents } from '@/components/edit/surfaces/slide/renderer-edit-intents';
import type { SlideContent } from '@/lib/types/stage';

function textElement(id: string, overrides: Partial<PPTTextElement> = {}): PPTTextElement {
  return {
    id,
    type: 'text',
    left: 100,
    top: 100,
    width: 100,
    height: 100,
    rotate: 0,
    content: `<p>${id}</p>`,
    defaultFontName: 'Inter',
    defaultColor: '#111827',
    ...overrides,
  };
}

function shapeElement(id: string, overrides: Partial<PPTShapeElement> = {}): PPTShapeElement {
  return {
    id,
    type: 'shape',
    left: 200,
    top: 200,
    width: 200,
    height: 100,
    rotate: 0,
    viewBox: [200, 100],
    path: 'M 0 0 L 200 0 L 200 100 L 0 100 Z',
    fixedRatio: false,
    fill: '#ffffff',
    text: {
      content: '<p>Shape</p>',
      defaultFontName: 'Inter',
      defaultColor: '#111827',
      align: 'middle',
    },
    ...overrides,
  };
}

function slideContent(
  elements: PPTElement[] = [textElement('a'), textElement('b'), textElement('c')],
): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: 'slide-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      background: { type: 'solid', color: '#ffffff' },
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

describe('applyRendererEditIntents', () => {
  it('applies single and mixed multi-element updates without mutating the source', () => {
    const original = slideContent();

    const next = applyRendererEditIntents(original, [
      { type: 'element.update', id: 'a', props: { left: 40 } },
      {
        type: 'element.updateMany',
        updates: [
          { id: 'a', props: { top: 10 } },
          { id: 'b', props: { left: 20 } },
        ],
      },
    ]);

    expect(next.canvas.elements[0]).toMatchObject({ left: 40, top: 10 });
    expect(next.canvas.elements[1]).toMatchObject({ left: 20, top: 100 });
    expect(original.canvas.elements[0]).toMatchObject({ left: 100, top: 100 });
  });

  it('adds at an index and deletes elements plus their animations', () => {
    const original = slideContent();
    original.canvas.animations = [
      { id: 'anim-a', elId: 'a', effect: 'fade', type: 'in', duration: 500, trigger: 'click' },
      { id: 'anim-c', elId: 'c', effect: 'fade', type: 'in', duration: 500, trigger: 'click' },
    ];

    const next = applyRendererEditIntents(original, [
      { type: 'element.add', element: textElement('inserted'), index: 1 },
      { type: 'element.delete', ids: ['a', 'b'] },
    ]);

    expect(next.canvas.elements.map((element) => element.id)).toEqual(['inserted', 'c']);
    expect(next.canvas.animations?.map((animation) => animation.elId)).toEqual(['c']);
    expect(original.canvas.elements.map((element) => element.id)).toEqual(['a', 'b', 'c']);
  });

  it.each<[ReorderCommand, string, string[]]>([
    ['front', 'a', ['b', 'c', 'a']],
    ['back', 'c', ['c', 'a', 'b']],
    ['forward', 'a', ['b', 'a', 'c']],
    ['backward', 'c', ['a', 'c', 'b']],
  ])('maps %s reorder commands', (command, id, expectedOrder) => {
    const next = applyRendererEditIntents(slideContent(), [
      { type: 'element.reorder', id, command },
    ]);

    expect(next.canvas.elements.map((element) => element.id)).toEqual(expectedOrder);
  });

  it.each<[AlignCommand, Partial<PPTTextElement>]>([
    ['left', { left: 0 }],
    ['center', { left: 450 }],
    ['right', { left: 900 }],
    ['top', { top: 0 }],
    ['middle', { top: 231.25 }],
    ['bottom', { top: 462.5 }],
  ])('maps %s alignment to the canonical canvas operation', (command, expected) => {
    const content = slideContent([textElement('a')]);

    const next = applyRendererEditIntents(content, [
      { type: 'element.align', ids: ['a'], command },
    ]);

    expect(next.canvas.elements[0]).toMatchObject(expected);
  });

  it('removes properties and updates text or shape-label content', () => {
    const content = slideContent([
      textElement('text', { shadow: { h: 1, v: 1, blur: 2, color: '#000000' } }),
      shapeElement('shape'),
    ]);

    const next = applyRendererEditIntents(content, [
      { type: 'element.removeProps', id: 'text', props: ['shadow'] },
      { type: 'text.updateContent', id: 'text', content: '<p>Edited</p>', target: 'text' },
      {
        type: 'text.updateContent',
        id: 'shape',
        content: '<p>Edited shape</p>',
        target: 'shape',
      },
    ]);

    expect(next.canvas.elements[0]).not.toHaveProperty('shadow');
    expect(next.canvas.elements[0]).toMatchObject({ content: '<p>Edited</p>' });
    expect(next.canvas.elements[1]).toMatchObject({
      text: { content: '<p>Edited shape</p>' },
    });
  });

  it('ignores missing targets and target-kind mismatches without allocating a snapshot', () => {
    const content = slideContent([textElement('text'), shapeElement('shape')]);
    const intents: EditIntent[] = [
      { type: 'element.update', id: 'missing', props: { left: 99 } },
      { type: 'element.updateMany', updates: [{ id: 'missing', props: { top: 99 } }] },
      { type: 'element.delete', ids: ['missing'] },
      { type: 'element.reorder', id: 'missing', command: 'front' },
      { type: 'element.align', ids: ['missing'], command: 'left' },
      { type: 'element.removeProps', id: 'missing', props: ['shadow'] },
      { type: 'text.updateContent', id: 'text', content: '<p>No</p>', target: 'shape' },
      { type: 'text.updateContent', id: 'shape', content: '<p>No</p>', target: 'text' },
    ];

    expect(applyRendererEditIntents(content, intents)).toBe(content);
  });

  it('applies an intent batch in order', () => {
    const next = applyRendererEditIntents(slideContent(), [
      { type: 'element.update', id: 'a', props: { left: 48 } },
      { type: 'element.update', id: 'a', props: { left: 96, top: 64 } },
      { type: 'element.reorder', id: 'a', command: 'front' },
    ]);

    expect(next.canvas.elements.map((element) => element.id)).toEqual(['b', 'c', 'a']);
    expect(next.canvas.elements[2]).toMatchObject({ left: 96, top: 64 });
  });
});
