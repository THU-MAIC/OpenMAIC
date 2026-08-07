import { describe, expect, it } from 'vitest';
import type { PPTTextElement, SlideContent } from '@openmaic/dsl';
import {
  applyEditorTransaction,
  createEditorHistory,
  createEditorTransaction,
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

  it.each([
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
  ] as const)('rejects immutable element fields', ({ operation, message }) => {
    const original = slideContent();
    const transaction = createEditorTransaction({
      origin: 'agent',
      // Simulate an untyped external caller so the runtime guard remains covered.
      operations: [operation] as unknown as EditorOperation[],
    });

    expect(() => applyEditorTransaction(original, transaction)).toThrow(message);
    expect(original.canvas.elements[0]).toMatchObject({ id: 'text-1', type: 'text' });
  });
});
