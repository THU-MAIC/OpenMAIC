import type { PPTElement, PPTLineElement } from '@openmaic/dsl';
import type { Selection } from '../types';
import { BorderLine } from './BorderLine';

/** A selectable element that carries a box model (`width`/`height`/`rotate`). */
type PPTBoxElement = Exclude<PPTElement, PPTLineElement>;

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
 *
 * Line elements are intentionally skipped here: a selected line's chrome is its
 * draggable endpoint/control handles (see `LineHandles`), which replace the
 * approximate bbox border a line would otherwise get.
 */
export function SelectionOverlay({ elements, selection, scale }: SelectionOverlayProps) {
  const selected = selection.elementIds
    .map((id) => elements.find((el) => el.id === id))
    .filter((el): el is PPTElement => el != null)
    .filter((el): el is PPTBoxElement => el.type !== 'line');

  if (selected.length === 0) return null;

  return (
    <>
      {selected.map((el) => {
        // Only non-line elements reach here (lines filtered out above), so
        // `width`/`height`/`rotate` are directly available (no casts).
        return (
          <BorderLine
            key={el.id}
            width={el.width * scale}
            height={el.height * scale}
            style={{
              left: `${el.left * scale}px`,
              top: `${el.top * scale}px`,
              transform: `rotate(${el.rotate}deg)`,
              transformOrigin: 'center',
              pointerEvents: 'none',
            }}
          />
        );
      })}
    </>
  );
}
