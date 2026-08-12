import { describe, expect, test } from 'vitest';
import {
  createDefaultChartElement,
  createDefaultImageElement,
  createDefaultShapeElement,
  createDefaultTableElement,
  createDefaultTextElement,
  htmlToPlainText,
  plainTextToParagraphHtml,
} from '@/lib/edit/slide-edit-elements';

describe('slide edit element factories', () => {
  test('creates default text elements compatible with the slide schema', () => {
    const element = createDefaultTextElement('text-1');

    expect(element).toMatchObject({
      id: 'text-1',
      type: 'text',
      content: '<p>New text</p>',
      defaultFontName: 'Inter',
      defaultColor: '#111827',
      lineHeight: 1.4,
    });
  });

  test('creates default shape elements with editable fill and outline', () => {
    const element = createDefaultShapeElement('shape-1');

    expect(element).toMatchObject({
      id: 'shape-1',
      type: 'shape',
      fill: '#dbeafe',
      outline: {
        width: 2,
        color: '#2563eb',
        style: 'solid',
      },
    });
    expect(element.viewBox).toEqual([260, 140]);
  });

  test('creates shape elements from a picked spec, preserving viewBox + path', () => {
    const element = createDefaultShapeElement('shape-2', {
      viewBox: [200, 200],
      path: 'M 100 0 L 200 200 L 0 200 Z',
    });

    expect(element).toMatchObject({
      id: 'shape-2',
      type: 'shape',
      viewBox: [200, 200],
      path: 'M 100 0 L 200 200 L 0 200 Z',
    });
    expect(element.width).toBe(200);
    expect(element.height).toBe(200);
  });

  test('creates default image elements from a source URL', () => {
    const element = createDefaultImageElement('image-1', 'https://example.com/image.png');

    expect(element).toMatchObject({
      id: 'image-1',
      type: 'image',
      src: 'https://example.com/image.png',
      fixedRatio: true,
      width: 360,
      height: 220,
    });
  });

  test('creates a valid default chart for the requested chart type', () => {
    const element = createDefaultChartElement('chart-1', 'pie');

    expect(element).toMatchObject({
      id: 'chart-1',
      type: 'chart',
      chartType: 'pie',
      left: 160,
      top: 140,
      width: 420,
      height: 260,
      rotate: 0,
      themeColors: expect.any(Array),
      data: {
        labels: ['A', 'B', 'C', 'D'],
        legends: ['Series 1'],
        series: [[24, 36, 28, 42]],
      },
    });
    expect(element.themeColors).toHaveLength(4);
  });

  test('creates a valid empty table for the requested row and column count', () => {
    const element = createDefaultTableElement('table-1', 2, 3);

    expect(element).toMatchObject({
      id: 'table-1',
      type: 'table',
      left: 120,
      top: 120,
      width: 360,
      height: 120,
      cellMinHeight: 36,
      colWidths: [1 / 3, 1 / 3, 1 / 3],
      outline: { width: 2, style: 'solid', color: '#eeece1' },
    });
    expect(element.data).toHaveLength(2);
    expect(element.data.flat()).toHaveLength(6);
    expect(element.data.flat().map((cell) => cell.id)).toEqual([
      'table-1-cell-0-0',
      'table-1-cell-0-1',
      'table-1-cell-0-2',
      'table-1-cell-1-0',
      'table-1-cell-1-1',
      'table-1-cell-1-2',
    ]);
    expect(element.data.flat().every((cell) => cell.text === '')).toBe(true);
  });

  test('converts plain text to escaped paragraph html', () => {
    expect(plainTextToParagraphHtml('A < B & C')).toBe('<p>A &lt; B &amp; C</p>');
  });

  test('converts stored html content into editable plain text', () => {
    expect(htmlToPlainText('<p>Hello</p><p>World</p>')).toBe('HelloWorld');
  });
});
