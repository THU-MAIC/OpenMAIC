import type {
  ChartType,
  PPTChartElement,
  ShapePathFormulasKeys,
  PPTImageElement,
  PPTLatexElement,
  PPTShapeElement,
  PPTTableElement,
  PPTTextElement,
  Slide,
} from '@openmaic/dsl';
import type { LatexEditorResult } from '@openmaic/editor/ui';

export interface ShapeSpec {
  viewBox: [number, number];
  path: string;
  pathFormula?: ShapePathFormulasKeys;
  pptxShapeType?: string;
}

export function plainTextToParagraphHtml(value: string) {
  return `<p>${escapeHtml(value)}</p>`;
}

export function htmlToPlainText(value: string) {
  return value.replace(/<[^>]+>/g, '').trim();
}

export function createDefaultTextElement(id: string): PPTTextElement {
  return {
    id,
    type: 'text',
    left: 120,
    top: 120,
    width: 360,
    height: 72,
    rotate: 0,
    content: '<p>New text</p>',
    defaultFontName: 'Inter',
    defaultColor: '#111827',
    lineHeight: 1.4,
  };
}

export function createDefaultShapeElement(id: string, spec?: ShapeSpec): PPTShapeElement {
  const viewBox = spec?.viewBox ?? ([260, 140] as [number, number]);
  // Picked shapes tend to be square (200x200) in the shape pool — scale to
  // a reasonable canvas width while preserving aspect ratio.
  const width = spec ? 200 : viewBox[0];
  const height = spec ? 200 * (viewBox[1] / viewBox[0]) : viewBox[1];
  return {
    id,
    type: 'shape',
    left: 160,
    top: 160,
    width,
    height,
    rotate: 0,
    viewBox,
    path: spec?.path ?? 'M 0 0 L 260 0 L 260 140 L 0 140 Z',
    pathFormula: spec?.pathFormula,
    fixedRatio: false,
    fill: '#dbeafe',
    outline: {
      width: 2,
      color: '#2563eb',
      style: 'solid',
    },
  };
}

export function createDefaultSlide(id: string): Slide {
  return {
    id,
    viewportSize: 1000,
    viewportRatio: 0.5625, // 16:9
    theme: {
      backgroundColor: '#ffffff',
      themeColors: ['#5b8def', '#8b5cf6', '#10b981', '#f59e0b'],
      fontColor: '#111827',
      fontName: 'Inter',
    },
    elements: [],
    background: { type: 'solid', color: '#ffffff' },
  };
}

export function createDefaultImageElement(id: string, src: string): PPTImageElement {
  return {
    id,
    type: 'image',
    left: 180,
    top: 140,
    width: 360,
    height: 220,
    rotate: 0,
    fixedRatio: true,
    src,
  };
}

export function createDefaultLatexElement(id: string, result: LatexEditorResult): PPTLatexElement {
  return {
    id,
    type: 'latex',
    left: 160,
    top: 160,
    width: result.width,
    height: result.height,
    rotate: 0,
    latex: result.latex,
    html: result.html,
    color: '#333333',
    align: 'center',
    fixedRatio: true,
  };
}

/** Create a renderer-editor chart with data that is valid for every chart type. */
export function createDefaultChartElement(id: string, chartType: ChartType): PPTChartElement {
  return {
    id,
    type: 'chart',
    left: 160,
    top: 140,
    width: 420,
    height: 260,
    rotate: 0,
    chartType,
    data: {
      labels: ['A', 'B', 'C', 'D'],
      legends: ['Series 1'],
      series: [[24, 36, 28, 42]],
    },
    themeColors: ['#5b8def', '#8b5cf6', '#10b981', '#f59e0b'],
    textColor: '#333333',
    lineColor: '#d4d4d8',
  };
}

/** Create an empty table with equal columns for the slide insert palette. */
export function createDefaultTableElement(
  id: string,
  requestedRows: number,
  requestedColumns: number,
): PPTTableElement {
  const rows = Math.max(1, Math.floor(requestedRows));
  const columns = Math.max(1, Math.floor(requestedColumns));

  return {
    id,
    type: 'table',
    left: 120,
    top: 120,
    width: 360,
    height: Math.max(120, rows * 36),
    rotate: 0,
    colWidths: Array.from({ length: columns }, () => 1 / columns),
    cellMinHeight: 36,
    data: Array.from({ length: rows }, (_, rowIndex) =>
      Array.from({ length: columns }, (_, columnIndex) => ({
        id: `${id}-cell-${rowIndex}-${columnIndex}`,
        colspan: 1,
        rowspan: 1,
        text: '',
      })),
    ),
    outline: {
      width: 2,
      color: '#eeece1',
      style: 'solid',
    },
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
