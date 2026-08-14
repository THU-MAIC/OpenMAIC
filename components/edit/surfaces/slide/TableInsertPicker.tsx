'use client';

import { useState } from 'react';

const MAX_ROWS = 6;
const MAX_COLUMNS = 8;

interface TableInsertPickerProps {
  readonly onPick: (rows: number, columns: number) => void;
  readonly getLabel: (rows: number, columns: number) => string;
}

/** Grid picker for choosing a new table's row and column count. */
export function TableInsertPicker({ onPick, getLabel }: TableInsertPickerProps) {
  const [size, setSize] = useState({ rows: 1, columns: 1 });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-8 gap-1" role="grid">
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
                className={
                  active
                    ? 'aspect-square rounded-sm border border-violet-500 bg-violet-500'
                    : 'aspect-square rounded-sm border border-zinc-300 bg-white hover:border-violet-400 hover:bg-violet-100 dark:border-zinc-600 dark:bg-zinc-800 dark:hover:border-violet-400 dark:hover:bg-violet-500/20'
                }
              />
            );
          }),
        )}
      </div>
      <div
        data-testid="table-insert-dimensions"
        className="text-center text-sm font-medium text-zinc-700 dark:text-zinc-200"
      >
        {getLabel(size.rows, size.columns)}
      </div>
    </div>
  );
}
