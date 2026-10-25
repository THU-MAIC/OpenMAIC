import type { Whiteboard } from '@openmaic/dsl';
import { proseToPlainText } from '@/lib/export/pptx-rich-text';

/**
 * Extracts all text and code content from a whiteboard in board order.
 *
 * - Text elements (`type: 'text'`): rich-text HTML is converted to plain text,
 *   preserving meaningful line breaks (<p>, <br>, <li>) and decoding HTML entities.
 * - Code elements (`type: 'code'`): lines are joined with newlines, preserving indentation
 *   and code formatting while excluding line numbers, filenames, and UI decorations.
 * - Non-text elements (shapes, images, lines, etc.) and UI controls are excluded.
 * - Distinct board elements are separated by blank lines (`\n\n`).
 * - Returns an empty string if there is no text or code content.
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
    }
  }

  return sections.join('\n\n');
}
