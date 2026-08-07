'use client';

import { useState } from 'react';

const MAX_ROWS = 6;
const MAX_COLUMNS = 8;

export interface TableInsertPickerProps {
  readonly onPick: (rows: number, columns: number) => void;
  readonly getLabel: (rows: number, columns: number) => string;
}

/** Grid picker for choosing the dimensions of a new table. */
export function TableInsertPicker({ onPick, getLabel }: TableInsertPickerProps) {
  const [size, setSize] = useState({ rows: 1, columns: 1 });

  return (
    <div className="maic-editing-ui-table-picker">
      <div className="maic-editing-ui-table-grid" role="grid">
        {Array.from({ length: MAX_ROWS }, (_, rowIndex) =>
          Array.from({ length: MAX_COLUMNS }, (_, columnIndex) => {
            const rows = rowIndex + 1;
            const columns = columnIndex + 1;
            const active = rows <= size.rows && columns <= size.columns;
            const label = getLabel(rows, columns);

            return (
              <button
                key={`${rows}-${columns}`}
                type="button"
                aria-label={label}
                data-table-insert-cell=""
                data-active={active || undefined}
                onMouseEnter={() => setSize({ rows, columns })}
                onFocus={() => setSize({ rows, columns })}
                onClick={() => onPick(rows, columns)}
                className="maic-editing-ui-table-grid-cell"
              />
            );
          }),
        )}
      </div>
      <div data-testid="table-insert-dimensions" className="maic-editing-ui-table-dimensions">
        {getLabel(size.rows, size.columns)}
      </div>
    </div>
  );
}
