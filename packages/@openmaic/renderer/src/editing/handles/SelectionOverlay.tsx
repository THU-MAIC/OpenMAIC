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
    // Line elements: hit target + selection + endpoint editing land together in
    // the line slice; the box-model drag intent can't represent line moves. We
    // skip them here (rather than a `height`/`rotate` fallback) — which also
    // narrows the type so `width`/`height`/`rotate` are directly available.
    .filter((el): el is Exclude<PPTElement, { type: 'line' }> => el != null && el.type !== 'line');

  if (selected.length === 0) return null;

  return (
    <>
      {selected.map((el) => (
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
      ))}
    </>
  );
}
