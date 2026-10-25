import { describe, expect, it } from 'vitest';
import type {
  PPTCodeElement,
  PPTImageElement,
  PPTLineElement,
  PPTShapeElement,
  PPTTableElement,
  PPTTextElement,
  Whiteboard,
} from '@openmaic/dsl';
import { extractWhiteboardText } from '@/lib/whiteboard/extract-text';

describe('extractWhiteboardText', () => {
  const sampleText: PPTTextElement = {
    id: 'text-1',
    type: 'text',
    left: 10,
    top: 10,
    width: 200,
    height: 50,
    rotate: 0,
    content: '<p>First line of notes</p><p>Second line of notes</p>',
    defaultColor: '#000000',
    defaultFontName: 'Arial',
  };

  const sampleCode: PPTCodeElement = {
    id: 'code-1',
    type: 'code',
    left: 10,
    top: 70,
    width: 300,
    height: 100,
    rotate: 0,
    language: 'python',
    fileName: 'algo.py',
    showLineNumbers: true,
    lines: [
      { id: 'l1', content: 'def solve(n):' },
      { id: 'l2', content: '    total = 0' },
      { id: 'l3', content: '    for i in range(n):' },
      { id: 'l4', content: '        total += i' },
      { id: 'l5', content: '    return total' },
    ],
  };

  const sampleShape: PPTShapeElement = {
    id: 'shape-1',
    type: 'shape',
    left: 10,
    top: 180,
    width: 100,
    height: 100,
    rotate: 0,
    viewBox: [100, 100],
    path: 'M 0 0 L 100 0 L 100 100 Z',
    fill: '#ff0000',
    fixedRatio: false,
  };

  const sampleImage: PPTImageElement = {
    id: 'img-1',
    type: 'image',
    left: 120,
    top: 180,
    width: 80,
    height: 80,
    rotate: 0,
    src: 'data:image/png;base64,123',
    fixedRatio: true,
  };

  const sampleLine: PPTLineElement = {
    id: 'line-1',
    type: 'line',
    left: 0,
    top: 0,
    width: 100,
    start: [0, 0],
    end: [100, 100],
    color: '#000',
    style: 'solid',
    points: ['', ''],
  };

  const sampleTable: PPTTableElement = {
    id: 'table-1',
    type: 'table',
    left: 10,
    top: 200,
    width: 300,
    height: 120,
    rotate: 0,
    colWidths: [0.5, 0.5],
    cellMinHeight: 36,
    outline: { width: 1, style: 'solid', color: '#ccc' },
    data: [
      [
        { id: 'c1', colspan: 1, rowspan: 1, text: 'Item &amp; Details' },
        { id: 'c2', colspan: 1, rowspan: 1, text: 'Cost &lt;$100&gt;' },
      ],
      [
        { id: 'c3', colspan: 1, rowspan: 1, text: 'Widget &quot;A&quot;' },
        { id: 'c4', colspan: 1, rowspan: 1, text: '$49.99' },
      ],
    ],
  };

  it('combines text and code elements while excluding non-text elements and decorations', () => {
    const whiteboard: Whiteboard = {
      id: 'wb-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [sampleText, sampleShape, sampleCode, sampleImage, sampleLine],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe(
      'First line of notes\nSecond line of notes\n\ndef solve(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total',
    );
  });

  it('preserves exact board order across interleaved text and code elements', () => {
    const secondText: PPTTextElement = {
      id: 'text-2',
      type: 'text',
      left: 10,
      top: 300,
      width: 200,
      height: 40,
      rotate: 0,
      content: '<p>Conclusion and next steps.</p>',
      defaultColor: '#000000',
      defaultFontName: 'Arial',
    };

    const whiteboard: Whiteboard = {
      id: 'wb-ordered',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [sampleCode, sampleText, secondText],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe(
      'def solve(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total\n\nFirst line of notes\nSecond line of notes\n\nConclusion and next steps.',
    );
  });

  it('preserves meaningful line breaks, lists, and decoded HTML entities in text content', () => {
    const richText: PPTTextElement = {
      id: 'text-rich',
      type: 'text',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      content:
        '<h3>Key takeaways:</h3><ul><li>Condition: a &lt; b &amp;&amp; b &gt; c</li><li>Special char: &#xA0;blank &quot;quoted&quot;</li><li>Break after<br/>continued here</li></ul>',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };

    const whiteboard: Whiteboard = {
      id: 'wb-rich',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [richText],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe(
      'Key takeaways:\nCondition: a < b && b > c\nSpecial char:  blank "quoted"\nBreak after\ncontinued here',
    );
  });

  it('preserves code formatting including indentation, empty lines, and excludes UI controls and line numbers', () => {
    const codeWithIndentation: PPTCodeElement = {
      id: 'code-formatted',
      type: 'code',
      left: 0,
      top: 0,
      width: 400,
      height: 200,
      rotate: 0,
      language: 'typescript',
      fileName: 'main.ts',
      showLineNumbers: true,
      lines: [
        { id: '1', content: 'class Example {' },
        { id: '2', content: '  private count: number = 0;' },
        { id: '3', content: '' },
        { id: '4', content: '  public increment(): void {' },
        { id: '5', content: '    this.count++;' },
        { id: '6', content: '  }' },
        { id: '7', content: '}' },
      ],
    };

    const whiteboard: Whiteboard = {
      id: 'wb-code',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [codeWithIndentation],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe(
      'class Example {\n  private count: number = 0;\n\n  public increment(): void {\n    this.count++;\n  }\n}',
    );
    // UI filename and line numbers must not appear
    expect(result).not.toContain('main.ts');
    expect(result).not.toContain('1');
  });

  it('handles empty content gracefully across empty whiteboards, null/undefined, and non-text elements', () => {
    expect(extractWhiteboardText(null)).toBe('');
    expect(extractWhiteboardText(undefined)).toBe('');
    expect(
      extractWhiteboardText({
        id: 'wb-empty',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [],
      }),
    ).toBe('');

    // Only non-text decorations
    expect(
      extractWhiteboardText({
        id: 'wb-nontext',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [sampleShape, sampleImage, sampleLine],
      }),
    ).toBe('');

    // Elements with only empty markup or whitespace
    const emptyText: PPTTextElement = {
      id: 'text-empty',
      type: 'text',
      left: 0,
      top: 0,
      width: 100,
      height: 50,
      rotate: 0,
      content: '<p>   </p><p></p>',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };
    const emptyCode: PPTCodeElement = {
      id: 'code-empty',
      type: 'code',
      left: 0,
      top: 0,
      width: 100,
      height: 50,
      rotate: 0,
      language: 'javascript',
      lines: [{ id: '1', content: '   ' }],
    };

    const emptyTable: PPTTableElement = {
      id: 'table-empty',
      type: 'table',
      left: 0,
      top: 0,
      width: 100,
      height: 50,
      rotate: 0,
      colWidths: [0.5, 0.5],
      cellMinHeight: 36,
      outline: { width: 1, style: 'solid', color: '#ccc' },
      data: [
        [
          { id: 'ec1', colspan: 1, rowspan: 1, text: '' },
          { id: 'ec2', colspan: 1, rowspan: 1, text: '   ' },
        ],
        [
          { id: 'ec3', colspan: 1, rowspan: 1, text: '<p></p>' },
          { id: 'ec4', colspan: 1, rowspan: 1, text: '<p>   </p>' },
        ],
      ],
    };

    expect(
      extractWhiteboardText({
        id: 'wb-blank',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [emptyText, emptyCode, emptyTable],
      }),
    ).toBe('');
  });

  it('extracts and decodes table cells in row order for table-only boards', () => {
    const whiteboard: Whiteboard = {
      id: 'wb-table-only',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [sampleTable],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe('Item & Details\nCost <$100>\nWidget "A"\n$49.99');
  });

  it('preserves exact cell ordering across multi-column, multi-row tables in row order', () => {
    const matrixTable: PPTTableElement = {
      id: 'table-matrix',
      type: 'table',
      left: 0,
      top: 0,
      width: 300,
      height: 120,
      rotate: 0,
      colWidths: [0.33, 0.33, 0.34],
      cellMinHeight: 30,
      outline: { width: 1, style: 'solid', color: '#ccc' },
      data: [
        [
          { id: 'r1c1', colspan: 1, rowspan: 1, text: 'R1C1' },
          { id: 'r1c2', colspan: 1, rowspan: 1, text: 'R1C2' },
          { id: 'r1c3', colspan: 1, rowspan: 1, text: 'R1C3' },
        ],
        [
          { id: 'r2c1', colspan: 1, rowspan: 1, text: 'R2C1' },
          { id: 'r2c2', colspan: 1, rowspan: 1, text: 'R2C2' },
          { id: 'r2c3', colspan: 1, rowspan: 1, text: 'R2C3' },
        ],
      ],
    };

    const whiteboard: Whiteboard = {
      id: 'wb-matrix',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [matrixTable],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe('R1C1\nR1C2\nR1C3\nR2C1\nR2C2\nR2C3');
  });

  it('extracts table content alongside text and code in exact board order for mixed boards', () => {
    const whiteboard: Whiteboard = {
      id: 'wb-mixed',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      // Board order: text, non-text shape, table, non-text image, code
      elements: [sampleText, sampleShape, sampleTable, sampleImage, sampleCode],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe(
      'First line of notes\nSecond line of notes\n\nItem & Details\nCost <$100>\nWidget "A"\n$49.99\n\ndef solve(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total',
    );
  });
});
