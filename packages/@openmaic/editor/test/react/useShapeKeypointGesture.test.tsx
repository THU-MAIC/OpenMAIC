// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { ShapePathFormulasKeys, type PPTShapeElement } from '@openmaic/dsl';
import type { EditIntent } from '../../src/react/types';
import { useShapeKeypointGesture } from '../../src/react/useShapeKeypointGesture';

const shape: PPTShapeElement = {
  id: 'shape-1',
  type: 'shape',
  left: 100,
  top: 100,
  width: 200,
  height: 100,
  rotate: 0,
  viewBox: [200, 100],
  path: 'old',
  pathFormula: ShapePathFormulasKeys.ROUND_RECT,
  keypoints: [0.25],
  fill: '#fff',
  fixedRatio: false,
};

const formulas = {
  [ShapePathFormulasKeys.ROUND_RECT]: {
    editable: true,
    range: [[0, 0.5]] as const,
    relative: ['left'] as const,
    getBaseSize: [(width: number, height: number) => Math.min(width, height)],
    formula: (width: number, height: number, values?: readonly number[]) =>
      `M ${width} ${height} ${values?.[0]}`,
  },
};

function Harness({ onElementsChange }: { onElementsChange: (intents: EditIntent[]) => void }) {
  const { shapeKeypointDrag, onShapeKeypointPointerDown } = useShapeKeypointGesture({
    scale: 2,
    shapePathFormulas: formulas,
    onElementsChange,
  });

  return (
    <>
      <button
        type="button"
        data-keypoint-trigger=""
        onPointerDown={(event) => onShapeKeypointPointerDown(shape, 0, event)}
      />
      {shapeKeypointDrag && <output data-preview={JSON.stringify(shapeKeypointDrag.props)} />}
    </>
  );
}

describe('useShapeKeypointGesture', () => {
  it('previews a clamped formula keypoint and commits one shape update on pointer-up', () => {
    const onElementsChange = vi.fn<(intents: EditIntent[]) => void>();
    const { container } = render(<Harness onElementsChange={onElementsChange} />);
    const trigger = container.querySelector('[data-keypoint-trigger]') as HTMLButtonElement;

    fireEvent.pointerDown(trigger, { pointerId: 1, clientX: 100, clientY: 100 });
    // 100 screen px / scale 2 = 50 canvas px. Base size is 100, so 0.25 -> 0.75,
    // then the formula range clamps it to 0.5.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 100 });

    expect(container.querySelector('output')?.getAttribute('data-preview')).toBe(
      JSON.stringify({ keypoints: [0.5], path: 'M 200 100 0.5' }),
    );

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 100 });

    expect(onElementsChange).toHaveBeenCalledTimes(1);
    expect(onElementsChange).toHaveBeenCalledWith([
      {
        type: 'element.update',
        id: 'shape-1',
        props: { keypoints: [0.5], path: 'M 200 100 0.5' },
      },
    ]);
  });
});
