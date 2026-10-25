import type { Whiteboard } from '@openmaic/dsl';
import { proseToPlainText } from '@/lib/export/pptx-rich-text';

/**
 * Extracts all text, code, and table cell content from a whiteboard in board order.
 *
 * - Text elements (`type: 'text'`): rich-text HTML is converted to plain text,
 *   preserving meaningful line breaks (<p>, <br>, <li>) and decoding HTML entities.
 * - Code elements (`type: 'code'`): lines are joined with newlines, preserving indentation
 *   and code formatting while excluding line numbers, filenames, and UI decorations.
 * - Table elements (`type: 'table'`): cells in `data` are flattened and decoded in row order.
 * - Non-text elements (shapes, images, lines, etc.) and UI controls are excluded.
 * - Distinct board elements are separated by blank lines (`\n\n`).
 * - Returns an empty string if there is no text, code, or table content.
 */
export function extractWhiteboardText(whiteboard?: Whiteboard | null): string {
  if (!whiteboard || !Array.isArray(whiteboard.elements) || whiteboard.elements.length === 0) {
    return '';
  }

  const sections: string[] = [];

  for (const element of whiteboard.elements) {
    if (!element || typeof element !== 'object') continue;

    if (element.type === 'text') {
      const content = typeof element.content === 'string' ? element.content : '';
      const text = proseToPlainText(content).trim();
      if (text.length > 0) {
        sections.push(text);
      }
    } else if (element.type === 'code') {
      const lines = Array.isArray(element.lines) ? element.lines : [];
      const code = lines
        .map((line) => (line && typeof line.content === 'string' ? line.content : ''))
        .join('\n')
        .replace(/^\n+|\n+$/g, '');
      if (code.trim().length > 0) {
        sections.push(code);
      }
    } else if (element.type === 'table') {
      const data = Array.isArray(element.data) ? element.data : [];
      const cells: string[] = [];
      const flatCells = data.flat();
      for (const cell of flatCells) {
        if (!cell || typeof cell !== 'object') continue;
        const text = typeof cell.text === 'string' ? proseToPlainText(cell.text).trim() : '';
        if (text.length > 0) {
          cells.push(text);
        }
      }
      if (cells.length > 0) {
        sections.push(cells.join('\n'));
      }
    }
  }

  return sections.join('\n\n');
}
