export const enum ShapePathFormulasKeys {
  ROUND_RECT = 'roundRect',
  ROUND_RECT_DIAGONAL = 'roundRectDiagonal',
  ROUND_RECT_SINGLE = 'roundRectSingle',
  ROUND_RECT_SAMESIDE = 'roundRectSameSide',
  CUT_RECT_DIAGONAL = 'cutRectDiagonal',
  CUT_RECT_SINGLE = 'cutRectSingle',
  CUT_RECT_SAMESIDE = 'cutRectSameSide',
  CUT_ROUND_RECT = 'cutRoundRect',
  MESSAGE = 'message',
  ROUND_MESSAGE = 'roundMessage',
  L = 'L',
  RING_RECT = 'ringRect',
  PLUS = 'plus',
  TRIANGLE = 'triangle',
  PARALLELOGRAM_LEFT = 'parallelogramLeft',
  PARALLELOGRAM_RIGHT = 'parallelogramRight',
  TRAPEZOID = 'trapezoid',
  BULLET = 'bullet',
  INDICATOR = 'indicator',
  DONUT = 'donut',
  DIAGSTRIPE = 'diagStripe',
}

export const enum ElementTypes {
  TEXT = 'text',
  IMAGE = 'image',
  SHAPE = 'shape',
  LINE = 'line',
  CHART = 'chart',
  TABLE = 'table',
  LATEX = 'latex',
  VIDEO = 'video',
  AUDIO = 'audio',
}

export type GradientType = 'linear' | 'radial';
export type GradientColor = {
  pos: number;
  color: string;
};
export interface Gradient {
  type: GradientType;
  colors: GradientColor[];
  rotate: number;
}

export type LineStyleType = 'solid' | 'dashed' | 'dotted';

export interface PPTElementShadow {
  h: number;
  v: number;
  blur: number;
  color: string;
}

export interface PPTElementOutline {
  style?: LineStyleType;
  width?: number;
  color?: string;
}

export type ElementLinkType = 'web' | 'slide';

export interface PPTElementLink {
  type: ElementLinkType;
  target: string;
}

interface PPTBaseElement {
  id: string;
  left: number;
  top: number;
  lock?: boolean;
  groupId?: string;
  width: number;
  height: number;
  rotate: number;
  link?: PPTElementLink;
  name?: string;
}

export type TextType =
  | 'title'
  | 'subtitle'
  | 'content'
  | 'item'
  | 'itemTitle'
  | 'notes'
  | 'header'
  | 'footer'
  | 'partNumber'
  | 'itemNumber';

/**
 * 
 *
 * type: （text）
 *
 * content: （HTML）
 *
 * defaultFontName: （HTML）
 *
 * defaultColor: （HTML）
 *
 * outline?: 
 *
 * fill?: 
 *
 * lineHeight?: （），1.5
 *
 * wordSpace?: ，0
 *
 * opacity?: ，1
 *
 * shadow?: 
 *
 * paragraphSpace?: ， 5px
 *
 * vertical?: 
 *
 * textType?: 
 */
export interface PPTTextElement extends PPTBaseElement {
  type: 'text';
  content: string;
  defaultFontName: string;
  defaultColor: string;
  outline?: PPTElementOutline;
  fill?: string;
  lineHeight?: number;
  wordSpace?: number;
  opacity?: number;
  shadow?: PPTElementShadow;
  paragraphSpace?: number;
  vertical?: boolean;
  textType?: TextType;
}

/**
 * 、
 *
 * flipH?: 
 *
 * flipV?: 
 */
export interface ImageOrShapeFlip {
  flipH?: boolean;
  flipV?: boolean;
}

/**
 * 
 *
 * https://developer.mozilla.org/zh-CN/docs/Web/CSS/filter
 *
 * 'blur'?: ，0（px）
 *
 * 'brightness'?: ，100（%）
 *
 * 'contrast'?: ，100（%）
 *
 * 'grayscale'?: ，0（%）
 *
 * 'saturate'?: ，100（%）
 *
 * 'hue-rotate'?: ，0（deg）
 *
 * 'opacity'?: ，100（%）
 */
