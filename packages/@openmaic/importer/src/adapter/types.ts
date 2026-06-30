/**
 * pptxtojson / PPTist 输出格式类型定义
 * 长度与坐标单位均为 pt。
 */

export interface Size {
  width: number;
  height: number;
}

export interface Shadow {
  h: number;
  v: number;
  blur: number;
  color: string;
  inset?: boolean;
}

export interface ColorFill {
  type: 'color';
  value: string;
}

export interface ImageFill {
  type: 'image';
  value: {
    picBase64: string;
    opacity: number;
  };
}

export interface GradientFill {
  type: 'gradient';
  value: {
    path: 'line' | 'circle' | 'rect' | 'shape';
    rot: number;
    colors: {
      pos: string;
      color: string;
    }[];
  };
}

export interface PatternFill {
  type: 'pattern';
  value: {
    type: string;
    foregroundColor: string;
    backgroundColor: string;
  };
}

export type Fill = ColorFill | ImageFill | GradientFill | PatternFill;

export interface Border {
  borderColor: string;
  borderWidth: number;
  borderType: 'solid' | 'dashed' | 'dotted';
}

export interface AutoFit {
  type: 'shape' | 'text';
  fontScale?: number;
}

export interface Shape {
  type: 'shape';
  left: number;
  top: number;
  width: number;
  height: number;
  borderColor: string;
  borderWidth: number;
  borderType: 'solid' | 'dashed' | 'dotted';
  borderStrokeDasharray: string;
  shadow?: Shadow;
  fill: Fill;
  content: string;
  isFlipV: boolean;
  isFlipH: boolean;
  rotate: number;
  shapType: string;
  vAlign: string;
  path?: string;
  keypoints?: Record<string, number>;
  name: string;
  order: number;
  autoFit?: AutoFit;
  link?: string;
}

export interface Text {
  type: 'text';
  left: number;
  top: number;
  width: number;
  height: number;
  borderColor: string;
  borderWidth: number;
  borderType: 'solid' | 'dashed' | 'dotted';
  borderStrokeDasharray: string;
  shadow?: Shadow;
  fill: Fill;
  isFlipV: boolean;
  isFlipH: boolean;
  isVertical: boolean;
  rotate: number;
  content: string;
  vAlign: string;
  name: string;
  order: number;
  autoFit?: AutoFit;
  link?: string;
}

export interface Image {
  type: 'image';
  left: number;
  top: number;
  width: number;
  height: number;
  src: string;
  rotate: number;
  isFlipH: boolean;
  isFlipV: boolean;
  order: number;
  rect?: {
    t?: number;
    b?: number;
    l?: number;
    r?: number;
  };
  geom: string;
  borderColor: string;
  borderWidth: number;
  borderType: 'solid' | 'dashed' | 'dotted';
  borderStrokeDasharray: string;
  filters?: {
    sharpen?: number;
    colorTemperature?: number;
    saturation?: number;
    brightness?: number;
    contrast?: number;
  };
  link?: string;
  /** Soft-edge feather radius in px (a:effectLst>softEdge@rad). Fades the image
   *  alpha to transparent over this radius at every edge. */
  softEdge?: number;
}

export interface TableCell {
  text: string;
  rowSpan?: number;
  colSpan?: number;
  vMerge?: number;
  hMerge?: number;
  fillColor?: string;
  fontColor?: string;
  fontBold?: boolean;
  /**
   * Vertical text alignment within the cell, parsed from `<a:tcPr anchor="...">`.
   * Field is only present when the source XML explicitly sets `anchor`.
   */
  vAlign?: 'up' | 'mid' | 'down';
  borders: {
    top?: Border;
    bottom?: Border;
    left?: Border;
    right?: Border;
  };
}

export interface Table {
  type: 'table';
  left: number;
  top: number;
  width: number;
  height: number;
  data: TableCell[][];
  borders: {
    top?: Border;
    bottom?: Border;
    left?: Border;
    right?: Border;
  };
  order: number;
  rowHeights: number[];
  colWidths: number[];
}

export type ChartType =
  | 'lineChart'
  | 'line3DChart'
  | 'barChart'
  | 'bar3DChart'
  | 'pieChart'
  | 'pie3DChart'
  | 'doughnutChart'
  | 'areaChart'
  | 'area3DChart'
  | 'scatterChart'
  | 'bubbleChart'
  | 'radarChart'
  | 'surfaceChart'
  | 'surface3DChart'
  | 'stockChart';

export interface ChartValue {
  x: string;
  y: number;
}

export interface ChartXLabel {
  [key: string]: string;
}

export interface ChartItem {
  key: string;
  values: ChartValue[];
  xlabels: ChartXLabel;
}

export type ScatterChartData = [number[], number[]];

export interface CommonChart {
  type: 'chart';
  left: number;
  top: number;
  width: number;
  height: number;
  data: ChartItem[];
  colors: string[];
  chartType: Exclude<ChartType, 'scatterChart' | 'bubbleChart'>;
  barDir?: 'bar' | 'col';
  marker?: boolean;
  holeSize?: string;
  grouping?: string;
  style?: string;
  order: number;
}

export interface ScatterChart {
  type: 'chart';
  left: number;
  top: number;
  width: number;
  height: number;
  data: ScatterChartData;
  colors: string[];
  chartType: 'scatterChart' | 'bubbleChart';
  order: number;
}

export type Chart = CommonChart | ScatterChart;

export interface Video {
  type: 'video';
  left: number;
  top: number;
  width: number;
  height: number;
  blob?: string;
  src?: string;
  order: number;
}

export interface Audio {
  type: 'audio';
  left: number;
  top: number;
  width: number;
  height: number;
  blob: string;
  order: number;
}

export interface Diagram {
  type: 'diagram';
  left: number;
  top: number;
  width: number;
  height: number;
  elements: (Shape | Text)[];
  textList: string[];
  order: number;
}

export interface Math {
  type: 'math';
  /** Resolved CSS color when the whole formula shares one explicit run color
   *  (OMML→LaTeX drops drawingML run color). Undefined → renderer default. */
  color?: string;
  left: number;
  top: number;
  width: number;
  height: number;
  latex: string;
  picBase64: string;
  order: number;
  text?: string;
}

export type BaseElement = Shape | Text | Image | Table | Chart | Video | Audio | Diagram | Math;

export interface Group {
  type: 'group';
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
  elements: BaseElement[];
  order: number;
  isFlipH: boolean;
  isFlipV: boolean;
}

export type Element = BaseElement | Group;

export interface SlideTransition {
  type: string;
  duration: number;
  direction: string | null;
}

export interface Slide {
  fill: Fill;
  elements: Element[];
  layoutElements: Element[];
  note: string;
  transition?: SlideTransition | null;
}

export interface Options {
  slideFactor?: number;
  fontsizeFactor?: number;
}

export interface Output {
  slides: Slide[];
  themeColors: string[];
  size: Size;
}
