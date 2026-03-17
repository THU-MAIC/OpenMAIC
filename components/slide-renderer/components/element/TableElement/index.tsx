'use client';

import type { PPTTableElement } from '@/lib/types/slides';
import { StaticTable } from './StaticTable';

export { BaseTableElement } from './BaseTableElement';

export interface TableElementProps {
  elementInfo: PPTTableElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTTableElement) => void;
}

/**
 * Editable table element component.
 * Supports selection/drag/resize via selectElement callback.
 * Cell editing is not implemented yet (display-only, matching ChartElement pattern).
 */
export function TableElement({ elementInfo, selectElement }: TableElementProps) {
  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  return (
    <div
      className={`editable-element-table absolute ${elementInfo.lock ? 'lock' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className={`element-content relative w-full h-full overflow-hidden ${
            elementInfo.lock ? 'cursor-default' : 'cursor-move'
          }`}
          onMouseDown={handleSelectElement}
          onTouchStart={handleSelectElement}
        >
          <StaticTable elementInfo={elementInfo} />
        </div>
      </div>
    </div>
  );
}
