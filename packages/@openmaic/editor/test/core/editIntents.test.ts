import { describe, expect, it } from 'vitest';
import type {
  SlideContent,
  PPTElement,
  PPTLatexElement,
  PPTShapeElement,
  PPTTableElement,
  PPTTextElement,
  PPTVideoElement,
} from '@openmaic/dsl';
import {
  applyEditorTransaction,
  compileEditorEditIntents,
  createEditorTransactionFromIntents,
  type AlignCommand,
  type EditIntent,
  type ReorderCommand,
} from '../../src/core/index';

function applyEditIntents(content: SlideContent, intents: readonly EditIntent[]): SlideContent {
  const transaction = createEditorTransactionFromIntents({
    content,
    intents,
    origin: 'system',
    history: 'neutral',
  });
  return transaction ? applyEditorTransaction(content, transaction) : content;
}

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

function tableElement(id: string, overrides: Partial<PPTTableElement> = {}): PPTTableElement {
  return {
    id,
    type: 'table',
    left: 100,
    top: 100,
    width: 200,
    height: 120,
    rotate: 0,
    cellMinHeight: 40,
    colWidths: [0.5, 0.5],
    outline: { width: 1, color: '#111827', style: 'solid' },
    data: [
      [
        { id: 'a', text: 'A', colspan: 1, rowspan: 1 },
        { id: 'b', text: 'B', colspan: 1, rowspan: 1 },
      ],
      [
        { id: 'c', text: 'C', colspan: 1, rowspan: 1 },
        { id: 'd', text: 'D', colspan: 1, rowspan: 1 },
      ],
    ],
    ...overrides,
  };
}

function latexElement(id: string, overrides: Partial<PPTLatexElement> = {}): PPTLatexElement {
  return {
    id,
    type: 'latex',
    left: 100,
    top: 100,
    width: 240,
    height: 80,
    rotate: 0,
    latex: 'E = mc^2',
    html: '<span class="katex">E = mc<sup>2</sup></span>',
    color: '#2563eb',
    align: 'center',
    ...overrides,
  };
}