export type ImageElementFilterKeys =
  | 'blur'
  | 'brightness'
  | 'contrast'
  | 'grayscale'
  | 'saturate'
  | 'hue-rotate'
  | 'opacity'
  | 'sepia'
  | 'invert';
export interface ImageElementFilters {
  blur?: string;
  brightness?: string;
  contrast?: string;
  grayscale?: string;
  saturate?: string;
  'hue-rotate'?: string;
  sepia?: string;
  invert?: string;
  opacity?: string;
}

export type ImageClipDataRange = [[number, number], [number, number]];

/**
 * 
 *
 * range: ，：[[10, 10], [90, 90]]  10%, 10%  90%, 90% 
 *
 * shape: ， configs/image-clip.ts CLIPPATHS
 */
export interface ImageElementClip {
  range: ImageClipDataRange;
  shape: string;
}

export type ImageType = 'pageFigure' | 'itemFigure' | 'background';

/**
 * 
 *
 * type: （image）
 *
 * fixedRatio: 
 *
 * src: 
 *
 * outline?: 
 *
 * filters?: 
 *
 * clip?: 
 *
 * flipH?: 
 *
 * flipV?: 
 *
 * shadow?: 
 *
 * radius?: 
 *
 * colorMask?: 
 *
 * imageType?: 
 */
export interface PPTImageElement extends PPTBaseElement {
  type: 'image';
  fixedRatio: boolean;
  src: string;
  outline?: PPTElementOutline;
  filters?: ImageElementFilters;
  clip?: ImageElementClip;
  flipH?: boolean;
  flipV?: boolean;
  shadow?: PPTElementShadow;
  radius?: number;
  colorMask?: string;
  imageType?: ImageType;
}

export type ShapeTextAlign = 'top' | 'middle' | 'bottom';

/**
 * 
 *
 * content: （HTML）
 *
 * defaultFontName: （HTML）
 *
 * defaultColor: （HTML）
 *
 * align: （）
 *
 * lineHeight?: （），1.5
 *
 * wordSpace?: ，0
 *
 * paragraphSpace?: ， 5px
 *
 * type: 
 */
export interface ShapeText {
  content: string;
  defaultFontName: string;
  defaultColor: string;
  align: ShapeTextAlign;
  lineHeight?: number;
  wordSpace?: number;
  paragraphSpace?: number;
  type?: TextType;
}

/**
 * 
 *
 * type: （shape）
 *
 * viewBox: SVGviewBox， [1000, 1000]  '0 0 1000 1000'
 *
 * path: ，SVG path  d 
 *
 * fixedRatio: 
 *
 * fill: ，
 *
 * gradient?: ，
 *
 * pattern?: ，
 *
 * outline?: 
 *
 * opacity?: 
 *
 * flipH?: 
 *
 * flipV?: 
 *
 * shadow?: 
 *
 * special?: （， L Q C A ，）
 *
 * text?: 
 *
 * pathFormula?: 
 * ， viewBox ， viewBox  path ，
 * ，， viewBox  path 
 *
 * keypoints?: 
 */
export interface PPTShapeElement extends PPTBaseElement {
  type: 'shape';
  viewBox: [number, number];
  path: string;
  fixedRatio: boolean;
  fill: string;
  gradient?: Gradient;
  pattern?: string;
  outline?: PPTElementOutline;
  opacity?: number;
  flipH?: boolean;
  flipV?: boolean;
  shadow?: PPTElementShadow;
  special?: boolean;
  text?: ShapeText;
  pathFormula?: ShapePathFormulasKeys;
  keypoints?: number[];
}

export type LinePoint = '' | 'arrow' | 'dot';

