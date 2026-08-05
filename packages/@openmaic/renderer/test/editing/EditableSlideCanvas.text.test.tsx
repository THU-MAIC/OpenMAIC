// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import { EditableSlideCanvas } from '../../src/editing/EditableSlideCanvas';

const textElement = {
  id: 'text-1',
  type: 'text',
  left: 20,
  top: 30,
  width: 240,
  height: 80,
  rotate: 0,
  content: '<p>Hello</p>',
  defaultFontName: 'Arial',
  defaultColor: '#111111',
  lineHeight: 1.4,
} as const;

const slide = {
  id: 'slide-1',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  elements: [
    textElement,
    { ...textElement, id: 'locked-text', lock: true },
    { ...textElement, id: 'hidden-text' },
  ],
} as unknown as Slide;

describe('EditableSlideCanvas text rendering', () => {
  it('mounts one renderer editor only for the active editable text', () => {
    const onTextEditorChange = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' }}
        hiddenElementIds={['hidden-text']}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
        onTextEditorChange={onTextEditorChange}
      />,
    );

    expect(container.querySelectorAll('[data-renderer-text-editor]')).toHaveLength(1);
    expect(container.querySelector('[data-renderer-text-editor="text-1"]')).not.toBeNull();
    expect(container.querySelector('#slide-element-text-1 .ProseMirror-static')).toBeNull();
    expect(onTextEditorChange).toHaveBeenCalledWith(
      expect.objectContaining({ elementId: 'text-1' }),
    );
  });

  it.each([
    ['locked text', 'locked-text', undefined],
    ['hidden text', 'hidden-text', ['hidden-text']],
    ['missing text', 'missing-text', undefined],
  ])('does not mount an editor for %s', (_label, editingId, hiddenElementIds) => {
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: [editingId], primaryId: editingId, editingId }}
        hiddenElementIds={hiddenElementIds}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-renderer-text-editor]')).toBeNull();
  });
});
