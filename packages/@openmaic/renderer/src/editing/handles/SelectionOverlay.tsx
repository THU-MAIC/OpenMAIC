import type { PPTElement } from '@openmaic/dsl';
import type { Selection } from '../types';
import { BorderLine } from './BorderLine';

export interface SelectionOverlayProps {
  elements: PPTElement[];
  selection: Selection;
  scale: number;
}

/**
 * Presentational selection overlay. Props-driven only: resolves
 * `selection.elementIds` against `elements` and renders a scaled,
 * rotated `BorderLine` for each match. Renders `null` when the selection
 * resolves to no elements (nothing selected, or ids not found).
 */
export function SelectionOverlay({ elements, selection, scale }: SelectionOverlayProps) {
  const selected = selection.elementIds
    .map((id) => elements.find((el) => el.id === id))
    .filter((el): el is PPTElement => el != null);

  if (selected.length === 0) return null;

  return (
    <>
      {selected.map((el) => {
        // Line elements (`PPTLineElement`) omit `height`/`rotate` from the
        // base geometry (their bounds derive from start/end points instead);
        // fall back to 0 for them rather than widening `PPTElement`.
        const height = 'height' in el ? el.height : 0;
        const rotate = 'rotate' in el ? el.rotate : 0;
        return (
          <BorderLine
            key={el.id}
            width={el.width * scale}
            height={height * scale}
            style={{
              left: `${el.left * scale}px`,
              top: `${el.top * scale}px`,
              transform: `rotate(${rotate}deg)`,
              transformOrigin: 'center',
              pointerEvents: 'none',
            }}
          />
        );
      })}
    </>
  );
}
