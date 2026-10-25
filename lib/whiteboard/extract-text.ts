import type { Whiteboard } from '@openmaic/dsl';
import { decodeHTML } from 'entities';
import { type AST, toAST } from '@/lib/export/html-parser';
import { inlineMathSource } from '@/lib/export/pptx-rich-text';

const HTML_MARKUP_PATTERN = /<\/?[a-z][^>]*>|<!--/i;

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'caption',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const EMPTY_LINE_BLOCK_TAGS = new Set([
  'blockquote',
  'dd',
  'dt',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'p',
  'pre',
  'td',
  'th',
]);

function decodeText(value: string): string {
  return decodeHTML(value).replace(/\u00a0/g, ' ');
}

function normalizeText(value: string, preserveWhitespace: boolean): string {
  const decoded = decodeHTML(value);
  if (preserveWhitespace) {
    return decoded.replace(/\u00a0/g, ' ');
  }
  return decoded.replace(/[ \t\r\n\f]+/g, ' ').replace(/\u00a0/g, ' ');
}

function isBlockElement(item: AST): boolean {
  return item.type === 'element' && BLOCK_TAGS.has(item.tagName);
}

function richTextToPlainText(html: string): string {
  if (!HTML_MARKUP_PATTERN.test(html)) {
    return decodeText(html);
  }

  const lines: string[] = [];
  let line = '';

  const breakLine = () => {
    lines.push(line);
    line = '';
  };

  const appendText = (value: string, preserveWhitespace: boolean) => {
    const [first, ...rest] = normalizeText(value, preserveWhitespace).split('\n');
    line += first;
    for (const next of rest) {
      breakLine();
      line += next;
    }
  };

  const walk = (items: AST[], preserveWhitespace: boolean) => {
    const hasBlockChildren = items.some(isBlockElement);

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.type === 'comment') continue;

      if (item.type === 'text') {
        if (normalizeText(item.content, preserveWhitespace).trim().length === 0) {
          const previousIsBlock = index > 0 && isBlockElement(items[index - 1]);
          const nextIsBlock = index < items.length - 1 && isBlockElement(items[index + 1]);
          if (items.length === 1 || hasBlockChildren || previousIsBlock || nextIsBlock) {
            continue;
          }
        }
        appendText(item.content, preserveWhitespace);
        continue;
      }

      if (item.type !== 'element') continue;

      const mathSource = inlineMathSource(item);
      if (mathSource !== null) {
        line += mathSource;
        continue;
      }

      if (item.tagName === 'br') {
        breakLine();
        continue;
      }

      if (BLOCK_TAGS.has(item.tagName)) {
        if (line.length > 0) breakLine();
        const linesBefore = lines.length;
        const childHasBlock = item.children.some(isBlockElement);
        walk(item.children, preserveWhitespace || item.tagName === 'pre');
        if (line.length > 0) {
          breakLine();
        } else if (
          !childHasBlock &&
          lines.length === linesBefore &&
          EMPTY_LINE_BLOCK_TAGS.has(item.tagName)
        ) {
          lines.push('');
        }
        continue;
      }

      walk(item.children, preserveWhitespace);
    }
  };

  walk(toAST(html), false);
  if (line.length > 0) lines.push(line);
  return lines.join('\n').trim();
}

function extractProseText(content: string): string {
  return richTextToPlainText(content).trim();
}

function chartText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value).trim();
  return '';
}

function chartShowsSeriesValues(
  element: Whiteboard['elements'][number],
  seriesIndex: number,
): boolean {
  if (element.type !== 'chart') return false;
  if (element.chartType === 'line' || element.chartType === 'area') return true;
  if (element.chartType === 'bar' || element.chartType === 'column') {
    return element.importedStyle?.series?.[seriesIndex]?.showValue !== false;
  }
  return false;
}

function extractChartText(element: Whiteboard['elements'][number]): string {
  if (element.type !== 'chart') return '';
  const data = element.data && typeof element.data === 'object' ? element.data : null;
  if (!data) return '';

  const labels = Array.isArray(data.labels) ? data.labels.map(chartText) : [];
  const legends = Array.isArray(data.legends) ? data.legends.map(chartText) : [];
  const series = Array.isArray(data.series) ? data.series : [];
  const texts = [
    ...labels.filter((label) => label.length > 0),
    ...legends.filter((legend) => legend.length > 0),
  ];

  for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
    const values = series[seriesIndex];
    if (!Array.isArray(values) || !chartShowsSeriesValues(element, seriesIndex)) continue;

    const points: string[] = [];
    for (let valueIndex = 0; valueIndex < values.length; valueIndex++) {
      const value = values[valueIndex];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const label = labels[valueIndex] ?? '';
      points.push(label ? `${label} ${String(value)}` : String(value));
    }
    if (points.length === 0) continue;

    const legend = legends[seriesIndex] ?? '';
    texts.push(legend ? `${legend}: ${points.join(', ')}` : points.join(', '));
  }

  return texts.join('\n');
}

/**
 * Extracts all text, code, table cell, labeled shape, chart text, and standalone formula content
 * from a whiteboard in board order.
 *
 * - Text elements (`type: 'text'`): rich-text HTML is converted to plain text,
 *   following the renderer's visible block boundaries, ignoring formatting-only
 *   whitespace between blocks, and decoding standard HTML entities. Plain-text
 *   content keeps its intentional newlines and indentation.
 * - Code elements (`type: 'code'`): lines are joined with newlines, preserving indentation,
 *   code formatting, and intentional leading/trailing blank lines while excluding line
 *   numbers, filenames, and UI decorations.
 * - Table elements (`type: 'table'`): cells in `data` are flattened and decoded in row order.
 * - Shape elements (`type: 'shape'`): meaningful text labels in `text.content` are converted to plain text.
 * - Chart elements (`type: 'chart'`): literal text from `data.labels` (axis/indicator labels)
 *   and `data.legends` (series/legend labels) is preserved as human-readable strings in order,
 *   including markup-like strings and entity sequences. Visible point values are included with
 *   their category and series context for bar, column, line, and area charts.
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
        .join('\n');
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
      const text = extractChartText(element);
      if (text.length > 0) {
        sections.push(text);
      }
    } else if (element.type === 'latex') {
      const latex = typeof element.latex === 'string' ? decodeText(element.latex).trim() : '';
      if (latex.length > 0) {
        sections.push(latex);
      }
    }
  }

  return sections.join('\n\n');
}
