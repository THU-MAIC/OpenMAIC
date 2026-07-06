// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { EditableSlideCanvas } from '../../src/editing/EditableSlideCanvas';

const slide = { id: 's', viewportSize: 1000, viewportRatio: 0.5625, elements: [
  { id: 'a', type: 'text', left: 100, top: 100, width: 200, height: 80, rotate: 0, content: 'x', defaultFontName: 'a', defaultColor: '#000', lineHeight: 1 },
] } as any;

function findHit(container: HTMLElement) {
  return container.querySelector('[data-element-id="a"]') as HTMLElement;
}

describe('EditableSlideCanvas', () => {
  it('a click (no move) emits onSelectionChange only', () => {
    const onSel = vi.fn(); const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas slide={slide} scale={1} selection={{ elementIds: [] }}
        onSelectionChange={onSel} onElementsChange={onCh} />);
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(hit, { clientX: 0, clientY: 0 });
    expect(onSel).toHaveBeenCalledWith(expect.objectContaining({ elementIds: ['a'], primaryId: 'a' }));
    expect(onCh).not.toHaveBeenCalled();
  });

  it('a drag emits exactly one element.update intent on pointer-up', () => {
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas slide={slide} scale={1} selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()} onElementsChange={onCh} snapping={false} />);
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit, { clientX: 30, clientY: 20 });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh).toHaveBeenCalledWith([{ type: 'element.update', id: 'a', props: { left: 130, top: 120 } }]);
  });
});