/**
 * 
 *
 * type: （line）
 *
 * start: （[x, y]）
 *
 * end: （[x, y]）
 *
 * style: （、、）
 *
 * color: 
 *
 * points: （[, ]，：、、）
 *
 * shadow?: 
 *
 * broken?: （[x, y]）
 *
 * broken2?: （[x, y]）
 *
 * curve?: （[x, y]）
 *
 * cubic?: （[[x1, y1], [x2, y2]]）
 */
export interface PPTLineElement extends Omit<PPTBaseElement, 'height' | 'rotate'> {
  type: 'line';
  start: [number, number];
  end: [number, number];
  style: LineStyleType;
  color: string;
  points: [LinePoint, LinePoint];
  shadow?: PPTElementShadow;
  broken?: [number, number];
  broken2?: [number, number];
  curve?: [number, number];
  cubic?: [[number, number], [number, number]];
}

export type ChartType = 'bar' | 'column' | 'line' | 'pie' | 'ring' | 'area' | 'radar' | 'scatter';

export interface ChartOptions {
  lineSmooth?: boolean;
  stack?: boolean;
}

export interface ChartData {
  labels: string[];
  legends: string[];
  series: number[][];
}

/**
 * 
 *
 * type: （chart）
 *
 * fill?: 
 *
 * chartType: （bar/line/pie），
 *
 * data: 
 *
 * options: 
 *
 * outline?: 
 *
 * themeColors: 
 *
 * textColor?: 
 *
 * lineColor?: 
 */
export interface PPTChartElement extends PPTBaseElement {
  type: 'chart';
  fill?: string;
  chartType: ChartType;
  data: ChartData;
  options?: ChartOptions;
  outline?: PPTElementOutline;
  themeColors: string[];
  textColor?: string;
  lineColor?: string;
}

export type TextAlign = 'left' | 'center' | 'right' | 'justify';
/**
 * 
 *
 * bold?: 
 *
 * em?: 
 *
 * underline?: 
 *
 * strikethrough?: 
 *
 * color?: 
 *
 * backcolor?: 
 *
 * fontsize?: 
 *
 * fontname?: 
 *
 * align?: 
 */
export interface TableCellStyle {
  bold?: boolean;
  em?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  backcolor?: string;
  fontsize?: string;
  fontname?: string;
  align?: TextAlign;
}

/**
 * 
 *
 * id: ID
 *
 * colspan: 
 *
 * rowspan: 
 *
 * text: 
 *
 * style?: 
 */
export interface TableCell {
  id: string;
  colspan: number;
  rowspan: number;
  text: string;
  style?: TableCellStyle;
}

/**
 * 
 *
 * color: 
 *
 * rowHeader: 
 *
 * rowFooter: 
 *
 * colHeader: 
 *
 * colFooter: 
 */
export interface TableTheme {
  color: string;
  rowHeader: boolean;
  rowFooter: boolean;
  colHeader: boolean;
  colFooter: boolean;
}

/**
 * 
 *
 * type: （table）
 *
 * outline: 
 *
 * theme?: 
 *
 * colWidths: ，[0.3, 0.5, 0.2]30%, 50%, 20%
 *
 * cellMinHeight: 
 *
 * data: 
 */
export interface PPTTableElement extends PPTBaseElement {
  type: 'table';
  outline: PPTElementOutline;
  theme?: TableTheme;
  colWidths: number[];
  cellMinHeight: number;
  data: TableCell[][];
}

/**
 * LaTeX（）
 *
 * type: （latex）
 *
 * latex: latex
 *
 * html: KaTeXHTML（）
 *
 * path: svg path（SVG，，）
 *
 * color: （SVG，，）
 *
 * strokeWidth: （SVG，，）
 *
 * viewBox: SVGviewBox（SVG，，）
 *
 * fixedRatio: （）
 *
 * align: （left/center/right，center）
 */
export interface PPTLatexElement extends PPTBaseElement {
  type: 'latex';
  latex: string;
  html?: string;
  path?: string;
  color?: string;
  strokeWidth?: number;
  viewBox?: [number, number];
  fixedRatio?: boolean;
  align?: 'left' | 'center' | 'right';
}

