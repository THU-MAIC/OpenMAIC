// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { EditorView } from 'prosemirror-view';
import type { PPTShapeElement, Slide } from '@openmaic/dsl';
import type { EditIntent, Selection } from '../../src/react/types';
import { EditableSlideCanvas } from '../../src/react/EditableSlideCanvas';

const shape: PPTShapeElement = {
  id: 'shape-1',
  type: 'shape',
  left: 100,
  top: 100,
  width: 220,
  height: 120,
  rotate: 0,
  viewBox: [220, 120],
  path: 'M 0 0 L 220 0 L 220 120 L 0 120 Z',
  fill: '#dbeafe',
  fixedRatio: false,
  text: {
    content: '<p>Shape label</p>',
    align: 'middle',
    defaultFontName: 'Inter',
    defaultColor: '#111827',
  },
};

const slide = {
  id: 'slide-1',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  elements: [shape],
} as unknown as Slide;

function Harness() {
  const [selection, setSelection] = useState<Selection>({
    elementIds: ['shape-1'],
    primaryId: 'shape-1',
  });
  return (
    <EditableSlideCanvas
      slide={slide}
      scale={1}
      selection={selection}
      onSelectionChange={setSelection}
      onElementsChange={vi.fn()}
      onTextContentChange={vi.fn()}
    />
  );
}

function EmptyLabelHarness({
  onElementsChange,
  editing = true,
}: {
  onElementsChange: (intents: EditIntent[]) => void;
  editing?: boolean;
}) {
  const [selection, setSelection] = useState<Selection>({
    elementIds: ['shape-1'],
    primaryId: 'shape-1',
    editingId: editing ? 'shape-1' : undefined,
  });
  return (
    <EditableSlideCanvas
      slide={{
        ...slide,
        elements: [{ ...shape, text: { ...shape.text!, content: '<p></p>' } }],
      }}
      scale={1}
      selection={selection}
      onSelectionChange={setSelection}
      onElementsChange={onElementsChange}
      onTextContentChange={vi.fn()}
    />
  );
}

