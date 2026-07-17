'use client';

import { useMemo } from 'react';
import type { PPTTableElement } from '@openmaic/dsl';
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
  const { width, data, colWidths, rowHeights, cellMinHeight, outline, theme } = elementInfo;
  const tableData = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const tableColWidths = useMemo(() => (Array.isArray(colWidths) ? colWidths : []), [colWidths]);
  const tableRowHeights = useMemo(
    () => (Array.isArray(rowHeights) ? rowHeights : []),
    [rowHeights],
  );
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeCellMinHeight =
    Number.isFinite(cellMinHeight) && cellMinHeight >= 0 ? cellMinHeight : 40;

  const hiddenCells = useMemo(() => getHiddenCells(tableData), [tableData]);

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

    const rowCount = tableData.length;
    const colCount = tableData[0]?.length ?? 0;

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
    const rowCount = tableData.length;
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
        {tableColWidths.map((w, i) => (
          <col key={i} style={{ width: `${(Number.isFinite(w) ? w : 1) * safeWidth}px` }} />
        ))}
      </colgroup>
      <tbody>
        {tableData.map((row, rowIdx) => (
          <tr
            key={rowIdx}
            style={{
              height: `${Number.isFinite(tableRowHeights[rowIdx]) ? tableRowHeights[rowIdx] : safeCellMinHeight}px`,
            }}
          >
            {(Array.isArray(row) ? row : []).map((cell, colIdx) => {
              if (hiddenCells.has(`${rowIdx}_${colIdx}`)) return null;
              if (!cell) return null;

              const bgColor = getCellBg(rowIdx, colIdx, cell.style?.backcolor);
              const headerColor = getHeaderTextColor(rowIdx);
              const textStyle = getTextStyle(cell.style);
              const colspan = Number.isFinite(cell.colspan) && cell.colspan > 0 ? cell.colspan : 1;
              const rowspan = Number.isFinite(cell.rowspan) && cell.rowspan > 0 ? cell.rowspan : 1;

              // Header text color should be overridden only if cell doesn't have its own color
              if (headerColor && !cell.style?.color) {
                textStyle.color = headerColor;
              }

              return (
                <td
                  key={cell.id || `${rowIdx}-${colIdx}`}
                  colSpan={colspan > 1 ? colspan : undefined}
                  rowSpan={rowspan > 1 ? rowspan : undefined}
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