/**
 * 
 *
 * type: （video）
 *
 * src: 
 *
 * autoplay: 
 *
 * poster: 
 *
 * ext: ，
 */
export interface PPTVideoElement extends PPTBaseElement {
  type: 'video';
  src: string;
  autoplay: boolean;
  poster?: string;
  ext?: string;
}

/**
 * 
 *
 * type: （audio）
 *
 * fixedRatio: 
 *
 * color: 
 *
 * loop: 
 *
 * autoplay: 
 *
 * src: 
 *
 * ext: ，
 */
export interface PPTAudioElement extends PPTBaseElement {
  type: 'audio';
  fixedRatio: boolean;
  color: string;
  loop: boolean;
  autoplay: boolean;
  src: string;
  ext?: string;
}

export type PPTElement =
  | PPTTextElement
  | PPTImageElement
  | PPTShapeElement
  | PPTLineElement
  | PPTChartElement
  | PPTTableElement
  | PPTLatexElement
  | PPTVideoElement
  | PPTAudioElement;

export type AnimationType = 'in' | 'out' | 'attention';
export type AnimationTrigger = 'click' | 'meantime' | 'auto';

/**
 * 
 *
 * id: id
 *
 * elId: ID
 *
 * effect: 
 *
 * type: （、、）
 *
 * duration: 
 *
 * trigger: (click - 、meantime - 、auto - )
 */
export interface PPTAnimation {
  id: string;
  elId: string;
  effect: string;
  type: AnimationType;
  duration: number;
  trigger: AnimationTrigger;
}

export type SlideBackgroundType = 'solid' | 'image' | 'gradient';
export type SlideBackgroundImageSize = 'cover' | 'contain' | 'repeat';
export interface SlideBackgroundImage {
  src: string;
  size: SlideBackgroundImageSize;
}

/**
 * 
 *
 * type: （、、）
 *
 * color?: （）
 *
 * image?: 
 *
 * gradientType?: 
 */
export interface SlideBackground {
  type: SlideBackgroundType;
  color?: string;
  image?: SlideBackgroundImage;
  gradient?: Gradient;
}

export type TurningMode =
  | 'no'
  | 'fade'
  | 'slideX'
  | 'slideY'
  | 'random'
  | 'slideX3D'
  | 'slideY3D'
  | 'rotate'
  | 'scaleY'
  | 'scaleX'
  | 'scale'
  | 'scaleReverse';

export interface SectionTag {
  id: string;
  title?: string;
}

export type SlideType = 'cover' | 'contents' | 'transition' | 'content' | 'end';

/**
 * 
 *
 * id: ID
 *
 * viewportSize: 
 *
 * viewportRatio: 
 *
 * theme: 
 *
 * elements: 
 *
 * background?: 
 *
 * animations?: 
 *
 * turningMode?: 
 *
 * sectionTag?: 
 *
 * type?: 
 */
export interface Slide {
  id: string;
  viewportSize: number;
  viewportRatio: number;
  theme: SlideTheme;
  elements: PPTElement[];
  background?: SlideBackground;
  animations?: PPTAnimation[];
  turningMode?: TurningMode;
  sectionTag?: SectionTag;
  type?: SlideType;
}

/**
 * 
 *
 * backgroundColor: 
 *
 * themeColor: ，
 *
 * fontColor: 
 *
 * fontName: 
 */
export interface SlideTheme {
  backgroundColor: string;
  themeColors: string[];
  fontColor: string;
  fontName: string;
  outline?: PPTElementOutline;
  shadow?: PPTElementShadow;
}

export interface SlideTemplate {
  name: string;
  id: string;
  cover: string;
  origin?: string;
}

/**
 * @deprecated SlideData is deprecated, use Slide instead
 */
export interface SlideData {
  id: string;
  viewportSize: number;
  viewportRatio: number;
  theme: {
    themeColors: string[];
    fontColor: string;
    fontName: string;
    backgroundColor: string;
  };
  elements: PPTElement[];
  background?: SlideBackground;
  animations?: unknown[];
}
