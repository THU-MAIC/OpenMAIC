// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
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
}: {
  onElementsChange: (intents: EditIntent[]) => void;
}) {
  const [selection, setSelection] = useState<Selection>({
    elementIds: ['shape-1'],
    primaryId: 'shape-1',
    editingId: 'shape-1',
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
  it('enters a Shape label editor only after a double click', () => {
    const { container } = render(<Harness />);
    const target = container.querySelector('[data-select-element-id="shape-1"]') as HTMLElement;

    expect(container.querySelector('[data-renderer-shape-label-editor="shape-1"]')).toBeNull();
    fireEvent.doubleClick(target);
    expect(container.querySelector('[data-renderer-shape-label-editor="shape-1"]')).not.toBeNull();
  });

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