function videoElement(id: string, overrides: Partial<PPTVideoElement> = {}): PPTVideoElement {
  return {
    id,
    type: 'video',
    left: 100,
    top: 100,
    width: 320,
    height: 180,
    rotate: 0,
    src: 'video.mp4',
    autoplay: false,
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

describe('editor edit intents', () => {
  it('compiles edit intents into canonical editor operations', () => {
    const operations = compileEditorEditIntents(slideContent(), [
      { type: 'element.update', id: 'a', props: { left: 48 } },
      { type: 'element.reorder', id: 'a', command: 'front' },
    ]);

    expect(operations).toEqual([
      { type: 'element.update', elementId: 'a', patch: { left: 48 } },
      { type: 'element.reorder', elementId: 'a', index: 2 },
    ]);
  });

  it('persists a table resize including its cellMinHeight patch', () => {
    const original = slideContent([tableElement('table')]);

    const next = applyEditIntents(original, [
      {
        type: 'element.update',
        id: 'table',
        props: { left: 100, top: 100, width: 200, height: 160, cellMinHeight: 60 },
      },
    ]);

    expect(next.canvas.elements[0]).toMatchObject({ height: 160, cellMinHeight: 60 });
    expect(original.canvas.elements[0]).toMatchObject({ height: 120, cellMinHeight: 40 });
  });

  it('updates only the requested table cell text', () => {
    const original = slideContent([tableElement('table')]);

    const next = applyEditIntents(original, [
      { type: 'table.updateCell', id: 'table', cellId: 'c', text: 'Edited<br>cell' },
    ]);

    const table = next.canvas.elements[0] as PPTTableElement;
    expect(table.data[1][0].text).toBe('Edited<br>cell');
    expect(table.data[0][0].text).toBe('A');
    expect((original.canvas.elements[0] as PPTTableElement).data[1][0].text).toBe('C');
  });

  it('applies single and mixed multi-element updates without mutating the source', () => {
    const original = slideContent();

    const next = applyEditIntents(original, [
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

    const next = applyEditIntents(original, [
      { type: 'element.add', element: textElement('inserted'), index: 1 },
      { type: 'element.delete', ids: ['a', 'b'] },
    ]);

    expect(next.canvas.elements.map((element) => element.id)).toEqual(['inserted', 'c']);
    expect(next.canvas.animations?.map((animation) => animation.elId)).toEqual(['c']);
    expect(original.canvas.elements.map((element) => element.id)).toEqual(['a', 'b', 'c']);
  });

  it('persists latex additions and geometry updates without changing the formula contract', () => {
    const original = slideContent([latexElement('formula')]);

    const next = applyEditIntents(original, [
      {
        type: 'element.update',
        id: 'formula',
        props: { left: 140, top: 160, width: 300, height: 100, rotate: 45 },
      },
      { type: 'element.add', element: latexElement('inserted'), index: 0 },
    ]);

    expect(next.canvas.elements.map((element) => element.id)).toEqual(['inserted', 'formula']);
    expect(next.canvas.elements[1]).toMatchObject({
      type: 'latex',
      latex: 'E = mc^2',
      html: '<span class="katex">E = mc<sup>2</sup></span>',
      color: '#2563eb',
      align: 'center',
      left: 140,
      top: 160,
      width: 300,
      height: 100,
      rotate: 45,
    });
    expect(original.canvas.elements[0]).toMatchObject({ left: 100, top: 100, rotate: 0 });
  });

  it('persists video poster and autoplay properties without mutating the source', () => {
    const original = slideContent([videoElement('video')]);

    const next = applyEditIntents(original, [
      {
        type: 'element.update',
        id: 'video',
        props: { poster: 'cover.png', autoplay: true },
      },
    ]);

    expect(next.canvas.elements[0]).toMatchObject({
      id: 'video',
      type: 'video',
      poster: 'cover.png',
      autoplay: true,
    });
    expect(original.canvas.elements[0]).toMatchObject({ autoplay: false });
    expect(original.canvas.elements[0]).not.toHaveProperty('poster');
  });

  it.each<[ReorderCommand, string, string[]]>([
    ['front', 'a', ['b', 'c', 'a']],
    ['back', 'c', ['c', 'a', 'b']],
    ['forward', 'a', ['b', 'a', 'c']],
    ['backward', 'c', ['a', 'c', 'b']],
  ])('maps %s reorder commands', (command, id, expectedOrder) => {
    const next = applyEditIntents(slideContent(), [{ type: 'element.reorder', id, command }]);

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

    const next = applyEditIntents(content, [{ type: 'element.align', ids: ['a'], command }]);

    expect(next.canvas.elements[0]).toMatchObject(expected);
  });

  it('removes properties and updates text or shape-label content', () => {
    const content = slideContent([
      textElement('text', { shadow: { h: 1, v: 1, blur: 2, color: '#000000' } }),
      shapeElement('shape'),
    ]);

    const next = applyEditIntents(content, [
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

  it('creates a Shape text contract when a label is edited for the first time', () => {
    const content = slideContent([shapeElement('shape', { text: undefined })]);

    const next = applyEditIntents(content, [
      { type: 'text.updateContent', id: 'shape', content: '<p>New label</p>', target: 'shape' },
    ]);

    expect(next.canvas.elements[0]).toMatchObject({
      text: {
        content: '<p>New label</p>',
        align: 'middle',
        defaultFontName: 'Microsoft YaHei',
        defaultColor: '#333333',
      },
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

    expect(applyEditIntents(content, intents)).toBe(content);
  });

  it('applies an intent batch in order', () => {
    const next = applyEditIntents(slideContent(), [
      { type: 'element.update', id: 'a', props: { left: 48 } },
      { type: 'element.update', id: 'a', props: { left: 96, top: 64 } },
      { type: 'element.reorder', id: 'a', command: 'front' },
    ]);

    expect(next.canvas.elements.map((element) => element.id)).toEqual(['b', 'c', 'a']);
    expect(next.canvas.elements[2]).toMatchObject({ left: 96, top: 64 });
  });
});
