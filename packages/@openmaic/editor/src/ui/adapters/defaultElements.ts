import type {
  ChartType,
  PPTAudioElement,
  PPTChartElement,
  PPTImageElement,
  PPTLatexElement,
  PPTLineElement,
  PPTTableElement,
  PPTTextElement,
  PPTVideoElement,
} from '@openmaic/dsl';
import type { LineCreateGeometry, TextCreateRect } from '../../react/types';
import type { EditorAsset } from '../host';
import type { LatexEditorResult } from '../latex/latex-editor';
import type { LineInsertPreset } from '../insert/LineInsertPicker';

export function createDefaultTextElement(
  id: string,
  rect: TextCreateRect = { left: 120, top: 120, width: 360, height: 72 },
): PPTTextElement {
  return {
    id,
    type: 'text',
    ...rect,
    rotate: 0,
    content: '<p style="text-align: center"><br></p>',
    defaultFontName: '',
    defaultColor: '#333333',
  };
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export function fitImageSize(width: number, height: number): ImageDimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 360, height: 220 };
  }
  const scale = Math.min(1, 600 / width, 400 / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function createDefaultImageElement(
  id: string,
  src: string,
  dimensions?: ImageDimensions,
): PPTImageElement {
  const size = dimensions
    ? fitImageSize(dimensions.width, dimensions.height)
    : { width: 360, height: 220 };
  return {
    id,
    type: 'image',
    left: 180,
    top: 140,
    width: size.width,
    height: size.height,
    rotate: 0,
    fixedRatio: true,
    src,
  };
}

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
    outline: { width: 2, color: '#eeece1', style: 'solid' },
  };
}

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

export function createDefaultVideoElement(id: string, asset: EditorAsset): PPTVideoElement {
  return {
    id,
    type: 'video',
    left: 180,
    top: 140,
    width: 360,
    height: 203,
    rotate: 0,
    src: asset.src,
    autoplay: false,
    ...(asset.ext ? { ext: asset.ext } : {}),
  };
}

export function createDefaultAudioElement(id: string, asset: EditorAsset): PPTAudioElement {
  return {
    id,
    type: 'audio',
    left: 180,
    top: 180,
    width: 48,
    height: 48,
    rotate: 0,
    fixedRatio: true,
    color: '#7c3aed',
    loop: false,
    autoplay: false,
    src: asset.src,
    ...(asset.ext ? { ext: asset.ext } : {}),
  };
}

const DEFAULT_LINE_PRESET: LineInsertPreset = {
  path: 'M 0 0 L 20 20',
  style: 'solid',
  points: ['', ''],
};

export function createDefaultLineElement(
  id: string,
  geometry: LineCreateGeometry,
  preset: LineInsertPreset = DEFAULT_LINE_PRESET,
): PPTLineElement {
  const [startX, startY] = geometry.start;
  const [endX, endY] = geometry.end;
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  const start: [number, number] = [startX - left, startY - top];
  const end: [number, number] = [endX - left, endY - top];
  const midpointX = (start[0] + end[0]) / 2;
  const controls = preset.isCubic
    ? {
        cubic: [
          [end[0], start[1]],
          [start[0], end[1]],
        ] as [[number, number], [number, number]],
      }
    : preset.isCurve
      ? { curve: [start[0], end[1]] as [number, number] }
      : preset.isBroken2
        ? { broken2: [midpointX, start[1]] as [number, number] }
        : preset.isBroken
          ? { broken: [start[0], end[1]] as [number, number] }
          : {};

  return {
    id,
    type: 'line',
    left,
    top,
    width: 2,
    start,
    end,
    style: preset.style,
    color: '#333333',
    points: preset.points,
    ...controls,
  };
}
