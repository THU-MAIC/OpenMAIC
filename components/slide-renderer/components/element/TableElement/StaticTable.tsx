'use client';

import { useMemo } from 'react';
import type { PPTTableElement } from '@/lib/types/slides';
import { getTableSubThemeColor } from '@/lib/utils/element';
import { getTextStyle, formatText, getHiddenCells } from './tableUtils';

interface StaticTableProps {
  elementInfo: PPTTableElement;
}

/**
 * Static table rendering component, ported from PPTist StaticTable.vue.
 * Renders table data with theme colors, outline borders, and merged cells.
 */
export function StaticTable({ elementInfo }: StaticTableProps) {
  const { width, data, colWidths, cellMinHeight, outline, theme } = elementInfo;

  const hiddenCells = useMemo(() => getHiddenCells(data), [data]);

  const [subThemeDark, subThemeLight] = useMemo(() => {
    if (!theme) return ['', ''];
    return getTableSubThemeColor(theme.color);
  }, [theme]);

  const borderStyle = useMemo(() => {
    if (!outline) return 'none';
    const w = outline.width ?? 1;
    const c = outline.color ?? '#000';
    const s = outline.style === 'dashed' ? 'dashed' : 'solid';
    return `${w}px ${s} ${c}`;
  }, [outline]);

  /**
   * Get background color for a cell based on theme and position
   */
  const getCellBg = (
    rowIdx: number,
    colIdx: number,
    cellBackcolor?: string,
  ): string | undefined => {
    if (cellBackcolor) return cellBackcolor;
    if (!theme) return undefined;

    const rowCount = data.length;
    const colCount = data[0]?.length ?? 0;

    // Row header (first row) gets theme color
    if (theme.rowHeader && rowIdx === 0) return theme.color;
    // Row footer (last row) gets theme color
    if (theme.rowFooter && rowIdx === rowCount - 1) return theme.color;
    // Col header (first col) gets dark sub-theme
    if (theme.colHeader && colIdx === 0) return subThemeDark;
    // Col footer (last col) gets dark sub-theme
    if (theme.colFooter && colIdx === colCount - 1) return subThemeDark;

    // Alternating row colors (skip header row for counting)
    const effectiveRow = theme.rowHeader ? rowIdx - 1 : rowIdx;
    if (effectiveRow >= 0 && effectiveRow % 2 === 0) return subThemeLight;

    return undefined;
  };

  /**
   * Get text color for header/footer rows (white text on dark bg)
   */
  const getHeaderTextColor = (rowIdx: number): string | undefined => {
    if (!theme) return undefined;
    const rowCount = data.length;
    if (theme.rowHeader && rowIdx === 0) return '#fff';
    if (theme.rowFooter && rowIdx === rowCount - 1) return '#fff';
    return undefined;
  };

  return (
    <table
      className="w-full h-full"
      style={{
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
      }}
    >
      <colgroup>
        {colWidths.map((w, i) => (
          <col key={i} style={{ width: `${w * width}px` }} />
        ))}
      </colgroup>
      <tbody>
        {data.map((row, rowIdx) => (
          <tr key={rowIdx} style={{ height: `${cellMinHeight}px` }}>
            {row.map((cell, colIdx) => {
              if (hiddenCells.has(`${rowIdx}_${colIdx}`)) return null;

              const bgColor = getCellBg(rowIdx, colIdx, cell.style?.backcolor);
              const headerColor = getHeaderTextColor(rowIdx);
              const textStyle = getTextStyle(cell.style);

              // Header text color should be overridden only if cell doesn't have its own color
              if (headerColor && !cell.style?.color) {
                textStyle.color = headerColor;
              }

              return (
                <td
                  key={cell.id}
                  colSpan={cell.colspan > 1 ? cell.colspan : undefined}
                  rowSpan={cell.rowspan > 1 ? cell.rowspan : undefined}
                  style={{
                    border: borderStyle,
                    backgroundColor: bgColor,
                    padding: '5px',
                    verticalAlign: 'middle',
                    wordBreak: 'break-word',
                    ...textStyle,
                  }}
                  dangerouslySetInnerHTML={{ __html: formatText(cell.text) }}
                />
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
