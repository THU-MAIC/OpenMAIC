import type { CSSProperties } from 'react';
import type { TableCell, TableCellStyle } from '@/lib/types/slides';

/**
 * Convert TableCellStyle to CSS properties
 */
export function getTextStyle(style?: TableCellStyle): CSSProperties {
  if (!style) return {};

  const css: CSSProperties = {};

  if (style.bold) css.fontWeight = 'bold';
  if (style.em) css.fontStyle = 'italic';
  if (style.underline) css.textDecoration = 'underline';
  if (style.strikethrough) {
    css.textDecoration = css.textDecoration ? `${css.textDecoration} line-through` : 'line-through';
  }
  if (style.color) css.color = style.color;
  if (style.backcolor) css.backgroundColor = style.backcolor;
  if (style.fontsize) css.fontSize = style.fontsize;
  if (style.fontname) css.fontFamily = style.fontname;
  if (style.align) css.textAlign = style.align;

  return css;
}

/**
 * Format text: convert \n to <br/> and spaces to &nbsp;
 */
export function formatText(text: string): string {
  return text.replace(/\n/g, '<br/>').replace(/ /g, '&nbsp;');
}

/**
 * Compute hidden cell positions based on colspan/rowspan merges.
 * Returns a Set of "row_col" keys for cells that should be hidden.
 */
export function getHiddenCells(data: TableCell[][]): Set<string> {
  const hidden = new Set<string>();

  for (let rowIdx = 0; rowIdx < data.length; rowIdx++) {
    let realColIdx = 0;
    for (let colIdx = 0; colIdx < data[rowIdx].length; colIdx++) {
      // Skip positions already occupied by a previous merge
      while (hidden.has(`${rowIdx}_${realColIdx}`)) {
        realColIdx++;
      }

      const cell = data[rowIdx][colIdx];
      const colspan = cell.colspan ?? 1;
      const rowspan = cell.rowspan ?? 1;

      if (colspan > 1 || rowspan > 1) {
        for (let r = 0; r < rowspan; r++) {
          for (let c = 0; c < colspan; c++) {
            if (r === 0 && c === 0) continue;
            hidden.add(`${rowIdx + r}_${realColIdx + c}`);
          }
        }
      }

      realColIdx += colspan;
    }
  }

  return hidden;
}
