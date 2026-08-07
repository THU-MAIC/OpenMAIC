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
