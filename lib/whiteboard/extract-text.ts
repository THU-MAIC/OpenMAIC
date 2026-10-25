import type { Whiteboard } from '@openmaic/dsl';
import { decodeHtmlEntities, proseToPlainText } from '@/lib/export/pptx-rich-text';

/**
 * HTML markup detector matching the renderer's preservesPlainTextLineBreaks contract:
 * only markup-free values use white-space: pre-line.
 */
const HTML_MARKUP_PATTERN = /<\/?[a-z][^>]*>|<![^>]*>/i;

const BLOCK_TAGS_PATTERN =
  '(?:p|div|li|ul|ol|h[1-6]|blockquote|pre|table|tbody|thead|tfoot|tr|td|th|section|article|header|footer|nav|aside|figure|figcaption)';

const BLOCK_CONTAINERS_PATTERN =
  '(?:div|ul|ol|table|tbody|thead|tfoot|tr|section|article|header|footer|nav|aside|figure)';

/**
 * Removes formatting whitespace between rich-text blocks in HTML strings (e.g. `<p>A</p>\n<p>B</p>`),
 * while preserving meaningful text, inline spacing (e.g. `<span>A</span> <span>B</span>`),
 * and intentional newlines in plain-text content.
 */
function cleanRichTextWhitespace(html: string): string {
  if (!HTML_MARKUP_PATTERN.test(html)) {
    return html;
  }
  return html
    .replace(
      new RegExp(`(</${BLOCK_TAGS_PATTERN}>)\\s+(<${BLOCK_TAGS_PATTERN}(?:\\s[^>]*)?>)`, 'gi'),
      '$1$2',
    )
    .replace(
      new RegExp(
        `(<${BLOCK_CONTAINERS_PATTERN}(?:\\s[^>]*)?>)\\s+(<${BLOCK_TAGS_PATTERN}(?:\\s[^>]*)?>)`,
        'gi',
      ),
      '$1$2',
    )
    .replace(
      new RegExp(`(</${BLOCK_TAGS_PATTERN}>)\\s+(</${BLOCK_CONTAINERS_PATTERN}>)`, 'gi'),
      '$1$2',
    )
    .replace(new RegExp(`^\\s+(<${BLOCK_TAGS_PATTERN}(?:\\s[^>]*)?>)`, 'i'), '$1')
    .replace(new RegExp(`(</${BLOCK_TAGS_PATTERN}>)\\s+$`, 'i'), '$1');
}

function extractProseText(content: string): string {
  const cleaned = cleanRichTextWhitespace(content);
  return proseToPlainText(cleaned).trim();
}

/**
 * Extracts all text, code, table cell, labeled shape, chart text, and standalone formula content
 * from a whiteboard in board order.
 *
 * - Text elements (`type: 'text'`): rich-text HTML is converted to plain text,
 *   ignoring formatting whitespace between rich-text blocks while preserving
 *   meaningful line breaks (<p>, <br>, <li>), inline spacing, and intentional
 *   newlines in plain-text content.
 * - Code elements (`type: 'code'`): lines are joined with newlines, preserving indentation
 *   and code formatting while excluding line numbers, filenames, and UI decorations.
 * - Table elements (`type: 'table'`): cells in `data` are flattened and decoded in row order.
 * - Shape elements (`type: 'shape'`): meaningful text labels in `text.content` are converted to plain text.
 * - Chart elements (`type: 'chart'`): literal text from `data.labels` (axis/indicator labels)
 *   and `data.legends` (series/legend labels) is preserved as human-readable strings in order,
 *   including markup-like strings and entity sequences.
 * - Formula elements (`type: 'latex'`): stored formula source in `latex` is extracted using
 *   the existing LaTeX/plain-text conventions.
 * - Non-text elements (unlabeled shapes, images, lines, etc.) and UI controls are excluded.
 * - Distinct board elements are separated by blank lines (`\n\n`).
 * - Returns an empty string if there is no extractable content.
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
      const text = extractProseText(content);
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
        const text = typeof cell.text === 'string' ? extractProseText(cell.text) : '';
        if (text.length > 0) {
          cells.push(text);
        }
      }
      if (cells.length > 0) {
        sections.push(cells.join('\n'));
      }
    } else if (element.type === 'shape') {
      const content =
        element.text && typeof element.text === 'object' && typeof element.text.content === 'string'
          ? element.text.content
          : '';
      const text = extractProseText(content);
      if (text.length > 0) {
        sections.push(text);
      }
    } else if (element.type === 'chart') {
      const data = element.data && typeof element.data === 'object' ? element.data : null;
      const chartTexts: string[] = [];
      if (data) {
        if (Array.isArray(data.labels)) {
          for (const label of data.labels) {
            const raw =
              typeof label === 'string' ? label : typeof label === 'number' ? String(label) : '';
            const text = raw.trim();
            if (text.length > 0) {
              chartTexts.push(text);
            }
          }
        }
        if (Array.isArray(data.legends)) {
          for (const legend of data.legends) {
            const raw =
              typeof legend === 'string'
                ? legend
                : typeof legend === 'number'
                  ? String(legend)
                  : '';
            const text = raw.trim();
            if (text.length > 0) {
              chartTexts.push(text);
            }
          }
        }
      }
      if (chartTexts.length > 0) {
        sections.push(chartTexts.join('\n'));
      }
    } else if (element.type === 'latex') {
      const latex =
        typeof element.latex === 'string' ? decodeHtmlEntities(element.latex).trim() : '';
      if (latex.length > 0) {
        sections.push(latex);
      }
    }
  }

  return sections.join('\n\n');
}
