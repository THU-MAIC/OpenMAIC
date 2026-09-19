import { describe, expect, it } from 'vitest';
import type { PPTTextElement, SlideContent } from '@openmaic/dsl';
import {
  applyEditorTransaction,
  compileEditorEditIntents,
  createEditorHistory,
  createEditorTransaction,
  createEditorTransactionFromIntents,
  redoEditorTransaction,
  type EditorOperation,
  undoEditorTransaction,
} from '../../src/core/index';

function textElement(id: string, left = 40): PPTTextElement {
  return {
    id,
    type: 'text',
    left,
    top: 40,
    width: 240,
    height: 80,
    rotate: 0,
    content: '<p>Editor</p>',
    defaultFontName: 'Arial',
    defaultColor: '#333333',
  };
}

function slideContent(): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: 'slide-1',
      viewportSize: 1280,
      viewportRatio: 16 / 9,
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#6d28d9'],
        fontColor: '#333333',
        fontName: 'Arial',
      },
      elements: [textElement('text-1')],
    },
  };
}

describe('editor transaction core', () => {
  it('compiles canvas intents into canonical operations without host-specific semantics', () => {
    const operations = compileEditorEditIntents(slideContent(), [
      { type: 'element.update', id: 'text-1', props: { left: 120 } },
      { type: 'element.reorder', id: 'text-1', command: 'front' },
    ]);

    expect(operations).toEqual([
      { type: 'element.update', elementId: 'text-1', patch: { left: 120 } },
      { type: 'element.reorder', elementId: 'text-1', index: 0 },
    ]);
  });

  it('compiles slide background changes through the same intent channel', () => {
    const operations = compileEditorEditIntents(slideContent(), [
      { type: 'slide.update', props: { background: { type: 'solid', color: '#112233' } } },
    ]);

    expect(operations).toEqual([
      { type: 'slide.update', patch: { background: { type: 'solid', color: '#112233' } } },
    ]);
  });

  it('creates one host-ready transaction from a mixed canvas gesture batch', () => {
    const content = slideContent();
    const transaction = createEditorTransactionFromIntents({
      content,
      intents: [
        { type: 'text.updateContent', id: 'text-1', target: 'text', content: '<p>Changed</p>' },
        { type: 'element.update', id: 'text-1', props: { top: 80 } },
      ],
    });

    expect(transaction).toMatchObject({ origin: 'canvas', history: 'record' });
    expect(transaction?.operations).toEqual([
      { type: 'text.updateContent', elementId: 'text-1', content: '<p>Changed</p>' },
      { type: 'element.update', elementId: 'text-1', patch: { top: 80 } },
    ]);
    expect(applyEditorTransaction(content, transaction!)).toMatchObject({
      canvas: { elements: [{ content: '<p>Changed</p>', top: 80 }] },
    });
  });

  it('ignores stale intents and does not create an empty transaction', () => {
    expect(
      createEditorTransactionFromIntents({
        content: slideContent(),
        intents: [{ type: 'element.delete', ids: ['missing'] }],
      }),
    ).toBeNull();
  });

  it('rejects an invalid batch without applying its preceding operations', () => {
    const original = slideContent();
    const transaction = createEditorTransaction({
      origin: 'canvas',
      operations: [
        { type: 'element.update', elementId: 'text-1', patch: { left: 120 } },
        { type: 'element.delete', elementId: 'missing-element' },
      ],
    });

    expect(() => applyEditorTransaction(original, transaction)).toThrow(
      'element.delete: element "missing-element" does not exist',
    );
    expect(original.canvas.elements[0].left).toBe(40);
  });

  it('records a command batch as one undoable transaction', () => {
    const original = slideContent();
    const transaction = createEditorTransaction({
      origin: 'toolbar',
      operations: [
        { type: 'element.update', elementId: 'text-1', patch: { left: 120 } },
        { type: 'text.updateContent', elementId: 'text-1', content: '<p>Updated</p>' },
      ],
    });

    const after = applyEditorTransaction(createEditorHistory(original), transaction);
    expect(after.past).toHaveLength(1);
    expect(after.present.canvas.elements[0]).toMatchObject({
      left: 120,
      content: '<p>Updated</p>',
    });
    expect(undoEditorTransaction(after).present).toEqual(original);
    expect(redoEditorTransaction(undoEditorTransaction(after)).present).toEqual(after.present);
  });

  it('reconciles history-neutral rich-text undo with canonical history', () => {
    const original = slideContent();
    const first = applyEditorTransaction(
      createEditorHistory(original),
      createEditorTransaction({
        origin: 'canvas',
        operations: [{ type: 'text.updateContent', elementId: 'text-1', content: '<p>First</p>' }],
      }),
    );
    const second = applyEditorTransaction(
      first,
      createEditorTransaction({
        origin: 'canvas',
        operations: [{ type: 'text.updateContent', elementId: 'text-1', content: '<p>Second</p>' }],
      }),
    );

    const afterRichTextUndo = applyEditorTransaction(
      second,
      createEditorTransaction({
        origin: 'canvas',
        history: 'navigate',
        operations: [{ type: 'text.updateContent', elementId: 'text-1', content: '<p>First</p>' }],
      }),
    );

    expect(afterRichTextUndo.past).toEqual([original]);
    expect(afterRichTextUndo.present).toEqual(first.present);
    expect(afterRichTextUndo.future).toEqual([second.present]);
    expect(undoEditorTransaction(afterRichTextUndo).present).toEqual(original);
  });

  it('preserves skipped rich-text snapshots in redo order', () => {
    const original = slideContent();
    const contents = ['First', 'Second', 'Third'];
    const histories = contents.reduce<ReturnType<typeof createEditorHistory>[]>(
      (items, content) => {
        const previous = items.at(-1) ?? createEditorHistory(original);
        return [
          ...items,
          applyEditorTransaction(
            previous,
            createEditorTransaction({
              origin: 'canvas',
              operations: [
                { type: 'text.updateContent', elementId: 'text-1', content: `<p>${content}</p>` },
              ],
            }),
          ),
        ];
      },
      [],
    );

    const navigated = applyEditorTransaction(
      histories[2],
      createEditorTransaction({
        origin: 'canvas',
        history: 'navigate',
        operations: [{ type: 'text.updateContent', elementId: 'text-1', content: '<p>First</p>' }],
      }),
    );

    expect(
      navigated.future.map((snapshot) => (snapshot.canvas.elements[0] as PPTTextElement).content),
    ).toEqual(['<p>Second</p>', '<p>Third</p>']);
  });

  it('keeps normalization neutral even when it happens to match an old snapshot', () => {
    const original = slideContent();
    const resized = applyEditorTransaction(
      createEditorHistory(original),
      createEditorTransaction({
        origin: 'canvas',
        operations: [{ type: 'element.update', elementId: 'text-1', patch: { height: 120 } }],
      }),
    );
    const normalized = applyEditorTransaction(
      resized,
      createEditorTransaction({
        origin: 'system',
        history: 'neutral',
        operations: [{ type: 'element.update', elementId: 'text-1', patch: { height: 80 } }],
      }),
    );

    expect(normalized.past).toEqual([original]);
    expect(normalized.present).toEqual(original);
    expect(normalized.future).toEqual([]);
  });

  it('reconciles rich-text navigation while preserving current auto-size geometry', () => {
    const original = slideContent();
    const first = applyEditorTransaction(
      createEditorHistory(original),
      createEditorTransaction({
        origin: 'canvas',
        operations: [{ type: 'text.updateContent', elementId: 'text-1', content: '<p>First</p>' }],
      }),
    );
    const firstSized = applyEditorTransaction(
      first,
      createEditorTransaction({
        origin: 'system',
        history: 'neutral',
        operations: [{ type: 'element.update', elementId: 'text-1', patch: { height: 90 } }],
      }),
    );
    const second = applyEditorTransaction(
      firstSized,
      createEditorTransaction({
        origin: 'canvas',
        operations: [{ type: 'text.updateContent', elementId: 'text-1', content: '<p>Second</p>' }],
      }),
    );
    const secondSized = applyEditorTransaction(
      second,
      createEditorTransaction({
        origin: 'system',
        history: 'neutral',
        operations: [{ type: 'element.update', elementId: 'text-1', patch: { height: 100 } }],
      }),
    );

    const navigated = applyEditorTransaction(
      secondSized,
      createEditorTransaction({
        origin: 'canvas',
        history: 'navigate',
        operations: [{ type: 'text.updateContent', elementId: 'text-1', content: '<p>First</p>' }],
      }),
    );

    expect(navigated.past).toEqual([original]);
    expect(navigated.present.canvas.elements[0]).toMatchObject({
      content: '<p>First</p>',
      height: 100,
    });
    expect(navigated.future[0].canvas.elements[0]).toMatchObject({
      content: '<p>Second</p>',
      height: 100,
    });
  });

  it('rejects an alignment batch when any requested element is missing', () => {
    const original = slideContent();
    const transaction = createEditorTransaction({
      origin: 'toolbar',
      operations: [{ type: 'element.align', elementIds: ['text-1', 'missing'], command: 'center' }],
    });

    expect(() => applyEditorTransaction(original, transaction)).toThrow(
      'element.align: element "missing" does not exist',
    );
    expect(original.canvas.elements[0].left).toBe(40);
  });

  it.each([
    {
      operation: { type: 'slide.update', patch: { id: 'other-slide' } },
      message: 'slide.update cannot mutate immutable property "id"',
    },
    {
      operation: { type: 'element.update', elementId: 'text-1', patch: { id: 'other-id' } },
      message: 'element.update cannot mutate immutable property "id"',
    },
    {
      operation: { type: 'element.update', elementId: 'text-1', patch: { type: 'image' } },
      message: 'element.update cannot mutate immutable property "type"',
    },
    {
      operation: { type: 'element.removeProps', elementId: 'text-1', propNames: ['id'] },
      message: 'element.removeProps cannot remove immutable property "id"',
    },
    {
      operation: { type: 'element.removeProps', elementId: 'text-1', propNames: ['left'] },
      message: 'element.removeProps cannot remove required property "left" from text elements',
    },
    {
      operation: { type: 'element.removeProps', elementId: 'text-1', propNames: ['content'] },
      message: 'element.removeProps cannot remove required property "content" from text elements',
    },
    {
      operation: { type: 'slide.update', patch: { viewportSize: undefined } },
      message: 'slide.update cannot set required property "viewportSize" to undefined',
    },
    {
      operation: { type: 'element.update', elementId: 'text-1', patch: { left: undefined } },
      message: 'element.update cannot set required property "left" to undefined',
    },
    {
      operation: {
        type: 'element.updateMany',
        updates: [{ elementId: 'text-1', patch: { content: undefined } }],
      },
      message: 'element.updateMany cannot set required property "content" to undefined',
    },
  ] as const)('rejects immutable and required fields', ({ operation, message }) => {
    const original = slideContent();
    const transaction = createEditorTransaction({
      origin: 'agent',
      // Simulate an untyped external caller so the runtime guard remains covered.
      operations: [operation] as unknown as EditorOperation[],
    });

    expect(() => applyEditorTransaction(original, transaction)).toThrow(message);
    expect(original.canvas.elements[0]).toMatchObject({ id: 'text-1', type: 'text' });
  });

  it.each([
    {
      operation: { type: 'slide.update', patch: { viewportSize: null } },
      message: 'slide.update must set required property "viewportSize" to number',
    },
    {
      operation: { type: 'element.update', elementId: 'text-1', patch: { left: null } },
      message: 'element.update must set required property "left" to number',
    },
    {
      operation: {
        type: 'element.updateMany',
        updates: [{ elementId: 'text-1', patch: { content: 42 } }],
      },
      message: 'element.updateMany must set required property "content" to string',
    },
    {
      operation: {
        type: 'element.add',
        element: {
          id: 'incomplete-text',
          type: 'text',
          left: 0,
          top: 0,
          width: 120,
          height: 40,
          rotate: 0,
          defaultFontName: 'Arial',
          defaultColor: '#333333',
        },
      },
      message: 'element.add requires string property "content"',
    },
  ] as const)('rejects invalid required field values', ({ operation, message }) => {
    const transaction = createEditorTransaction({
      origin: 'agent',
      operations: [operation] as unknown as EditorOperation[],
    });

    expect(() => applyEditorTransaction(slideContent(), transaction)).toThrow(message);
  });
});
