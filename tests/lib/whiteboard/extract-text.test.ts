import { describe, expect, it } from 'vitest';
import type {
  PPTChartElement,
  PPTCodeElement,
  PPTImageElement,
  PPTLatexElement,
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

  const sampleLabeledShape: PPTShapeElement = {
    id: 'shape-labeled',
    type: 'shape',
    left: 10,
    top: 180,
    width: 120,
    height: 60,
    rotate: 0,
    viewBox: [120, 60],
    path: 'M 0 0 L 120 0 L 120 60 L 0 60 Z',
    fill: '#4f46e5',
    fixedRatio: false,
    text: {
      content: '<p>Decision Node &amp; Check</p>',
      defaultFontName: 'Arial',
      defaultColor: '#ffffff',
      align: 'middle',
    },
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

  const sampleChart: PPTChartElement = {
    id: 'chart-1',
    type: 'chart',
    left: 10,
    top: 340,
    width: 400,
    height: 250,
    rotate: 0,
    chartType: 'bar',
    themeColors: ['#5b9bd5'],
    data: {
      labels: ['Q1', 'Q2', 'Q3', 'Q4'],
      legends: ['Revenue', 'Profit'],
      series: [
        [100, 120, 140, 160],
        [20, 25, 30, 35],
      ],
    },
  };

  const sampleLatex: PPTLatexElement = {
    id: 'latex-1',
    type: 'latex',
    left: 10,
    top: 610,
    width: 300,
    height: 80,
    rotate: 0,
    latex: 'E = mc^2',
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

  it('preserves intentional leading and trailing blank code lines while ignoring whitespace-only code', () => {
    const codeWithBoundaryBlanks: PPTCodeElement = {
      id: 'code-boundary-blanks',
      type: 'code',
      left: 0,
      top: 0,
      width: 400,
      height: 200,
      rotate: 0,
      language: 'typescript',
      lines: [
        { id: '1', content: '' },
        { id: '2', content: 'const answer = 42;' },
        { id: '3', content: '' },
        { id: '4', content: '' },
      ],
    };

    const whitespaceOnlyCode: PPTCodeElement = {
      id: 'code-whitespace-only',
      type: 'code',
      left: 0,
      top: 0,
      width: 400,
      height: 200,
      rotate: 0,
      language: 'typescript',
      lines: [
        { id: '1', content: '   ' },
        { id: '2', content: '' },
      ],
    };

    expect(
      extractWhiteboardText({
        id: 'wb-code-boundary-blanks',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [codeWithBoundaryBlanks],
      }),
    ).toBe('\nconst answer = 42;\n\n');

    expect(
      extractWhiteboardText({
        id: 'wb-code-whitespace-only',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [whitespaceOnlyCode],
      }),
    ).toBe('');
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

    const emptyChart: PPTChartElement = {
      id: 'chart-empty',
      type: 'chart',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      chartType: 'bar',
      themeColors: ['#5b9bd5'],
      data: {
        labels: ['', '   '],
        legends: ['  '],
        series: [],
      },
    };

    const emptyLatex: PPTLatexElement = {
      id: 'latex-empty',
      type: 'latex',
      left: 0,
      top: 0,
      width: 100,
      height: 50,
      rotate: 0,
      latex: '   ',
    };

    expect(
      extractWhiteboardText({
        id: 'wb-blank',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [emptyText, emptyCode, emptyTable, emptyChart, emptyLatex],
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

  it('extracts and decodes label text for shape-only boards with labeled shapes', () => {
    const whiteboard: Whiteboard = {
      id: 'wb-shape-only',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [sampleLabeledShape],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe('Decision Node & Check');
  });

  it('extracts labeled shape content alongside text, table, and code in exact board order for mixed boards', () => {
    const whiteboard: Whiteboard = {
      id: 'wb-mixed-all',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      // Board order: text, labeled shape, unlabeled shape (ignored), table, code
      elements: [sampleText, sampleLabeledShape, sampleShape, sampleTable, sampleCode],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe(
      'First line of notes\nSecond line of notes\n\nDecision Node & Check\n\nItem & Details\nCost <$100>\nWidget "A"\n$49.99\n\ndef solve(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total',
    );
  });

  it('excludes shapes without text or with only empty tags/whitespace', () => {
    const shapeEmptyString: PPTShapeElement = {
      id: 'shape-empty-str',
      type: 'shape',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      viewBox: [100, 100],
      path: 'M 0 0 L 100 0 Z',
      fill: '#000',
      fixedRatio: false,
      text: {
        content: '',
        defaultFontName: 'Arial',
        defaultColor: '#fff',
        align: 'middle',
      },
    };

    const shapeWhitespace: PPTShapeElement = {
      id: 'shape-whitespace',
      type: 'shape',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      viewBox: [100, 100],
      path: 'M 0 0 L 100 0 Z',
      fill: '#000',
      fixedRatio: false,
      text: {
        content: '   <p></p>   ',
        defaultFontName: 'Arial',
        defaultColor: '#fff',
        align: 'middle',
      },
    };

    const whiteboard: Whiteboard = {
      id: 'wb-unlabeled-shapes',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [sampleShape, shapeEmptyString, shapeWhitespace],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe('');
  });

  it('extracts chart labels, legends, and visible series values in data order for chart-only boards', () => {
    const whiteboard: Whiteboard = {
      id: 'wb-chart-only',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [sampleChart],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe(
      'Q1\nQ2\nQ3\nQ4\nRevenue\nProfit\n' +
        'Revenue: Q1 100, Q2 120, Q3 140, Q4 160\n' +
        'Profit: Q1 20, Q2 25, Q3 30, Q4 35',
    );
  });

  it('preserves chart labels and legends as literal text, including markup-like strings and entity sequences in order', () => {
    const chartWithLiteralMarkup: PPTChartElement = {
      id: 'chart-markup',
      type: 'chart',
      left: 0,
      top: 0,
      width: 400,
      height: 300,
      rotate: 0,
      chartType: 'column',
      themeColors: ['#5b9bd5'],
      data: {
        labels: ['Sales <Domestic>', 'Profit <Margin>'],
        legends: ['Budget &quot;Approved&quot;', 'R&amp;D'],
        series: [
          [50, 80],
          [20, 30],
        ],
      },
    };

    const pieChartOnlyLabels: PPTChartElement = {
      id: 'chart-pie',
      type: 'chart',
      left: 0,
      top: 0,
      width: 300,
      height: 300,
      rotate: 0,
      chartType: 'pie',
      themeColors: ['#5b9bd5'],
      data: {
        labels: ['Chrome', 'Firefox', 'Safari <Tech Preview>'],
        legends: [],
        series: [[60, 25, 15]],
      },
    };

    const chartOnlyLegends: PPTChartElement = {
      id: 'chart-legends',
      type: 'chart',
      left: 0,
      top: 0,
      width: 300,
      height: 300,
      rotate: 0,
      chartType: 'line',
      themeColors: ['#5b9bd5'],
      data: {
        labels: [],
        legends: ['Series Alpha <1>', 'Series Beta & Co'],
        series: [
          [1, 2],
          [3, 4],
        ],
      },
    };

    expect(
      extractWhiteboardText({
        id: 'wb-chart-markup',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [chartWithLiteralMarkup],
      }),
    ).toBe(
      'Sales <Domestic>\nProfit <Margin>\nBudget &quot;Approved&quot;\nR&amp;D\n' +
        'Budget &quot;Approved&quot;: Sales <Domestic> 50, Profit <Margin> 80\n' +
        'R&amp;D: Sales <Domestic> 20, Profit <Margin> 30',
    );

    expect(
      extractWhiteboardText({
        id: 'wb-pie-labels',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [pieChartOnlyLabels],
      }),
    ).toBe('Chrome\nFirefox\nSafari <Tech Preview>');

    expect(
      extractWhiteboardText({
        id: 'wb-legends-only',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [chartOnlyLegends],
      }),
    ).toBe(
      'Series Alpha <1>\nSeries Beta & Co\n' +
        'Series Alpha <1>: 1, 2\n' +
        'Series Beta & Co: 3, 4',
    );
  });

  it('ignores formatting whitespace between rich-text blocks while preserving intentional structure', () => {
    const prettyPrintedText: PPTTextElement = {
      id: 'text-pretty',
      type: 'text',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      content: '<p>First line</p>\n<p>Second line</p>',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };

    const crlfIndentedText: PPTTextElement = {
      id: 'text-crlf',
      type: 'text',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      content: '<div>\r\n  <p>Step 1: Prep</p>\r\n  <p>Step 2: Execute</p>\r\n</div>',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };

    const intentionalBlankLineText: PPTTextElement = {
      id: 'text-blank-p',
      type: 'text',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      content: '<p>Section A</p>\n<p></p>\n<p>Section B</p>',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };

    const nestedListText: PPTTextElement = {
      id: 'text-list',
      type: 'text',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      content: '<h3>Tasks</h3>\n<ul>\n  <li>Task 1</li>\n  <li>Task 2</li>\n</ul>',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };

    expect(
      extractWhiteboardText({
        id: 'wb-pretty',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [prettyPrintedText],
      }),
    ).toBe('First line\nSecond line');

    expect(
      extractWhiteboardText({
        id: 'wb-crlf',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [crlfIndentedText],
      }),
    ).toBe('Step 1: Prep\nStep 2: Execute');

    expect(
      extractWhiteboardText({
        id: 'wb-intentional-blank',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [intentionalBlankLineText],
      }),
    ).toBe('Section A\n\nSection B');

    expect(
      extractWhiteboardText({
        id: 'wb-nested-list',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [nestedListText],
      }),
    ).toBe('Tasks\nTask 1\nTask 2');
  });

  it('keeps adjacent rich-text blocks on separate lines without source whitespace', () => {
    const adjacentBlocks: PPTTextElement = {
      id: 'text-adjacent-blocks',
      type: 'text',
      left: 0,
      top: 0,
      width: 300,
      height: 120,
      rotate: 0,
      content: '<h3>First</h3><h3>Second</h3><p>Third</p><blockquote>Fourth</blockquote>',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };

    expect(
      extractWhiteboardText({
        id: 'wb-adjacent-blocks',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [adjacentBlocks],
      }),
    ).toBe('First\nSecond\nThird\nFourth');
  });

  it('decodes standard named and numeric HTML entities in rich-text content', () => {
    const richEntities: PPTTextElement = {
      id: 'text-standard-entities',
      type: 'text',
      left: 0,
      top: 0,
      width: 300,
      height: 80,
      rotate: 0,
      content: '<p>Copyright &copy; 2026&ensp;OpenMAIC &#169; &#x2002; end</p>',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };

    expect(
      extractWhiteboardText({
        id: 'wb-standard-entities',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [richEntities],
      }),
    ).toBe('Copyright \u00a9 2026\u2002OpenMAIC \u00a9 \u2002 end');
  });

  it('preserves meaningful inline spacing in rich-text content', () => {
    const inlineSpannedText: PPTTextElement = {
      id: 'text-spans',
      type: 'text',
      left: 0,
      top: 0,
      width: 200,
      height: 60,
      rotate: 0,
      content: '<p><span>Hello</span> <span>world</span> from <b>OpenMAIC</b>!</p>',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };

    expect(
      extractWhiteboardText({
        id: 'wb-inline-spans',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [inlineSpannedText],
      }),
    ).toBe('Hello world from OpenMAIC!');
  });

  it('preserves intentional newlines, blank lines, and indentation in plain-text content', () => {
    const plainWithNewlines: PPTTextElement = {
      id: 'text-plain-newlines',
      type: 'text',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      content: 'Line 1: Note\nLine 2: Note\n\nLine 3: Note after blank\n  Indented note',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };

    const plainWithEntitiesAndBrackets: PPTTextElement = {
      id: 'text-plain-brackets',
      type: 'text',
      left: 0,
      top: 0,
      width: 200,
      height: 80,
      rotate: 0,
      content: 'a < b &amp;&amp; c > d\nR&D &amp; Marketing',
      defaultColor: '#000',
      defaultFontName: 'Arial',
    };

    expect(
      extractWhiteboardText({
        id: 'wb-plain-newlines',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [plainWithNewlines],
      }),
    ).toBe('Line 1: Note\nLine 2: Note\n\nLine 3: Note after blank\n  Indented note');

    expect(
      extractWhiteboardText({
        id: 'wb-plain-brackets',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [plainWithEntitiesAndBrackets],
      }),
    ).toBe('a < b && c > d\nR&D & Marketing');
  });

  it('excludes chart elements with empty or whitespace-only labels and legends', () => {
    const blankChart: PPTChartElement = {
      id: 'chart-blank',
      type: 'chart',
      left: 0,
      top: 0,
      width: 200,
      height: 200,
      rotate: 0,
      chartType: 'bar',
      themeColors: ['#5b9bd5'],
      data: {
        labels: ['', '   ', ' \t '],
        legends: ['  ', ''],
        series: [],
      },
    };

    expect(
      extractWhiteboardText({
        id: 'wb-blank-chart',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [blankChart],
      }),
    ).toBe('');
  });

  it('extracts stored formula source for formula-only boards', () => {
    const whiteboard: Whiteboard = {
      id: 'wb-formula-only',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [sampleLatex],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe('E = mc^2');
  });

  it('preserves multiline formatting and LaTeX syntax in standalone formulas', () => {
    const multilineFormula: PPTLatexElement = {
      id: 'latex-maxwell',
      type: 'latex',
      left: 0,
      top: 0,
      width: 400,
      height: 120,
      rotate: 0,
      latex:
        '\\begin{aligned}\n\\nabla \\times \\mathbf{E} &= -\\frac{\\partial \\mathbf{B}}{\\partial t} \\\\\n\\nabla \\times \\mathbf{B} &= \\mu_0 \\mathbf{J} + \\mu_0 \\epsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}\n\\end{aligned}',
    };

    const whiteboard: Whiteboard = {
      id: 'wb-maxwell',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [multilineFormula],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe(
      '\\begin{aligned}\n\\nabla \\times \\mathbf{E} &= -\\frac{\\partial \\mathbf{B}}{\\partial t} \\\\\n\\nabla \\times \\mathbf{B} &= \\mu_0 \\mathbf{J} + \\mu_0 \\epsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}\n\\end{aligned}',
    );
  });

  it('decodes HTML entities in formula source if present', () => {
    const formulaWithEntities: PPTLatexElement = {
      id: 'latex-entities',
      type: 'latex',
      left: 0,
      top: 0,
      width: 300,
      height: 60,
      rotate: 0,
      latex: 'x &lt; y \\implies y &gt; x',
    };

    const whiteboard: Whiteboard = {
      id: 'wb-latex-entities',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [formulaWithEntities],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe('x < y \\implies y > x');
  });

  it('excludes formulas with empty or whitespace-only LaTeX source', () => {
    const emptyLatex1: PPTLatexElement = {
      id: 'latex-empty-1',
      type: 'latex',
      left: 0,
      top: 0,
      width: 200,
      height: 50,
      rotate: 0,
      latex: '',
    };
    const emptyLatex2: PPTLatexElement = {
      id: 'latex-empty-2',
      type: 'latex',
      left: 0,
      top: 0,
      width: 200,
      height: 50,
      rotate: 0,
      latex: '   \n   ',
    };

    expect(
      extractWhiteboardText({
        id: 'wb-empty-latex',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [emptyLatex1, emptyLatex2],
      }),
    ).toBe('');
  });

  it('extracts charts, formulas, text, table, labeled shape, and code in exact board order for mixed boards', () => {
    const whiteboard: Whiteboard = {
      id: 'wb-mixed-complete',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      // Board order: text, formula, chart, labeled shape, unlabeled shape (ignored), table, image (ignored), code
      elements: [
        sampleText,
        sampleLatex,
        sampleChart,
        sampleLabeledShape,
        sampleShape,
        sampleTable,
        sampleImage,
        sampleCode,
      ],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe(
      'First line of notes\nSecond line of notes\n\n' +
        'E = mc^2\n\n' +
        'Q1\nQ2\nQ3\nQ4\nRevenue\nProfit\n' +
        'Revenue: Q1 100, Q2 120, Q3 140, Q4 160\n' +
        'Profit: Q1 20, Q2 25, Q3 30, Q4 35\n\n' +
        'Decision Node & Check\n\n' +
        'Item & Details\nCost <$100>\nWidget "A"\n$49.99\n\n' +
        'def solve(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total',
    );
  });

  it('retains formula content and chart content across multiple formula and chart elements in board order', () => {
    const secondLatex: PPTLatexElement = {
      id: 'latex-2',
      type: 'latex',
      left: 0,
      top: 0,
      width: 200,
      height: 50,
      rotate: 0,
      latex: 'a^2 + b^2 = c^2',
    };

    const secondChart: PPTChartElement = {
      id: 'chart-2',
      type: 'chart',
      left: 0,
      top: 0,
      width: 300,
      height: 200,
      rotate: 0,
      chartType: 'line',
      themeColors: ['#5b9bd5'],
      data: {
        labels: ['Day 1', 'Day 2'],
        legends: ['Visits'],
        series: [[100, 200]],
      },
    };

    const whiteboard: Whiteboard = {
      id: 'wb-formulas-charts-order',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [sampleLatex, sampleChart, secondLatex, secondChart],
    };

    const result = extractWhiteboardText(whiteboard);

    expect(result).toBe(
      'E = mc^2\n\n' +
        'Q1\nQ2\nQ3\nQ4\nRevenue\nProfit\n' +
        'Revenue: Q1 100, Q2 120, Q3 140, Q4 160\n' +
        'Profit: Q1 20, Q2 25, Q3 30, Q4 35\n\n' +
        'a^2 + b^2 = c^2\n\n' +
        'Day 1\nDay 2\nVisits\n' +
        'Visits: Day 1 100, Day 2 200',
    );
  });
});
