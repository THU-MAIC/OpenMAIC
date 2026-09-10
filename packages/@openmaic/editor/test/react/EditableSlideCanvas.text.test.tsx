// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { EditorView } from 'prosemirror-view';
import { describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import { EditableSlideCanvas } from '../../src/react/EditableSlideCanvas';
import type { TextEditorController } from '../../src/react/text/types';

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
    { ...textElement, id: 'text-2', top: 140 },
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
        onTextContentChange={vi.fn()}
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

  it('injects the shared renderer prose layout rules for ProseMirror', () => {
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
        onTextContentChange={vi.fn()}
      />,
    );

    expect(
      [...container.querySelectorAll('style')].some(
        (style) =>
          style.textContent?.includes('.renderer-prosemirror-editor .ProseMirror p {') &&
          style.textContent?.includes(
            '.renderer-prosemirror-editor .ProseMirror p:empty::before {',
          ) &&
          style.textContent?.includes('.renderer-prosemirror-editor .ProseMirror ul {'),
      ),
    ).toBe(true);
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

  it('does not mount an editor for a multi-selection with an editing id', () => {
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{
          elementIds: ['text-1', 'locked-text'],
          primaryId: 'text-1',
          editingId: 'text-1',
        }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
        onTextContentChange={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-renderer-text-editor]')).toBeNull();
  });

  it('enters text editing on a click but keeps a drag as a move gesture', () => {
    const onSelectionChange = vi.fn();
    const onElementsChange = vi.fn();
    const { container, rerender } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSelectionChange}
        onElementsChange={onElementsChange}
        onTextContentChange={vi.fn()}
      />,
    );
    const body = container.querySelector('[data-select-element-id="text-1"]') as HTMLElement;

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      elementIds: ['text-1'],
      primaryId: 'text-1',
      editingId: 'text-1',
    });

    onSelectionChange.mockClear();
    rerender(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['text-1'], primaryId: 'text-1' }}
        onSelectionChange={onSelectionChange}
        onElementsChange={onElementsChange}
        onTextContentChange={vi.fn()}
      />,
    );
    const border = container.querySelector('[data-element-id="text-1"]') as SVGElement;
    fireEvent.pointerDown(border, { pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(border, { pointerId: 2, clientX: 30, clientY: 20 });
    expect(onElementsChange).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'element.update', id: 'text-1' }),
    ]);
    expect(onSelectionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ editingId: 'text-1' }),
    );
  });

  it('places the text caret at the clicked position when entering edit mode', () => {
    const posAtCoords = vi
      .spyOn(EditorView.prototype, 'posAtCoords')
      .mockReturnValue({ pos: 4, inside: 1 });
    const onSelectionChange = vi.fn();
    const controllerRef: { current: TextEditorController | null } = { current: null };
    const { container, rerender } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSelectionChange}
        onElementsChange={vi.fn()}
        onTextContentChange={vi.fn()}
        onTextEditorChange={(next) => {
          controllerRef.current = next;
        }}
      />,
    );
    const body = container.querySelector('[data-select-element-id="text-1"]') as HTMLElement;

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 180, clientY: 55 });
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 180, clientY: 55 });
    rerender(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' }}
        onSelectionChange={onSelectionChange}
        onElementsChange={vi.fn()}
        onTextContentChange={vi.fn()}
        onTextEditorChange={(next) => {
          controllerRef.current = next;
        }}
      />,
    );

    expect(posAtCoords).toHaveBeenCalledWith({ left: 180, top: 55 });
    const controller = controllerRef.current;
    if (controller === null)
      throw new Error('Expected the text editor controller to be registered');
    act(() => controller.execute({ command: 'insert', value: 'X' }));
    expect(controller.getHTML()).toContain('HelXlo');
  });

  it('exposes the active ProseMirror pointer path and exits editing on Escape', () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' }}
        onSelectionChange={onSelectionChange}
        onElementsChange={vi.fn()}
        onTextContentChange={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-select-element-id="text-1"]')).toBeNull();
    expect(container.querySelector('[data-element-id="text-1"]')).not.toBeNull();
    expect(
      (container.querySelector('[data-marquee-surface]') as HTMLElement).style.pointerEvents,
    ).toBe('none');

    fireEvent.keyDown(container.querySelector('.ProseMirror') as HTMLElement, { key: 'Escape' });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      elementIds: ['text-1'],
      primaryId: 'text-1',
    });
  });

  it('keeps other elements selectable while ProseMirror is editing', () => {
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
        onTextContentChange={vi.fn()}
      />,
    );

    const editor = container.querySelector('[data-renderer-text-editor]') as HTMLElement;
    expect(editor.style.cursor).toBe('text');
    expect(editor.style.userSelect).toBe('text');
    expect(container.querySelector('[data-select-element-id="text-1"]')).toBeNull();
    expect(container.querySelector('[data-select-element-id="text-2"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-element-id]')).toHaveLength(1);
    expect(container.querySelector('[data-element-id="text-1"]')).not.toBeNull();
    expect(container.querySelector('[data-hit-kind="blocker"]')).not.toBeNull();
  });

  it('switches to another text element in one click while editing', () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' }}
        onSelectionChange={onSelectionChange}
        onElementsChange={vi.fn()}
        onTextContentChange={vi.fn()}
      />,
    );
    const other = container.querySelector('[data-select-element-id="text-2"]') as HTMLElement;

    fireEvent.pointerDown(other, { pointerId: 1, clientX: 10, clientY: 150 });
    fireEvent.pointerUp(other, { pointerId: 1, clientX: 10, clientY: 150 });

    expect(onSelectionChange).toHaveBeenLastCalledWith({
      elementIds: ['text-2'],
      primaryId: 'text-2',
      editingId: 'text-2',
    });
  });

  it('clears editing selection when the blank canvas is pressed', () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' }}
        onSelectionChange={onSelectionChange}
        onElementsChange={vi.fn()}
        onTextContentChange={vi.fn()}
      />,
    );

    fireEvent.pointerDown(container.querySelector('[data-editable-slide-canvas]') as HTMLElement, {
      button: 0,
      pointerId: 1,
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ elementIds: [] });
  });

  it('deletes semantically empty text without recording an intermediate empty-content edit', () => {
    let controller: TextEditorController | null = null;
    const onElementsChange = vi.fn();
    const onSelectionChange = vi.fn();
    const onTextContentChange = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' }}
        onSelectionChange={onSelectionChange}
        onElementsChange={onElementsChange}
        onTextContentChange={onTextContentChange}
        onTextEditorChange={(next) => {
          controller = next;
        }}
      />,
    );

    act(() => controller?.execute({ command: 'replace', value: '' }));
    fireEvent.keyDown(container.querySelector('.ProseMirror') as HTMLElement, { key: 'Escape' });

    expect(onElementsChange).toHaveBeenLastCalledWith([
      { type: 'element.delete', ids: ['text-1'] },
    ]);
    expect(onTextContentChange).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenLastCalledWith({ elementIds: [] });
  });
});