describe('EditableSlideCanvas — Shape label editing', () => {
  it('enters a non-empty Shape label editor after a click', () => {
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue({ pos: 1, inside: -1 });
    const { container } = render(<Harness />);
    const target = container.querySelector('[data-select-element-id="shape-1"]') as HTMLElement;

    expect(container.querySelector('[data-renderer-shape-label-editor="shape-1"]')).toBeNull();
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 130, clientY: 130 });
    fireEvent.pointerUp(target, { button: 0, pointerId: 1, clientX: 130, clientY: 130 });
    expect(container.querySelector('[data-renderer-shape-label-editor="shape-1"]')).not.toBeNull();
  });

  it('does not leave the marquee capture surface above an editing Shape label', () => {
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue({ pos: 1, inside: -1 });
    const { container } = render(<Harness />);
    const target = container.querySelector('[data-select-element-id="shape-1"]') as HTMLElement;

    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 130, clientY: 130 });
    fireEvent.pointerUp(target, { button: 0, pointerId: 1, clientX: 130, clientY: 130 });

    expect(
      (container.querySelector('[data-marquee-surface]') as HTMLElement).style.pointerEvents,
    ).toBe('none');
  });

  it('exits Shape label editing when the blank canvas is pressed', () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['shape-1'], primaryId: 'shape-1', editingId: 'shape-1' }}
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

  it('places the Shape label caret at the clicked position when entering edit mode', () => {
    const posAtCoords = vi
      .spyOn(EditorView.prototype, 'posAtCoords')
      .mockReturnValue({ pos: 4, inside: 1 });
    const { container } = render(<Harness />);
    const target = container.querySelector('[data-select-element-id="shape-1"]') as HTMLElement;

    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 180, clientY: 125 });
    fireEvent.pointerUp(target, { button: 0, pointerId: 1, clientX: 180, clientY: 125 });

    expect(posAtCoords).toHaveBeenCalledWith({ left: 180, top: 125 });
  });

  it('keeps an empty Shape label out of editing after a click', () => {
    const { container } = render(<EmptyLabelHarness editing={false} onElementsChange={vi.fn()} />);
    const target = container.querySelector('[data-select-element-id="shape-1"]') as HTMLElement;

    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 130, clientY: 130 });
    fireEvent.pointerUp(target, { button: 0, pointerId: 1, clientX: 130, clientY: 130 });

    expect(container.querySelector('[data-renderer-shape-label-editor="shape-1"]')).toBeNull();
  });

  it('uses the renderer prose spacing rules while editing a Shape label', () => {
    const { container } = render(<Harness />);
    const target = container.querySelector('[data-select-element-id="shape-1"]') as HTMLElement;

    fireEvent.doubleClick(target);

    const editor = container.querySelector(
      '[data-renderer-shape-label-editor="shape-1"]',
    ) as HTMLElement;
    expect(editor).toHaveClass('slide-renderer-prose');
    expect(editor.style.getPropertyValue('--paragraphSpace')).toBe('5px');
    expect(editor.style.padding).toBe('10px');
    expect(editor.style.lineHeight).toBe('1.625');
    expect(editor.style.boxSizing).toBe('border-box');
  });

  it('keeps the recovered shape label editor inside a full-height text box', () => {
    const { container } = render(
      <EditableSlideCanvas
        slide={{ ...slide, elements: [{ ...shape, path: 'M0 0 Z1 1' }] }}
        scale={1}
        selection={{ elementIds: ['shape-1'], primaryId: 'shape-1', editingId: 'shape-1' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
        onTextContentChange={vi.fn()}
      />,
    );
    const editor = container.querySelector('[data-renderer-shape-label-editor]') as HTMLElement;
    const content = editor.closest('.element-content') as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.style.height).toBe('100%');
    expect(editor.style.inset).toBe('0px');
  });

  it.each([{ flipH: true }, { flipV: true }, { flipH: true, flipV: true }])(
    'keeps a recovered label upright while editing a flipped shape: %o',
    (flip) => {
      const props = {
        scale: 1,
        selection: { elementIds: ['shape-1'], primaryId: 'shape-1', editingId: 'shape-1' },
        onSelectionChange: vi.fn(),
        onElementsChange: vi.fn(),
        onTextContentChange: vi.fn(),
      };
      const { container, rerender } = render(
        <EditableSlideCanvas
          {...props}
          slide={{ ...slide, elements: [{ ...shape, ...flip, path: 'M0 0 Z1 1' }] }}
        />,
      );
      const editor = container.querySelector('[data-renderer-shape-label-editor]') as HTMLElement;
      expect(editor.closest('.base-element-text')).not.toBeNull();
      expect(editor.style.transform).toBe('');

      rerender(
        <EditableSlideCanvas {...props} slide={{ ...slide, elements: [{ ...shape, ...flip }] }} />,
      );
      const validEditor = container.querySelector(
        '[data-renderer-shape-label-editor]',
      ) as HTMLElement;
      const shapeContent = validEditor.closest('.element-content') as HTMLElement;
      expect(shapeContent.closest('.base-element-shape')).not.toBeNull();
      expect(validEditor.style.transform).not.toBe('');
      expect(validEditor.style.transform).toBe(shapeContent.style.transform);
    },
  );

  it('aligns a recovered shape hit target and selection border with its visible text box', () => {
    const recovered = {
      ...shape,
      path: 'M0 0 Z1 1',
      left: Number.NaN,
      top: Number.POSITIVE_INFINITY,
      width: 0,
      height: Number.NaN,
    };
    const onSelectionChange = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={{ ...slide, elements: [recovered] }}
        scale={1}
        selection={{ elementIds: ['shape-1'], primaryId: 'shape-1' }}
        onSelectionChange={onSelectionChange}
        onElementsChange={vi.fn()}
        onTextContentChange={vi.fn()}
      />,
    );
    const visible = container.querySelector('.base-element-text') as HTMLElement;
    const target = container.querySelector('[data-select-element-id="shape-1"]') as HTMLElement;
    const border = container.querySelector('[data-selection-border]') as HTMLElement;

    expect(visible.style.left).toBe('0px');
    expect(visible.style.top).toBe('0px');
    expect(visible.style.width).toBe('100px');
    expect(visible.style.height).toBe('100px');
    for (const overlay of [target, border]) {
      expect(overlay.style.left).toBe(visible.style.left);
      expect(overlay.style.top).toBe(visible.style.top);
      expect(overlay.style.width).toBe(visible.style.width);
      expect(overlay.style.height).toBe(visible.style.height);
    }

    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerUp(target, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
    expect(onSelectionChange).toHaveBeenCalledWith({
      elementIds: ['shape-1'],
      primaryId: 'shape-1',
      editingId: 'shape-1',
    });
  });

  it('moves a recovered text box from its projected position without changing stored geometry', () => {
    const onElementsChange = vi.fn();
    const recovered = { ...shape, left: Number.NaN, top: Number.NaN, width: 0 };
    const { container } = render(
      <EditableSlideCanvas
        slide={{ ...slide, elements: [recovered] }}
        scale={1}
        snapping={false}
        selection={{ elementIds: ['shape-1'], primaryId: 'shape-1' }}
        onSelectionChange={vi.fn()}
        onElementsChange={onElementsChange}
      />,
    );
    expect(container.querySelector('[data-shape-geometry-error]')).not.toBeNull();
    const move = container.querySelector('[data-element-id="shape-1"]') as HTMLElement;
    fireEvent.pointerDown(move, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 30, clientY: 25 });
    expect(container.querySelector('[data-shape-geometry-error]')).not.toBeNull();
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 30, clientY: 25 });
    expect(onElementsChange).toHaveBeenLastCalledWith([
      { type: 'element.update', id: 'shape-1', props: { left: 20, top: 15 } },
    ]);
  });

  it.each([undefined, '<p>&#32;&ensp;</p>', '<!-- <img src="unused.png"> -->'])(
    'does not expose a hit target for a malformed shape with no usable label: %s',
    (content) => {
      const { container } = render(
        <EditableSlideCanvas
          slide={{
            ...slide,
            elements: [
              {
                ...shape,
                path: 'M0 0 Z1 1',
                text: content === undefined ? undefined : { ...shape.text!, content },
              },
            ],
          }}
          scale={1}
          selection={{ elementIds: ['shape-1'], primaryId: 'shape-1' }}
          onSelectionChange={vi.fn()}
          onElementsChange={vi.fn()}
        />,
      );
      expect(container.querySelector('[data-select-element-id="shape-1"]')).toBeNull();
      expect(container.querySelector('[data-selection-border]')).toBeNull();
    },
  );

  it('removes an empty Shape label when its editor blurs', () => {
    const onElementsChange = vi.fn<(intents: EditIntent[]) => void>();
    const { container } = render(<EmptyLabelHarness onElementsChange={onElementsChange} />);
    const editor = container.querySelector('.ProseMirror') as HTMLElement;

    fireEvent.blur(editor);

    expect(onElementsChange).toHaveBeenCalledWith([
      { type: 'element.removeProps', id: 'shape-1', props: ['text'] },
    ]);
  });

  it('exits Shape label editing when Escape is pressed', () => {
    const { container } = render(<Harness />);
    const target = container.querySelector('[data-select-element-id="shape-1"]') as HTMLElement;
    fireEvent.doubleClick(target);
    const editor = container.querySelector('.ProseMirror') as HTMLElement;

    fireEvent.keyDown(editor, { key: 'Escape' });

    expect(container.querySelector('[data-renderer-shape-label-editor="shape-1"]')).toBeNull();
  });
});
