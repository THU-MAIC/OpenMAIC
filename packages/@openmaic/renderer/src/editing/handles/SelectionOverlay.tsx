import type { PPTElement } from '@openmaic/dsl';
import type { Selection } from '../types';
import { getElementRange } from '../../utils/element';
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
        // Line elements have no box-model `width`/`height`/`rotate`; a line is
        // selectable but not yet movable (line editing is deferred). Derive its
        // bounding box from getElementRange and render an unrotated border.
        if (el.type === 'line') {
          const { minX, maxX, minY, maxY } = getElementRange(el);
          return (
            <BorderLine
              key={el.id}
              width={(maxX - minX) * scale}
              height={(maxY - minY) * scale}
              style={{
                left: `${minX * scale}px`,
                top: `${minY * scale}px`,
                pointerEvents: 'none',
              }}
            />
          );
        }
        // Non-line elements are narrowed here, so `width`/`height`/`rotate` are
        // directly available (no casts).
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
