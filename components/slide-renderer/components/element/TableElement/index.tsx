'use client';

import React, { useState, useRef } from 'react';
import type { PPTTableElement } from '@/lib/types/slides';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { StaticTable } from './StaticTable';

export { BaseTableElement } from './BaseTableElement';

export interface TableElementProps {
  elementInfo: PPTTableElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTTableElement) => void;
}

/**
 * Editable table element component.
 * Supports selection/drag/resize via selectElement callback.
 * Double-click a cell to edit its text content inline.
 */
export function TableElement({ elementInfo, selectElement }: TableElementProps) {
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; colIdx: number } | null>(null);
  const pendingTextRef = useRef<string | null>(null);

  const { updateElement } = useCanvasOperations();
  const { addHistorySnapshot } = useHistorySnapshot();

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    if (editingCell) return; // Don't select/drag while editing
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  const handleCellDblClick = (rowIdx: number, colIdx: number) => {
    if (elementInfo.lock) return;
    pendingTextRef.current = null;
    setEditingCell({ rowIdx, colIdx });
  };

  const handleCellChange = (_rowIdx: number, _colIdx: number, text: string) => {
    pendingTextRef.current = text;
  };

  const handleCellBlur = () => {
    if (!editingCell) return;
    const { rowIdx, colIdx } = editingCell;
    const newText = pendingTextRef.current;
    setEditingCell(null);
    pendingTextRef.current = null;

    if (newText === null) return; // No changes

    const currentText = elementInfo.data[rowIdx]?.[colIdx]?.text;
    if (newText === currentText) return; // No actual change

    const newData = elementInfo.data.map((row, rIdx) =>
      row.map((cell, cIdx) => {
        if (rIdx === rowIdx && cIdx === colIdx) {
          return { ...cell, text: newText };
        }
        return cell;
      }),
    );

    updateElement({
      id: elementInfo.id,
      props: { data: newData } as Partial<PPTTableElement>,
    });
    addHistorySnapshot();
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
          <StaticTable
            elementInfo={elementInfo}
            editingCell={editingCell}
            onCellDblClick={handleCellDblClick}
            onCellChange={handleCellChange}
            onCellBlur={handleCellBlur}
          />
        </div>
      </div>
    </div>
  );
}
