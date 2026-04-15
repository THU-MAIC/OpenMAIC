// Non-professional designers can use this app to draw basic shapes: https://github.com/pipipi-pikachu/svgPathCreator

import { ShapePathFormulasKeys } from '@/lib/types/slides';

export interface ShapePoolItem {
  viewBox: [number, number];
  path: string;
  special?: boolean;
  pathFormula?: ShapePathFormulasKeys;
  outlined?: boolean;
  pptxShapeType?: string;
  title?: string;
  withborder?: boolean;
}

interface ShapeListItem {
  type: string;
  children: ShapePoolItem[];
}

export interface ShapePathFormula {
  editable?: boolean;
  defaultValue?: number[];
  range?: [number, number][];
  relative?: string[];
  getBaseSize?: ((width: number, height: number) => number)[];
  formula: (width: number, height: number, values?: number[]) => string;
}

export const SHAPE_PATH_FORMULAS: Record<string, ShapePathFormula> = {
  [ShapePathFormulasKeys.ROUND_RECT]: {
    editable: true,
    defaultValue: [0.125],
    range: [[0, 0.5]],
    relative: ['left'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
      return `M ${radius} 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${height - radius} Q ${width} ${height} ${width - radius} ${height} L ${radius} ${height} Q 0 ${height} 0 ${height - radius} L 0 ${radius} Q 0 0 ${radius} 0 Z`;
    },
  },
  [ShapePathFormulasKeys.CUT_RECT_DIAGONAL]: {
    editable: true,
    defaultValue: [0.2],
    range: [[0, 0.95]],
    relative: ['right'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
      return `M 0 ${height - radius} L 0 0 L ${width - radius} 0 L ${width} ${radius} L ${width} ${height} L ${radius} ${height} Z`;
    },
  },
  [ShapePathFormulasKeys.CUT_RECT_SINGLE]: {
    editable: true,
    defaultValue: [0.2],
    range: [[0, 1]],
    relative: ['right'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
      return `M 0 ${height} L 0 0 L ${width - radius} 0 L ${width} ${radius} L ${width} ${height} Z`;
    },
  },
  [ShapePathFormulasKeys.CUT_RECT_SAMESIDE]: {
    editable: true,
    defaultValue: [0.2],
    range: [[0, 0.5]],
    relative: ['left'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
      return `M 0 ${radius} L ${radius} 0 L ${width - radius} 0 L ${width} ${radius} L ${width} ${height} L 0 ${height} Z`;
    },
  },
  [ShapePathFormulasKeys.ROUND_RECT_DIAGONAL]: {
    editable: true,
    defaultValue: [0.125],
    range: [[0, 1]],
    relative: ['left'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
      return `M ${radius} 0 L ${width} 0 L ${width} ${height - radius} Q ${width} ${height} ${width - radius} ${height} L 0 ${height} L 0 ${radius} Q 0 0 ${radius} 0 Z`;
    },
  },
  [ShapePathFormulasKeys.ROUND_RECT_SINGLE]: {
    editable: true,
    defaultValue: [0.125],
    range: [[0, 1]],
    relative: ['right'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
      return `M 0 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${height} L 0 ${height} L 0 0 Z`;
    },
  },
  [ShapePathFormulasKeys.ROUND_RECT_SAMESIDE]: {
    editable: true,
    defaultValue: [0.125],
    range: [[0, 0.5]],
    relative: ['left'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
      return `M 0 ${radius} Q 0 0 ${radius} 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${height} L 0 ${height} Z`;
    },
  },
  [ShapePathFormulasKeys.CUT_ROUND_RECT]: {
    editable: true,
    defaultValue: [0.125],
    range: [[0, 0.5]],
    relative: ['left'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const radius = Math.min(width, height) * values![0];
      return `M ${radius} 0 L ${width - radius} 0 L ${width} ${radius} L ${width} ${height} L 0 ${height} L 0 ${radius} Q 0 0 ${radius} 0 Z`;
    },
  },
  [ShapePathFormulasKeys.MESSAGE]: {
    editable: true,
    range: [
      [0, 0.8],
      [0.1, 0.3],
    ],
    defaultValue: [0.3, 0.2],
    relative: ['left_bottom', 'bottom'],
    getBaseSize: [(width) => width, (width, height) => height],
    formula: (width, height, values) => {
      const point = width * values![0];
      const arrowWidth = width * 0.2;
      const arrowheight = height * values![1];
      return `M 0 0 L ${width} 0 L ${width} ${height - arrowheight} L ${point + arrowWidth} ${height - arrowheight} L ${point} ${height} L ${point} ${height - arrowheight} L 0 ${height - arrowheight} Z`;
    },
  },
  [ShapePathFormulasKeys.ROUND_MESSAGE]: {
    formula: (width, height) => {
      const radius = Math.min(width, height) * 0.125;
      const arrowWidth = Math.min(width, height) * 0.2;
      const arrowheight = Math.min(width, height) * 0.2;
      return `M 0 ${radius} Q 0 0 ${radius} 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${height - radius - arrowheight} Q ${width} ${height - arrowheight} ${width - radius} ${height - arrowheight} L ${width / 2} ${height - arrowheight} L ${width / 2 - arrowWidth} ${height} L ${width / 2 - arrowWidth} ${height - arrowheight} L ${radius} ${height - arrowheight} Q 0 ${height - arrowheight} 0 ${height - radius - arrowheight} L 0 ${radius} Z`;
    },
  },
  [ShapePathFormulasKeys.L]: {
    editable: true,
    defaultValue: [0.25],
    range: [[0.05, 1]],
    relative: ['left'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const lineWidth = Math.min(width, height) * values![0];
      return `M 0 0 L 0 ${height} L ${width} ${height} L ${width} ${height - lineWidth} L ${lineWidth} ${height - lineWidth} L ${lineWidth} 0 Z`;
    },
  },
  [ShapePathFormulasKeys.RING_RECT]: {
    editable: true,
    defaultValue: [0.25],
    range: [[0.05, 0.5]],
    relative: ['left'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const lineWidth = Math.min(width, height) * values![0];
      return `M 0 0 ${width} 0 ${width} ${height} L 0 ${height} L 0 0 Z M ${lineWidth} ${lineWidth} L ${lineWidth} ${height - lineWidth} L ${width - lineWidth} ${height - lineWidth} L ${width - lineWidth} ${lineWidth} Z`;
    },
  },
  [ShapePathFormulasKeys.DONUT]: {
    editable: true,
    defaultValue: [0.25],
    range: [[0.05, 0.5]],
    relative: ['left'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const lineWidth = Math.min(width, height) * values![0];
      const cx = width / 2;
      const cy = height / 2;
      const rxOuter = width / 2;
      const ryOuter = height / 2;
      const rxInner = rxOuter - lineWidth;
      const ryInner = ryOuter - lineWidth;

      return `M ${cx - rxOuter} ${cy} A ${rxOuter} ${ryOuter} 0 1 1 ${cx - rxOuter} ${cy + 1} Z M ${cx + rxInner} ${cy} A ${rxInner} ${ryInner} 0 1 0 ${cx + rxInner} ${cy + 1} Z`;
    },
  },
  [ShapePathFormulasKeys.DIAGSTRIPE]: {
    editable: true,
    defaultValue: [0.5],
    range: [[0, 0.95]],
    relative: ['left'],
    getBaseSize: [(width) => width],
    formula: (width, height, values) => {
      const point = Math.min(width, height) * values![0];
      if (width >= height) {
        const point2 = (width / height) * point;
        return `M ${width} 0 L ${point2} 0 L 0 ${point} L 0 ${height} Z`;
      }
      const point2 = (height / width) * point;
      return `M ${width} 0 L ${point} 0 L 0 ${point2} L 0 ${height} Z`;
    },
  },
  [ShapePathFormulasKeys.PLUS]: {
    editable: true,
    defaultValue: [0.6],
    range: [[0.05, 1]],
    relative: ['center'],
    getBaseSize: [(width, height) => Math.min(width, height)],
    formula: (width, height, values) => {
      const lineWidth = Math.min(width, height) * values![0];
      return `M ${width / 2 - lineWidth / 2} 0 L ${width / 2 - lineWidth / 2} ${height / 2 - lineWidth / 2} L 0 ${height / 2 - lineWidth / 2} L 0 ${height / 2 + lineWidth / 2} L ${width / 2 - lineWidth / 2} ${height / 2 + lineWidth / 2} L ${width / 2 - lineWidth / 2} ${height} L ${width / 2 + lineWidth / 2} ${height} L ${width / 2 + lineWidth / 2} ${height / 2 + lineWidth / 2} L ${width} ${height / 2 + lineWidth / 2} L ${width} ${height / 2 - lineWidth / 2} L ${width / 2 + lineWidth / 2} ${height / 2 - lineWidth / 2} L ${width / 2 + lineWidth / 2} 0 Z`;
    },
  },
  [ShapePathFormulasKeys.TRIANGLE]: {
    editable: true,
    defaultValue: [0.5],
    range: [[0, 1]],
    relative: ['left'],
    getBaseSize: [(width) => width],
    formula: (width, height, values) => {
      const vertex = width * values![0];
      return `M ${vertex} 0 L 0 ${height} L ${width} ${height} Z`;
    },
  },
  [ShapePathFormulasKeys.PARALLELOGRAM_LEFT]: {
    editable: true,
    defaultValue: [0.25],
    range: [[0, 0.95]],
    relative: ['left'],
    getBaseSize: [(width) => width],
    formula: (width, height, values) => {
      const point = width * values![0];
      return `M ${point} 0 L ${width} 0 L ${width - point} ${height} L 0 ${height} Z`;
    },
  },
  [ShapePathFormulasKeys.PARALLELOGRAM_RIGHT]: {
    editable: true,
    defaultValue: [0.25],
    range: [[0, 0.95]],
    relative: ['right'],
    getBaseSize: [(width) => width],
    formula: (width, height, values) => {
      const point = width * values![0];
      return `M 0 0 L ${width - point} 0 L ${width} ${height} L ${point} ${height} Z`;
    },
  },
  [ShapePathFormulasKeys.TRAPEZOID]: {
    editable: true,
    defaultValue: [0.25],
    range: [[0, 0.5]],
    relative: ['left'],
    getBaseSize: [(width) => width],
    formula: (width, height, values) => {
      const point = width * values![0];
      return `M ${point} 0 L ${width - point} 0 L ${width} ${height} L 0 ${height} Z`;
    },
  },
  [ShapePathFormulasKeys.BULLET]: {
    editable: true,
    defaultValue: [0.2],
    range: [[0, 1]],
    relative: ['top'],
    getBaseSize: [(width, height) => height],
    formula: (width, height, values) => {
      const point = height * values![0];
      return `M ${width / 2} 0 L 0 ${point} L 0 ${height} L ${width} ${height} L ${width} ${point} Z`;
    },
  },
  [ShapePathFormulasKeys.INDICATOR]: {
    editable: true,
    defaultValue: [0.2],
    range: [[0, 0.95]],
    relative: ['right'],
    getBaseSize: [(width) => width],
    formula: (width, height, values) => {
      const point = width * values![0];
      return `M ${width} ${height / 2} L ${width - point} 0 L 0 0 L ${point} ${height / 2} L 0 ${height} L ${width - point} ${height} Z`;
    },
  },
};

export const SHAPE_LIST: ShapeListItem[] = [
  {
    type: '',
    children: [
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
        pptxShapeType: 'rect',
      },
      {
        viewBox: [200, 200],
        path: 'M 50 0 L 150 0 Q 200 0 200 50 L 200 150 Q 200 200 150 200 L 50 200 Q 0 200 0 150 L 0 50 Q 0 0 50 0 Z',
        pathFormula: ShapePathFormulasKeys.ROUND_RECT,
        pptxShapeType: 'roundRect',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 200 L 0 0 L 150 0 L 200 50 L 200 200 Z',
        pathFormula: ShapePathFormulasKeys.CUT_RECT_SINGLE,
        pptxShapeType: 'snip1Rect',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 50 L 50 0 L 150 0 L 200 50 L 200 200 L 0 200 Z',
        pathFormula: ShapePathFormulasKeys.CUT_RECT_SAMESIDE,
        pptxShapeType: 'snip2SameRect',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 150 L 0 0 L 150 0 L 200 50 L 200 200 L 50 200 Z',
        pathFormula: ShapePathFormulasKeys.CUT_RECT_DIAGONAL,
        pptxShapeType: 'snip2DiagRect',
      },
      {
        viewBox: [200, 200],
        path: 'M 50 0 L 150 0 L 200 50 L 200 200 L 0 200 L 0 50 Q 0 0 50 0 Z',
        pathFormula: ShapePathFormulasKeys.CUT_ROUND_RECT,
        pptxShapeType: 'snipRoundRect',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 150 0 Q 200 0 200 50 L 200 200 L 0 200 L 0 0 Z',
        pathFormula: ShapePathFormulasKeys.ROUND_RECT_SINGLE,
        pptxShapeType: 'round1Rect',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 50 Q 0 0 50 0 L 150 0 Q 200 0 200 50 L 200 200 L 0 200 Z',
        pathFormula: ShapePathFormulasKeys.ROUND_RECT_SAMESIDE,
        pptxShapeType: 'round2SameRect',
      },
      {
        viewBox: [200, 200],
        path: 'M 50 0 L 200 0 L 200 150 Q 200 200 150 200 L 0 200 L 0 50 Q 0 0 50 0 Z',
        pathFormula: ShapePathFormulasKeys.ROUND_RECT_DIAGONAL,
        pptxShapeType: 'round2DiagRect',
      },
    ],
  },

  {
    type: '',
    children: [
      {
        viewBox: [200, 200],
        path: 'M 100 0 A 50 50 0 1 1 100 200 A 50 50 0 1 1 100 0 Z',
        pptxShapeType: 'ellipse',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 0 200 L 200 200 L 100 0 Z',
        pathFormula: ShapePathFormulasKeys.TRIANGLE,
        pptxShapeType: 'triangle',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 0 200 L 200 200 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 70 20 L 0 160 Q 0 200 40 200 L 160 200 Q 200 200 200 160 L 130 20 Q 100 -20 70 20 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 50 0 L 200 0 L 150 200 L 0 200 L 50 0 Z',
        pathFormula: ShapePathFormulasKeys.PARALLELOGRAM_LEFT,
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 150 0 L 200 200 L 50 200 L 0 0 Z',
        pathFormula: ShapePathFormulasKeys.PARALLELOGRAM_RIGHT,
      },
      {
        viewBox: [200, 200],
        path: 'M 50 0 L 150 0 L 200 200 L 0 200 L 50 0 Z',
        pathFormula: ShapePathFormulasKeys.TRAPEZOID,
        pptxShapeType: 'trapezoid',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 0 100 L 100 200 L 200 100 L 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 0 50 L 0 200 L 200 200 L 200 50 L 100 0 Z',
        pathFormula: ShapePathFormulasKeys.BULLET,
      },
      {
        viewBox: [200, 200],
        path: 'M 200 100 L 150 0 L 0 0 L 50 100 L 0 200 L 150 200 L 200 100 Z',
        pathFormula: ShapePathFormulasKeys.INDICATOR,
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 C 80 20 120 20 200 0 C 180 80 180 120 200 200 C 80 180 120 180 0 200 C 20 120 20 80 0 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 10 10 C 60 0 140 0 190 10 C 200 60 200 140 190 190 C 140 200 60 200 10 190 C 0 140 0 60 10 10 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 200 A 50 100 0 1 1 200 200 L 0 200 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 40 20 A 100 100 0 1 0 200 100 L 100 100 L 40 20 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 A 100 100 102 1 0 200 100 L 100 100 L 100 0 Z',
        pptxShapeType: 'pie',
      },
      {
        viewBox: [200, 200],
        path: 'M 160 20 A 100 100 0 1 0 200 100 L 100 100 L 160 20 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 A 100 100 102 1 0 200 100 L 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 A 100 100 102 1 0 200 100 L 200 0 L 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 200 0 Q 200 200 0 200 L 0 0 Z',
      },
      {
        viewBox: [200, 200],
        path: `M100,0 L200,76.6 L161.8,200 L38.2,200 L0,76.6 Z`,
      },
      {
        viewBox: [200, 200],
        path: 'M 40 0 L 160 0 L 200 100 L 160 200 L 40 200 L 0 100 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 0 60 L 0 140 L 100 200 L 200 140 L 200 60 L 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: `M100,0 L170.71,29.29 L200,100 L170.71,170.71 L100,200 L29.29,170.71 L0,100 L29.29,29.29 Z`,
      },
      {
        viewBox: [200, 200],
        path: 'M 60 0 L 140 0 L 200 60 L 200 140 L 140 200 L 60 200 L 0 140 L 0 60 L 60 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 75 0 L 125 0 L 175 25 L 200 75 L 200 125 L 175 175 L 125 200 L 75 200 L 25 175 L 0 125 L 0 75 L 25 25 L 75 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 150 0 A 50 100 0 1 1 150 200 L 0 200 L 0 0 L 150 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 50 0 A 25 50 0 1 0 50 200 L 150 200 A 25 50 0 1 0 150 0 L 50 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 150 0 A 50 100 0 1 1 150 200 L 0 200 A 50 100 0 0 0 0 0 L 150 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 200 0 L 200 200 L 0 200 L 0 100 L 200 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 200 100 L 200 200 L 0 200 L 0 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 200 0 L 200 150 C 110 140 110 240 0 180 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 200 0 L 100 0 L 0 100 L 0 200 L 200 0 Z',
        pathFormula: ShapePathFormulasKeys.DIAGSTRIPE,
        pptxShapeType: 'diagStripe',
      },
      {
        viewBox: [200, 200],
        path: 'M 50 0 L 150 0 L 150 50 L 200 50 L 200 150 L 150 150 L 150 200 L 50 200 L 50 150 L 0 150 L 0 50 L 50 50 L 50 0 Z',
        pathFormula: ShapePathFormulasKeys.PLUS,
        pptxShapeType: 'plus',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 0 200 L 200 200 L 200 140 L 60 140 L 60 0 L 0 0 Z',
        pathFormula: ShapePathFormulasKeys.L,
        pptxShapeType: 'corner',
      },
      {
        viewBox: [200, 200],
        path: 'M0 0 L200 0 L200 200 L0 200 L0 0 Z M50 50 L50 150 L150 150 L150 50 Z',
        pathFormula: ShapePathFormulasKeys.RING_RECT,
        pptxShapeType: 'frame',
      },
      {
        viewBox: [200, 200],
        path: 'M0 100 A100 100 0 1 1 0 101 Z M150 100 A50 50 0 1 0 150 101 Z',
        pathFormula: ShapePathFormulasKeys.DONUT,
        pptxShapeType: 'donut',
      },
      {
        viewBox: [200, 200],
        path: 'M 70 0 L 70 70 L 0 70 L 0 130 L 70 130 L 70 200 L 130 200 L 130 130 L 200 130 L 200 70 L 130 70 L 130 0 L 70 0 Z',
        pptxShapeType: 'mathPlus',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 70 L 200 70 L 200 130 L 0 130 Z',
        pptxShapeType: 'mathMinus',
      },
      {
        viewBox: [200, 200],
        path: 'M 40 0 L 0 40 L 60 100 L 0 160 L 40 200 L 100 140 L 160 200 L 200 160 L 140 100 L 200 40 L 160 0 L 100 60 L 40 0 Z',
        pptxShapeType: 'mathMultiply',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 80 L 200 80 L 200 120 L 0 120 Z M 100 0 A 25 25 0 1 1 100 50 A 25 25 0 1 1 100 0 M 100 200 A 25 25 0 1 1 100 150 A 25 25 0 1 1 100 200',
        pptxShapeType: 'mathDivide',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 30 L 200 30 L 200 80 L 0 80 Z M 0 120 L 200 120 L 200 170 L 0 170 Z',
        pptxShapeType: 'mathEqual',
      },
      {
        viewBox: [200, 200],
        path: 'M 120 0 L 170 0 L 150 40 L 200 40 L 200 80 L 130 80 L 110 120 L 200 120 L 200 160 L 90 160 L 70 200 L 20 200 L 40 160 L 0 160 L 0 120 L 60 120 L 80 80 L 0 80 L 0 40 L 100 40 Z',
        pptxShapeType: 'mathNotEqual',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 200 0 L 200 160 L 100 160 L 60 200 L 60 160 L 0 160 Z',
        pathFormula: ShapePathFormulasKeys.MESSAGE,
      },
      {
        viewBox: [200, 200],
        path: 'M 0 40 Q 0 0 40 0 L 160 0 Q 200 0 200 40 L 200 120 Q 200 160 160 160 L 100 160 L 60 200 L 60 160 L 40 160 Q 0 160 0 120 L 0 40 Z',
        pathFormula: ShapePathFormulasKeys.ROUND_MESSAGE,
      },
      {
        viewBox: [200, 200],
        path: 'M 180 160 A 100 100 0 1 0 100 200 L 200 200 L 200 160 L 180 160 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 200 0 L 0 0 L 200 200 L 0 200 L 200 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 20 C 60 60 140 -40 200 20 L 200 180 C 140 140 60 240 0 180 L 0 20 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 20 C 40 -40 60 60 100 20 C 140 -40 160 60 200 20 L 200 180 C 140 240 160 140 100 180 C 40 240 60 140 0 180 L 0 20 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 Q 0 50 0 175 Q 100 225 200 175 Q 200 50 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 100 A 50 50 0 1 1 200 100 L 100 200 L 0 100 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 120 80 L 200 100 L 120 120 L 100 200 L 80 120 L 0 100 L 80 80 L 100 0 Z',
      },
      {
        viewBox: [1024, 1024],
        path: 'M1018.67652554 400.05983681l-382.95318779-5.89158658L512 34.78141155 388.27666225 394.16825023l-382.95318779 5.89158658L311.68602415 629.83174977l-117.83174978 365.27842665 312.25413766-223.88032637 312.25413904 223.88032637-117.83175116-365.27842665 318.14572563-229.77191296z',
        special: true,
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 60 60 L 0 100 L 60 140 L 100 200 L 140 140 L 200 100 L 140 60 L 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 140 60 L 200 60 L 160 100 L 200 140 L 140 140 L 100 200 L 60 140 L 0 140 L 40 100 L 0 60 L 60 60 L 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 130 30 L 170 30 L 170 70 L 200 100 L 170 130 L 170 170 L 130 170 L 100 200 L 70 170 L 30 170 L 30 130 L 0 100 L 30 70 L 30 30 L 70 30 L 100 0',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 A 50 50 0 1 0 200 120 A 100 100 0 1 1 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 120 0 L 100 80 L 200 80 L 80 200 L 100 120 L 0 120 L 120 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 30 50 Q 40 -20 120 10 Q 180 -10 180 40 Q 210 70 190 100 C 210 140 180 170 160 170 Q 140 210 100 180 C 70 210 20 190 30 150 C -10 140 -10 80 30 50',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 0 100 L 100 200 L 200 100 L 100 0 Z M 200 100 L 0 100',
        withborder: true,
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 A 50 50 0 1 1 100 200 A 50 50 0 1 1 100 0 Z M 170 30 L 30 170',
        withborder: true,
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 A 50 50 0 1 1 100 200 A 50 50 0 1 1 100 0 Z M 30 30 L 170 170',
        withborder: true,
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 A 50 50 0 1 1 100 200 A 50 50 0 1 1 100 0 Z M 170 30 L 30 170 M 30 30 L 170 170',
        withborder: true,
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 A 50 50 0 1 1 100 200 A 50 50 0 1 1 100 0 Z M 200 100 L 0 100 M 100 0 L 100 200',
        withborder: true,
      },
      {
        viewBox: [200, 200],
        path: 'M 160 0 A 40 100 0 1 1 160 200 L 40 200 A 40 100 0 1 1 40 0 L 160 0 Z M 160 200 A 40 100 0 1 1 160 0',
        withborder: true,
        pptxShapeType: 'flowChartMagneticDrum',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 40 A 50 20 0 1 1 200 40 L 200 160 A 50 20 0 1 1 0 160 L 0 40 Z M 200 40 A 50 20 0 1 1 0 40',
        withborder: true,
      },
      {
        viewBox: [200, 200],
        path: 'M 200 0 L 50 0 L 0 50 L 0 200 L 150 200 L 200 150 L 200 0 Z M 200 0 L 150 50 M 150 50 L 0 50 M 150 50 L 150 200',
        withborder: true,
      },
    ],
  },

  {
    type: '',
    children: [
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 0 100 L 50 100 L 50 200 L 150 200 L 150 100 L 200 100 L 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 200 L 200 100 L 150 100 L 150 0 L 50 0 L 50 100 L 0 100 L 100 200 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 100 L 100 0 L 100 50 L 200 50 L 200 150 L 100 150 L 100 200 L 0 100 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 200 100 L 100 0 L 100 50 L 0 50 L 0 150 L 100 150 L 100 200 L 200 100 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 0 60 L 60 60 L 60 140 L 0 140 L 100 200 L 200 140 L 140 140 L 140 60 L 200 60 L 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 100 L 60 0 L 60 60 L 140 60 L 140 0 L 200 100 L 140 200 L 140 140 L 60 140 L 60 200 L 0 100 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 100 0 L 60 40 L 80 40 L 80 80 L 40 80 L 40 60 L 0 100 L 40 140 L 40 120 L 80 120 L 80 160 L 60 160 L 100 200 L 140 160 L 120 160 L 120 120 L 160 120 L 160 140 L 200 100 L 160 60 L 160 80 L 120 80 L 120 40 L 140 40 L 100 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 100 L 100 0 L 100 50 L 200 50 L 150 100 L 200 150 L 100 150 L 100 200 L 0 100 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 200 100 L 100 0 L 100 50 L 0 50 L 50 100 L 0 150 L 100 150 L 100 200 L 200 100 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 100 L 80 20 L 80 80 L 120 80 L 120 0 L 200 0 L 200 200 L 120 200 L 120 120 L 80 120 L 80 180 L 0 100 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 200 100 L 120 20 L 120 80 L 80 80 L 80 0 L 0 0 L 0 200 L 80 200 L 80 120 L 120 120 L 120 180 L 200 100 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 120 0 L 200 100 L 120 200 L 0 200 L 80 100 L 0 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 80 0 L 200 0 L 120 100 L 200 200 L 80 200 L 0 100 L 80 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 140 0 L 200 100 L 140 200 L 0 200 L 0 100 L 0 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 60 0 L 200 0 L 200 100 L 200 200 L 60 200 L 0 100 L 60 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 200 100 L 0 200 L 60 100 L 0 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 200 0 L 0 100 L 200 200 L 140 100 L 200 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 0 L 80 0 L 200 100 L 80 200 L 0 200 L 120 100 L 0 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 200 0 L 120 0 L 0 100 L 120 200 L 200 200 L 80 100 L 200 0 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 200 L 180 200 L 180 40 L 200 40 L 160 0 L 120 40 L 140 40 L 140 160 L 0 160 L 0 200 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 0 200 L 0 20 L 160 20 L 160 0 L 200 40 L 160 80 L 160 60 L 40 60 L 40 200 L 0 200 Z',
      },
      {
        viewBox: [200, 200],
        path: 'M 40 180 L 180 180 L 180 40 L 200 40 L 160 0 L 120 40 L 140 40 L 140 140 L 40 140 L 40 120 L 0 160 L 40 200 L 40 180 Z',
      },
      {
        viewBox: [1024, 1024],
        path: 'M398.208 302.912V64L0 482.112l398.208 418.176V655.36c284.48 0 483.584 95.552 625.792 304.64-56.896-298.688-227.584-597.312-625.792-657.088z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M625.792 302.912V64L1024 482.112l-398.208 418.176V655.36C341.312 655.36 142.208 750.912 0 960c56.896-298.688 227.584-597.312 625.792-657.088z',
        special: true,
      },
    ],
  },

  {
    type: '',
    children: [
      {
        viewBox: [1024, 1024],
        path: 'M995.336 243.4016c-15.7584-36.5736-38.3376-69.26639999-66.91440001-97.37280001-28.5768-27.98879999-61.73999999-49.8624-98.78399999-65.26799998-38.22-15.876-78.6744-23.8728-120.4224-23.87280001-57.97680001 0-114.5424 15.876-163.69919999 45.864-11.76 7.17360001-22.932 15.05279999-33.51600001 23.63760001-10.584-8.5848-21.75600001-16.46400001-33.51600001-23.63760001-49.1568-29.98799999-105.7224-45.86399999-163.69919999-45.864-41.74799999 0-82.2024 7.9968-120.4224 23.87280001-36.9264 15.28799999-70.2072 37.27919999-98.78399999 65.26799998-28.6944 28.10640001-51.156 60.79919999-66.91440001 97.37280001-16.34639999 37.9848-24.696 78.3216-24.696 119.83439999 0 39.1608 7.9968 79.96800001 23.8728 121.48080001 13.28880001 34.692 32.34000001 70.67760001 56.6832 107.016 38.57279999 57.5064 91.61040001 117.4824 157.4664 178.28160001 109.1328 100.78319999 217.2072 170.4024 221.79359999 173.22479998l27.87120001 17.8752c12.348 7.8792 28.224 7.8792 40.572 0l27.87119999-17.8752c4.58639999-2.94 112.54319999-72.44159999 221.79360001-173.22479998 65.85599999-60.79919999 118.89359999-120.7752 157.4664-178.28160001 24.3432-36.33839999 43.512-72.324 56.68319999-107.016 15.876-41.5128 23.8728-82.32 23.87280001-121.48080001 0.1176-41.5128-8.232-81.8496-24.5784-119.83439999z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M985.20746667 343.50079998l-303.32586667-44.08319999L546.28693333 24.5248c-3.70346666-7.5264-9.79626667-13.6192-17.32266665-17.32266668-18.87573334-9.3184-41.81333333-1.55306667-51.25120001 17.32266668L342.1184 299.41759999l-303.32586667 44.08319999c-8.36266667 1.19466667-16.00853333 5.13706667-21.8624 11.11040001-14.69440001 15.17226667-14.45546667 39.30453334 0.71679999 54.1184l219.46026668 213.9648-51.84853333 302.1312c-1.43359999 8.24320001-0.11946667 16.8448 3.82293333 24.25173333 9.79626667 18.6368 32.9728 25.92426667 51.6096 16.00853334L512 822.44266665l271.3088 142.64320001c7.40693333 3.9424 16.00853333 5.25653333 24.25173333 3.82293333 20.78719999-3.584 34.7648-23.296 31.1808-44.0832l-51.84853333-302.1312 219.46026668-213.9648c5.97333334-5.85386666 9.91573333-13.49973334 11.11039999-21.8624 3.2256-20.90666667-11.34933333-40.26026667-32.256-43.36640001z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M852.65066667 405.84533333C800.54044445 268.40177778 667.76177778 170.66666667 512.22755555 170.66666667S223.91466667 268.288 171.80444445 405.73155555C74.29688889 431.33155555 2.27555555 520.07822222 2.27555555 625.77777778c0 125.72444445 101.83111111 227.55555555 227.44177778 227.55555555h564.56533334C919.89333333 853.33333333 1021.72444445 751.50222222 1021.72444445 625.77777778c0-105.472-71.79377778-194.21866667-169.07377778-219.93244445z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M926.25224691 323.7371485H654.6457886L898.88200917 15.14388241c5.05486373-6.53433603 0.49315743-16.02761669-7.76722963-16.02761668H418.30008701c-3.45210206 0-6.78091476 1.84934039-8.50696579 4.93157436L90.35039154 555.76772251c-3.82197013 6.53433603 0.86302552 14.7947231 8.50696578 14.79472311h215.01664245l-110.22068713 440.88274851c-2.34249783 9.61657002 9.24670194 16.39748478 16.39748477 9.49328065L933.03316167 340.62779071c6.41104668-6.0411786 2.09591911-16.8906422-6.78091476-16.89064221z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M878.47822222 463.30311111c-22.18666667-49.83466667-53.93066667-93.98044445-94.32177777-131.072l-33.10933334-30.37866666c-4.89244445-4.32355555-12.62933333-2.38933333-14.79111111 3.75466666l-14.79111111 42.43911111c-9.216 26.624-26.16888889 53.81688889-50.176 80.55466667-1.59288889 1.70666667-3.41333333 2.16177778-4.66488889 2.27555556-1.25155555 0.11377778-3.18577778-0.11377778-4.89244445-1.70666667-1.59288889-1.36533333-2.38933333-3.41333333-2.27555555-5.46133333 4.20977778-68.49422222-16.27022222-145.74933333-61.09866667-229.83111112C561.26577778 124.01777778 509.72444445 69.51822222 445.32622222 31.51644445l-46.99022222-27.648c-6.144-3.64088889-13.99466667 1.13777778-13.65333333 8.30577777l2.50311111 54.61333333c1.70666667 37.31911111-2.61688889 70.31466667-12.85688889 97.73511112-12.51555555 33.56444445-30.49244445 64.73955555-53.47555556 92.72888888-16.15644445 19.56977778-34.24711111 37.20533333-54.04444444 52.45155556-47.90044445 36.75022222-87.38133333 84.65066667-114.11911111 138.24C125.72444445 502.10133333 111.50222222 562.74488889 111.50222222 623.50222222c0 53.70311111 10.58133333 105.69955555 31.51644445 154.73777778 20.25244445 47.21777778 49.152 89.77066667 85.90222222 126.17955555 36.864 36.40888889 79.64444445 65.08088889 127.31733333 84.992C405.61777778 1010.11911111 457.95555555 1020.58666667 512 1020.58666667s106.38222222-10.46755555 155.76177778-31.06133334c47.67288889-19.91111111 90.56711111-48.46933333 127.31733333-84.992 36.864-36.40888889 65.76355555-78.96177778 85.90222222-126.17955555 20.93511111-49.03822222 31.51644445-101.03466667 31.51644445-154.73777778 0-55.52355555-11.37777778-109.45422222-34.01955556-160.31288889z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M968.20337778 20.11591112H705.44042667c-22.17301333 0-41.92483556 15.16430222-47.14951111 37.33731555C642.36202666 124.73685332 582.08711111 173.03324444 512 173.03324444s-130.36202666-48.29639112-146.29091556-115.58001777c-5.22467555-22.17301333-24.84906667-37.33731556-47.14951111-37.33731555H55.79662222c-30.96576 0-56.06968889 25.10392889-56.06968888 56.06968888v321.12639999c0 30.96576 25.10392889 56.06968889 56.06968888 56.06968889h95.57333334v494.43271112c0 30.96576 25.10392889 56.06968889 56.06968889 56.06968888h609.1207111c30.96576 0 56.06968889-25.10392889 56.06968889-56.06968888V453.38168888h95.57333334c30.96576 0 56.06968889-25.10392889 56.06968888-56.06968889V76.1856c0-30.96576-25.10392889-56.06968889-56.06968888-56.06968888z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M980.94648889 239.80714666H523.46880001L373.99210666 96.82944c-1.91146667-1.78403556-4.46008889-2.80348444-7.00871111-2.80348445H43.05351111c-22.55530667 0-40.77795555 18.22264888-40.77795555 40.77795557v754.39217776c0 22.55530667 18.22264888 40.77795555 40.77795555 40.77795557h937.89297778c22.55530667 0 40.77795555-18.22264888 40.77795555-40.77795557V280.58510222c0-22.55530667-18.22264888-40.77795555-40.77795555-40.77795556z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M972.60904597 164.57058577L841.30587843 33.39070759c-18.86327195-18.86327195-44.1375906-29.34286748-70.64480282-29.3428675-26.75379095 0-51.90482023 10.47959553-70.76809219 29.3428675L558.60337778 174.68031322c-18.86327195 18.86327195-29.34286748 44.1375906-29.34286749 70.64480283 0 26.75379095 10.47959553 51.90482023 29.34286749 70.76809218l103.31648301 103.31648302c-24.28800376 53.50758189-57.69942011 101.59043198-99.24793416 143.13894603-41.42522469 41.67180341-89.63136414 75.08321976-143.13894603 99.61780223L316.21649759 558.84995649c-18.86327195-18.86327195-44.1375906-29.34286748-70.64480283-29.34286747-26.75379095 0-51.90482023 10.47959553-70.76809217 29.34286747L33.39070759 700.01627278c-18.86327195 18.86327195-29.34286748 44.1375906-29.3428675 70.76809217 0 26.75379095 10.47959553 51.90482023 29.3428675 70.76809219l131.05658883 131.05658883c30.08260365 30.205893 71.63111769 47.34311394 114.28923598 47.34311394 9.00012323 0 17.63037836-0.73973616 26.13734414-2.21920846 166.19405621-27.37023774 331.03192945-115.76870829 464.06114804-248.67463751C901.84095379 636.27567408 990.11613498 471.56109018 1017.85624079 304.87387654c8.38367642-50.91850535-8.50696579-103.31648302-45.24719482-140.30329077z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M910.60451556 640.96028445c-20.38897778-65.49959112-43.83630221-120.54983112-79.89930667-210.64362666C836.31217778 193.67708444 737.93535999 2.27555556 511.36284444 2.27555556 282.24170667 2.27555556 186.03121778 197.50001778 192.14791111 430.31665779c-36.19043555 90.22122667-59.51032888 144.88917333-79.89930667 210.64362666-43.32657778 139.53706668-29.30915556 197.26336001-18.60494222 198.53767111 22.9376 2.80348444 89.32920888-105.00323556 89.32920889-105.00323556 0 62.44124445 32.11264001 143.86972444 101.69002667 202.61546667-33.64181333 10.32192-109.20846222 38.10190221-91.24067556 68.55793777 14.52714667 24.59420444 250.01984 15.67402668 317.94062222 8.02816 67.92078222 7.64586667 303.41347556 16.56604444 317.94062223-8.02816 17.96778667-30.32860444-57.72629333-58.23601779-91.24067555-68.55793777 69.57738667-58.87317334 101.69002667-140.30165333 101.69002667-202.61546667 0 0 66.39160889 107.80672 89.32920888 105.00323556 10.83164445-1.40174222 24.84906667-59.12803556-18.47751111-198.53767111z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M1016.86992592 199.24764445c-37.13706667 16.01991111-77.55093333 27.54939259-119.17842962 32.03982222 42.96248889-25.60758518 75.60912592-66.02145185 91.02222222-114.08118519-39.68568889 23.66577778-84.58998518 41.02068148-131.31472593 50.00154074C819.53374815 126.79395555 765.76995555 101.79318518 706.18074075 101.79318518c-114.688 0-206.92385185 92.96402963-206.92385186 207.04521482 0 16.01991111 1.94180741 32.03982222 5.09724444 47.45291852-171.72859259-8.98085925-324.88865185-91.02222222-426.71217778-216.63288889-17.96171852 30.82619259-28.15620741 66.02145185-28.1562074 104.49351112 0 71.84687408 36.53025185 135.19834075 92.23585185 172.45677036-33.98162963-1.33499259-66.02145185-10.92266667-93.57084445-26.33576296v2.54862222c0 100.6098963 71.1186963 183.98625185 165.90317037 203.1616-17.3549037 4.49042963-35.92343703 7.03905185-54.49197037 7.03905185-13.47128889 0-26.2144-1.33499259-39.07887407-3.15543704C146.69748148 681.90814815 223.03478518 741.49736297 313.93564445 743.43917037c-71.1186963 55.7056-160.19911111 88.4736-256.9253926 88.4736-17.3549037 0-33.37481482-0.60681482-50.00154074-2.54862222C98.75911111 888.22518518 207.62168889 922.20681482 324.85831111 922.20681482 705.45256297 922.20681482 913.71140741 606.90583703 913.71140741 333.23235555c0-8.98085925 0-17.96171852-0.60681482-26.94257777 40.2925037-29.4912 75.60912592-66.02145185 103.76533333-107.04213333z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M917.96720197 1.08889505H106.03279803C53.56084718 1.08889505 9.37393998 45.27580225 9.37393998 97.74775309v5.52336372c0 19.33177108 8.28504494 41.42522469 22.0934536 55.23363205l331.40179753 392.15879462v325.87843379c0 16.57008987 8.28504494 30.37849854 22.09345359 35.90186098l209.88780469 104.94390299 2.76168121 2.76168121c27.61681602 11.04672615 55.23363335-8.28504494 55.23363335-38.66354218V550.66354348l331.40179753-392.15879462c35.90186097-41.42522469 30.37849854-102.18222047-11.04672616-135.32240022-11.04672615-13.80840865-33.14017975-22.0934536-55.23363335-22.09345359z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M491.70164031 97.48884502a25.89076502 25.89076502 0 0 1 40.59671938 0L745.66415762 367.01171317a25.89076502 25.89076502 0 0 0 30.49932208 7.72839349l208.00640948-89.14190458a25.89076502 25.89076502 0 0 1 35.56096592 29.06238339l-115.18801541 554.96855704A103.56306132 103.56306132 0 0 1 803.14165689 952.14301275H220.85834311a103.56306132 103.56306132 0 0 1-101.4011828-82.51387024l-115.18801541-554.96855704a25.89076502 25.89076502 0 0 1 35.54802012-29.06238339l208.01935528 89.14190458a25.89076502 25.89076502 0 0 0 30.49932208-7.72839349l213.36579793-269.52286815z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M643.02466884 387.7801525c19.85376751-88.69205333 33.718272-152.84087467 41.61900049-192.57389433C704.52292267 95.17283515 652.90057916 2.27555515 550.58614084 2.27555515c-92.26012484 0-138.59407685 45.84971417-165.91530666 137.49816969l-0.70087152 2.67605334c-16.40038399 74.13942085-41.47882668 131.61085116-74.6746315 172.73287031a189.06953915 189.06953915 0 0 1-143.04142182 70.44391902l-26.17434983 0.5606965C77.66380049 387.52529067 27.76177817 438.90551468 27.76177817 501.84374084V881.55022182c0 77.4144 62.25009818 140.17422182 139.05282766 140.17422303h492.82707951c101.23127467 0 191.59267516-63.995904 225.93535999-159.98976l102.37815468-286.22301868c26.04691951-72.82688-11.39234134-153.15945284-83.63303784-179.42300483a138.04612267 138.04612267 0 0 0-47.17499733-8.30850884H643.02466884z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M512 512c140.82958222 0 254.86222222-114.03264 254.86222222-254.86222222S652.82958222 2.27555555 512 2.27555555a254.78940445 254.78940445 0 0 0-254.86222222 254.86222223C257.13777778 397.96736 371.17041778 512 512 512z m0 72.81777778c-170.10232889 0-509.72444445 97.57582222-509.72444445 291.27111111v145.63555556h1019.4488889v-145.63555556c0-193.69528889-339.62211555-291.27111111-509.72444445-291.27111111z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M1019.81297778 564.50161779l-138.89991111-472.51456c-8.66531556-25.99594668-29.43658667-43.45400889-57.21656889-43.45400891s-50.33528889 15.67402668-59.00060446 41.66997334l-92.00526221 274.48661334H351.69166222L259.6864 90.33045333c-8.66531556-25.99594668-31.22062222-41.66997333-59.00060444-41.66997332s-50.33528889 17.33063112-57.2165689 43.45400887L4.69674667 564.50161779c-5.22467555 17.33063112 1.78403556 36.44529778 15.67402667 46.89464887l491.11950221 368.27591113 492.77610666-368.27591113c13.76256-10.32192 20.77127111-29.43658667 15.54659557-46.89464887z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M927.78951111 340.39277037c-12.01493333-47.81700741 12.01493333-124.03294815 89.08041481-150.97552592l-82.40545184-4.36906667s-31.19028148-109.22666667-174.27721483-118.9357037c-143.08693333-9.8304-236.65777778-3.64088889-236.65777777-3.6408889s106.07122963 67.47780741 63.5941926 187.74850371c-31.06891852 63.71555555-79.85682963 116.02299259-132.04290371 175.61220741-1.57771852 1.57771852-3.03407408 3.15543703-4.2477037 4.49042962C278.25493333 624.86755555 7.13007408 934.34311111 7.13007408 934.34311111c298.43152592 78.15774815 498.43768889-7.64586667 616.76657777-110.56165926 24.87940741-0.24272592 43.5693037-0.36408889 56.19105185-0.36408888 164.8109037 0 304.13558518-142.72284445 298.43152593-301.4656-3.88361482-109.1053037-38.71478518-133.74198518-50.72971852-181.5589926z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M997.8886764 504.17210418L537.2729208 43.89182982c-13.97838539-13.97838539-36.56745619-13.97838539-50.5458416 0L26.1113236 504.17210418c-13.41924998 13.41924998-21.02349164 31.64706454-21.02349163 50.65766867 0 39.47496036 32.09437288 71.56933323 71.56933324 71.56933323h48.53295408V954.83524937c0 19.79339373 15.99127289 35.78466661 35.78466663 35.78466662H440.43066677V740.12724968h125.24633315v250.49266631h297.34821416c19.79339373 0 35.78466661-15.99127289 35.78466663-35.78466662V626.39910608h48.53295408c19.01060414 0 37.23841869-7.49241457 50.65766869-21.02349163 27.84494371-27.95677079 27.84494371-73.24673948-0.11182708-101.20351027z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M1009.13013121 349.27572283L674.72427717 14.86986879c-8.82158299-8.82158299-20.35749924-13.16451618-31.89341544-13.16451618s-23.07183245 4.34293316-31.89341547 13.16451618L392.29790453 233.6451272c-16.5574327-1.90003326-33.25058207-2.71433322-49.94373146-2.71433324-99.34459624 0-198.68919249 32.70771543-280.25490606 98.12314628-20.90036589 16.69314938-22.52896582 48.04369819-3.66434987 67.04403081l246.59717401 246.59717401-292.33368895 292.06225564c-3.52863319 3.52863319-5.83581644 8.27871636-6.24296642 13.30023282l-4.61436649 50.48659809c-1.22144996 12.75736619 8.95729967 23.6146991 21.57894918 23.6146991 0.6785833 0 1.35716662 0 2.03574992-0.13571666l50.48659809-4.61436649c5.02151649-0.40714999 9.77159962-2.71433322 13.30023282-6.24296643l292.33368896-292.33368896 246.59717402 246.59717401c8.82158299 8.82158299 20.35749924 13.16451618 31.89341544 13.16451618 13.16451618 0 26.19331567-5.70009979 35.15061536-16.82886604 76.40848044-95.40881307 108.16617924-214.83947521 95.27309638-330.33435417l218.63954175-218.63954173c17.50744934-17.37173267 17.50744934-45.8722316 0-63.51539759z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M976.62005979 160.47737905c-0.39452595-0.39452595-80.35178503 78.64217259-239.47725131 237.50462156l-111.6508437-111.65084369 237.89914752-237.89914752c-125.19623464-75.35445635-286.03131335-56.02268482-390.31767264 48.26367449-81.92988882 81.92988882-112.57140424 200.15616502-83.37648398 310.09739626l2.36715569 8.81107954-372.82702222 372.69551356c-8.15353628 8.15353628-8.15353628 21.56741857 0 29.72095487l185.95323084 185.95323084c8.15353628 8.15353628 21.56741857 8.15353628 29.72095485 0l372.56400493-372.56400493 8.81107953 2.3671557c110.07273989 29.32642892 228.29901608-1.18357785 310.36041356-83.24497533 104.41786795-104.2863593 123.74963948-265.12143802 49.97328693-390.05465535z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M512 2.27555555C230.51377778 2.27555555 2.27555555 230.51377778 2.27555555 512s228.23822222 509.72444445 509.72444445 509.72444445 509.72444445-228.23822222 509.72444445-509.72444445S793.48622222 2.27555555 512 2.27555555z m220.16 343.26755556l-239.616 332.23111111c-14.44977778 20.13866667-44.37333333 20.13866667-58.82311111 0L291.84 481.16622222c-4.32355555-6.03022222 0-14.44977778 7.39555555-14.44977777h53.36177778c11.60533333 0 22.64177778 5.57511111 29.46844445 15.13244444l81.00977777 112.41244444 178.85866667-248.03555555c6.82666667-9.44355555 17.74933333-15.13244445 29.46844445-15.13244445H724.76444445c7.39555555 0 11.71911111 8.41955555 7.39555555 14.44977778z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M512 2.27555555C230.51377778 2.27555555 2.27555555 230.51377778 2.27555555 512s228.23822222 509.72444445 509.72444445 509.72444445 509.72444445-228.23822222 509.72444445-509.72444445S793.48622222 2.27555555 512 2.27555555z m218.45333333 537.03111112c0 5.00622222-4.096 9.10222222-9.10222222 9.10222222H302.64888889c-5.00622222 0-9.10222222-4.096-9.10222222-9.10222222v-54.61333334c0-5.00622222 4.096-9.10222222 9.10222222-9.10222222h418.70222222c5.00622222 0 9.10222222 4.096 9.10222222 9.10222222v54.61333334z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M512 2.27555555C230.51377778 2.27555555 2.27555555 230.51377778 2.27555555 512s228.23822222 509.72444445 509.72444445 509.72444445 509.72444445-228.23822222 509.72444445-509.72444445S793.48622222 2.27555555 512 2.27555555z m188.18844445 703.37422223l-75.09333334-0.34133333L512 570.48177778l-112.98133333 134.71288889-75.20711112 0.34133333c-5.00622222 0-9.10222222-3.98222222-9.10222222-9.10222222 0-2.16177778 0.79644445-4.20977778 2.16177778-5.91644445l148.02488889-176.35555555L316.87111111 337.92c-1.36533333-1.70666667-2.16177778-3.75466667-2.16177778-5.91644445 0-5.00622222 4.096-9.10222222 9.10222222-9.10222222l75.20711112 0.34133334L512 458.06933333l112.98133333-134.71288888 75.09333334-0.34133334c5.00622222 0 9.10222222 3.98222222 9.10222222 9.10222222 0 2.16177778-0.79644445 4.20977778-2.16177778 5.91644445L559.21777778 514.27555555l147.91111111 176.35555556c1.36533333 1.70666667 2.16177778 3.75466667 2.16177778 5.91644444 0 5.00622222-4.096 9.10222222-9.10222222 9.10222223z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M512 2.27555555C230.51377778 2.27555555 2.27555555 230.51377778 2.27555555 512s228.23822222 509.72444445 509.72444445 509.72444445 509.72444445-228.23822222 509.72444445-509.72444445S793.48622222 2.27555555 512 2.27555555z m218.45333333 537.03111112c0 5.00622222-4.096 9.10222222-9.10222222 9.10222222H548.40888889v172.94222222c0 5.00622222-4.096 9.10222222-9.10222222 9.10222222h-54.61333334c-5.00622222 0-9.10222222-4.096-9.10222222-9.10222222V548.40888889H302.64888889c-5.00622222 0-9.10222222-4.096-9.10222222-9.10222222v-54.61333334c0-5.00622222 4.096-9.10222222 9.10222222-9.10222222h172.94222222V302.64888889c0-5.00622222 4.096-9.10222222 9.10222222-9.10222222h54.61333334c5.00622222 0 9.10222222 4.096 9.10222222 9.10222222v172.94222222h172.94222222c5.00622222 0 9.10222222 4.096 9.10222222 9.10222222v54.61333334z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M512 2.27555555C230.51377778 2.27555555 2.27555555 230.51377778 2.27555555 512s228.23822222 509.72444445 509.72444445 509.72444445 509.72444445-228.23822222 509.72444445-509.72444445S793.48622222 2.27555555 512 2.27555555z m163.95377778 517.57511112L427.46311111 700.64355555c-1.59288889 1.13777778-3.41333333 1.70666667-5.34755556 1.70666667-5.00622222 0-9.10222222-4.096-9.10222222-9.10222222V331.88977778c0-1.93422222 0.56888889-3.75466667 1.70666667-5.34755556 2.95822222-4.096 8.64711111-5.00622222 12.74311111-2.048L675.95377778 505.17333333c0.79644445 0.56888889 1.47911111 1.25155555 2.048 2.048 2.95822222 3.98222222 2.048 9.67111111-2.048 12.62933334z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M512 2.27555555C230.51377778 2.27555555 2.27555555 230.51377778 2.27555555 512s228.23822222 509.72444445 509.72444445 509.72444445 509.72444445-228.23822222 509.72444445-509.72444445S793.48622222 2.27555555 512 2.27555555z m200.81777778 666.39644445l-32.54044445 44.37333333c-2.95822222 4.096-8.64711111 4.89244445-12.74311111 1.93422222L479.34577778 577.76355555c-2.38933333-1.70666667-3.75466667-4.43733333-3.75466667-7.39555555V257.13777778c0-5.00622222 4.096-9.10222222 9.10222222-9.10222223h54.72711112c5.00622222 0 9.10222222 4.096 9.10222222 9.10222223v281.6l162.24711111 117.30488889c4.096 2.84444445 5.00622222 8.53333333 2.048 12.62933333z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M981.10577778 314.48177778c-25.6-61.09866667-62.464-115.93955555-109.34044445-163.04355556-46.87644445-46.99022222-101.60355555-83.968-162.70222222-109.568C646.59911111 15.58755555 580.38044445 2.27555555 512 2.27555555h-2.27555555c-68.83555555 0.34133333-135.39555555 13.99466667-198.08711112 40.84622223-60.52977778 25.94133333-114.80177778 62.80533333-161.22311111 109.79555555-46.42133333 46.99022222-82.83022222 101.60355555-108.08888889 162.47466667C16.27022222 378.42488889 3.072 445.44 3.41333333 514.38933333c0.34133333 78.96177778 19.22844445 157.35466667 54.49955556 227.44177778v172.94222222c0 28.89955555 23.43822222 52.33777778 52.224 52.33777778h172.71466666c69.97333333 35.38488889 148.13866667 54.272 226.98666667 54.61333334h2.38933333c68.03911111 0 133.91644445-13.19822222 196.03911112-39.02577778 60.75733333-25.37244445 115.37066667-61.78133333 162.13333333-108.31644445 46.87644445-46.53511111 83.74044445-100.92088889 109.568-161.56444444 26.73777778-62.80533333 40.39111111-129.59288889 40.73244445-198.54222223 0.22755555-69.29066667-13.19822222-136.53333333-39.59466667-199.79377777zM284.89955555 566.61333333c-30.03733333 0-54.49955555-24.46222222-54.49955555-54.61333333s24.46222222-54.61333333 54.49955555-54.61333333 54.49955555 24.46222222 54.49955556 54.61333333-24.34844445 54.61333333-54.49955556 54.61333333z m227.10044445 0c-30.03733333 0-54.49955555-24.46222222-54.49955555-54.61333333s24.46222222-54.61333333 54.49955555-54.61333333 54.49955555 24.46222222 54.49955555 54.61333333-24.46222222 54.61333333-54.49955555 54.61333333z m227.10044445 0c-30.03733333 0-54.49955555-24.46222222-54.49955556-54.61333333s24.46222222-54.61333333 54.49955556-54.61333333 54.49955555 24.46222222 54.49955555 54.61333333-24.46222222 54.61333333-54.49955555 54.61333333z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M980.2224823 3.06251924H43.7775177c-22.52048353 0-40.71499847 18.19451494-40.71499846 40.71499846v936.4449646c0 22.52048353 18.19451494 40.71499847 40.71499846 40.71499846h936.4449646c22.52048353 0 40.71499847-18.19451494 40.71499846-40.71499846V43.7775177c0-22.52048353-18.19451494-40.71499847-40.71499846-40.71499846zM745.4750693 325.8561164l-267.95558363 371.52436096c-16.15876501 22.52048353-49.62140436 22.52048353-65.78016939 0L253.07805667 477.51948567c-4.83490607-6.74342161 0-16.15876501 8.27023406-16.15876499h59.67291961c12.97790576 0 25.31963967 6.23448413 32.95370188 16.92217123l90.59087157 125.70755774 200.01242995-277.37092701c7.63406221-10.56045272 19.84856175-16.92217125 32.95370189-16.92217124H737.20483524c8.27023407 0 13.10514012 9.41534338 8.27023406 16.158765z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M980.2224823 3.06251924H43.7775177c-22.52048353 0-40.71499847 18.19451494-40.71499846 40.71499846v936.4449646c0 22.52048353 18.19451494 40.71499847 40.71499846 40.71499846h936.4449646c22.52048353 0 40.71499847-18.19451494 40.71499846-40.71499846V43.7775177c0-22.52048353-18.19451494-40.71499847-40.71499846-40.71499846zM756.28999077 542.53624885c0 5.59831228-4.58043732 10.17874961-10.17874962 10.17874962H277.88875885c-5.59831228 0-10.17874961-4.58043732-10.17874962-10.17874962v-61.0724977c0-5.59831228 4.58043732-10.17874961 10.17874962-10.17874962h468.2224823c5.59831228 0 10.17874961 4.58043732 10.17874962 10.17874962v61.0724977z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M980.2224823 3.06251924H43.7775177c-22.52048353 0-40.71499847 18.19451494-40.71499846 40.71499846v936.4449646c0 22.52048353 18.19451494 40.71499847 40.71499846 40.71499846h936.4449646c22.52048353 0 40.71499847-18.19451494 40.71499846-40.71499846V43.7775177c0-22.52048353-18.19451494-40.71499847-40.71499846-40.71499846zM720.79160148 697.63494611c5.59831228 6.61618726 0.8906406 16.6677025-7.76129658 16.66770249h-74.94104404c-5.98001539 0-11.70556205-2.67192177-15.64982754-7.25235911L512 575.36271635l-110.43943332 131.68757314c-3.81703111 4.58043732-9.54257777 7.25235911-15.64982754 7.25235911H310.9696951c-8.65193717 0-13.35960887-10.05151525-7.76129658-16.66770249L458.81603326 512 303.20839852 326.36505389c-5.59831228-6.61618726-0.8906406-16.6677025 7.76129658-16.66770249h74.94104404c5.98001539 0 11.70556205 2.67192177 15.64982754 7.25235911L512 448.63728365l110.43943332-131.68757314c3.81703111-4.58043732 9.54257777-7.25235911 15.64982754-7.25235911H713.0303049c8.65193717 0 13.35960887 10.05151525 7.76129658 16.66770249L565.18396674 512l155.60763474 185.63494611z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M980.2224823 3.06251924H43.7775177c-22.52048353 0-40.71499847 18.19451494-40.71499846 40.71499846v936.4449646c0 22.52048353 18.19451494 40.71499847 40.71499846 40.71499846h936.4449646c22.52048353 0 40.71499847-18.19451494 40.71499846-40.71499846V43.7775177c0-22.52048353-18.19451494-40.71499847-40.71499846-40.71499846zM677.02297814 523.19662459L423.31764398 722.70011704c-9.41534338 7.37959347-23.28388974 0.76340622-23.28388975-11.19662459V312.62374191c0-11.9600308 13.86854636-18.70345241 23.28388975-11.19662457l253.70533416 199.37625807c7.25235911 5.72554666 7.25235911 16.6677025 0 22.39324918z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M980.2224823 3.06251924H43.7775177c-22.52048353 0-40.71499847 18.19451494-40.71499846 40.71499846v936.4449646c0 22.52048353 18.19451494 40.71499847 40.71499846 40.71499846h936.4449646c22.52048353 0 40.71499847-18.19451494 40.71499846-40.71499846V43.7775177c0-22.52048353-18.19451494-40.71499847-40.71499846-40.71499846zM756.28999077 542.53624885c0 5.59831228-4.58043732 10.17874961-10.17874962 10.17874962H552.71499847v193.39624268c0 5.59831228-4.58043732 10.17874961-10.17874962 10.17874962h-61.0724977c-5.59831228 0-10.17874961-4.58043732-10.17874962-10.17874962V552.71499847H277.88875885c-5.59831228 0-10.17874961-4.58043732-10.17874962-10.17874962v-61.0724977c0-5.59831228 4.58043732-10.17874961 10.17874962-10.17874962h193.39624268V277.88875885c0-5.59831228 4.58043732-10.17874961 10.17874962-10.17874962h61.0724977c5.59831228 0 10.17874961 4.58043732 10.17874962 10.17874962v193.39624268h193.39624268c5.59831228 0 10.17874961 4.58043732 10.17874962 10.17874962v61.0724977z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M902.67315697 135.41705551L528.62204754 7.94466448C524.10877635 6.40354749 518.05438818 5.63298899 512 5.63298899s-12.10877635 0.7705585-16.62204754 2.31167549L121.32684303 135.41705551c-9.13662215 3.08223399-16.62204754 13.64989334-16.62204753 23.33691443v531.02488283c0 9.68702108 6.27454775 22.45627614 13.87005291 28.51066431L498.0198673 1013.9638196c3.85279247 2.9721542 8.8063828 4.51327118 13.87005291 4.51327118s10.12734022-1.54111698 13.87005291-4.51327118l379.4450189-295.67430252c7.59550517-5.94430839 13.87005291-18.71356345 13.87005291-28.51066431V158.75396994c0.22015956-9.68702108-7.26526581-20.14460066-16.40188796-23.33691443zM712.89560763 323.43332829L478.86598471 645.63685899c-7.04510625 9.68702108-21.57563786 9.68702108-28.6207441 0l-139.14084824-191.5388259c-4.18303182-5.8342286 0-13.9801327 7.15518603-13.9801327h60.76404132c5.61406904 0 11.0079785 2.75199463 14.31037204 7.26526582l71.22162091 97.97100864 166.11039557-228.74579323c3.30239355-4.51327118 8.58622323-7.26526581 14.31037204-7.26526581H705.7404216c7.15518602 0.11007979 11.33821785 8.25598388 7.15518603 14.09021248z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M959.86498307 186.28001231H797.00498922v-101.78749614c0-44.91373267-36.51626425-81.42999692-81.42999691-81.42999693H308.42500769c-44.91373267 0-81.42999692 36.51626425-81.42999691 81.42999693v101.78749614H64.13501693c-22.52048353 0-40.71499847 18.19451494-40.71499846 40.71499847v40.71499845c0 5.59831228 4.58043732 10.17874961 10.17874961 10.17874962h76.8495596l31.42688945 665.43575611c2.03574992 43.38692024 37.91584233 77.61296581 81.30276254 77.6129658h577.64404066c43.5141546 0 79.26701262-34.09881122 81.30276254-77.6129658l31.42688945-665.43575611H990.40123192c5.59831228 0 10.17874961-4.58043732 10.17874961-10.17874962v-40.71499845c0-22.52048353-18.19451494-40.71499847-40.71499846-40.71499847z m-254.46874039 0H318.60375732v-91.60874653h386.79248536v91.60874653z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M980.2224823 248.62485371H654.50249462V104.85001539c0-22.52048353-18.19451494-40.71499847-40.71499847-40.71499846H94.67126578v-50.89374808c0-5.59831228-4.58043732-10.17874961-10.17874961-10.17874961h-71.25124732c-5.59831228 0-10.17874961 4.58043732-10.17874961 10.17874961v997.5174623c0 5.59831228 4.58043732 10.17874961 10.17874961 10.17874961h71.25124732c5.59831228 0 10.17874961-4.58043732 10.17874961-10.17874961V674.85999383h315.54123807v143.77483833c0 22.52048353 18.19451494 40.71499847 40.71499846 40.71499846h529.29497999c22.52048353 0 40.71499847-18.19451494 40.71499846-40.71499846V289.33985217c0-22.52048353-18.19451494-40.71499847-40.71499846-40.71499846z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M804.63905145 265.16532183V94.67126578h109.42155836c5.59831228 0 10.17874961-4.58043732 10.17874961-10.17874961v-71.25124732c0-5.59831228-4.58043732-10.17874961-10.17874961-10.17874961H109.93939019c-5.59831228 0-10.17874961 4.58043732-10.17874961 10.17874961v71.25124732c0 5.59831228 4.58043732 10.17874961 10.17874961 10.17874961h109.42155836v170.49405605c0 103.6960117 53.94737296 194.92305513 135.3773699 246.83467817-81.42999692 51.91162303-135.37736988 143.13866646-135.3773699 246.83467817v170.49405605h-109.42155836c-5.59831228 0-10.17874961 4.58043732-10.17874961 10.17874961v71.25124732c0 5.59831228 4.58043732 10.17874961 10.17874961 10.17874961h804.12121962c5.59831228 0 10.17874961-4.58043732 10.17874961-10.17874961v-71.25124732c0-5.59831228-4.58043732-10.17874961-10.17874961-10.17874961h-109.42155836V758.83467817c0-103.6960117-53.94737296-194.92305513-135.3773699-246.83467817 81.42999692-51.91162303 135.37736988-143.13866646 135.3773699-246.83467817z',
        special: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M1020.928 448.44373333l-35.36213334-373.4528c-1.79200001-19.3536-17.2032-34.64533332-36.55679999-36.55679999L575.55626667 3.072h-0.47786666c-3.82293334 0-6.8096 1.19466667-9.07946669 3.46453333L6.53653333 565.99893332c-4.65919999 4.65919999-4.65919999 12.1856 0 16.84480001l434.61973334 434.61973334c2.26986667 2.26986667 5.25653333 3.46453333 8.48213333 3.46453333s6.21226667-1.19466667 8.48213333-3.46453333l559.46239999-559.46239999c2.38933332-2.5088 3.584-5.97333334 3.34506668-9.55733335zM735.40266668 362.66666667c-42.17173333 0-76.45866667-34.28693333-76.45866667-76.45866667s34.28693333-76.45866667 76.45866667-76.45866667 76.45866667 34.28693333 76.45866665 76.45866667-34.28693333 76.45866667-76.45866665 76.45866667z',
        special: true,
      },
    ],
  },

  {
    type: '',
    children: [
      {
        viewBox: [1024, 1024],
        path: 'M1009.55537674 75.96950982l-61.38012212-61.38012214c-4.48769762-4.48769762-11.870684-4.48769762-16.3583816 0L14.44462326 931.67210859c-4.48769762 4.48769762-4.48769762 11.870684 0 16.35838159l61.38012212 61.38012214c4.48769762 4.48769762 11.870684 4.48769762 16.3583816 0L1009.41061232 92.18312698c4.63246205-4.34293316 4.63246205-11.72591956 0.14476442-16.21361716zM210.88996692 419.35075905c114.94296453 0 208.46079213-93.51782759 208.46079213-208.46079213s-93.51782759-208.46079213-208.46079213-208.4607921-208.46079213 93.51782759-208.4607921 208.4607921 93.51782759 208.46079213 208.4607921 208.46079213z m0-312.69118816c57.47148228 0 104.23039605 46.75891379 104.23039607 104.23039603s-46.75891379 104.23039605-104.23039607 104.23039607-104.23039605-46.75891379-104.23039603-104.23039607 46.75891379-104.23039605 104.23039603-104.23039603zM813.11003308 604.64924095c-114.94296453 0-208.46079213 93.51782759-208.46079213 208.46079213s93.51782759 208.46079213 208.46079213 208.4607921 208.46079213-93.51782759 208.4607921-208.4607921-93.51782759-208.46079213-208.4607921-208.46079213z m0 312.69118816c-57.47148228 0-104.23039605-46.75891379-104.23039607-104.23039603s46.75891379-104.23039605 104.23039607-104.23039607 104.23039605 46.75891379 104.23039603 104.23039607-46.75891379 104.23039605-104.23039603 104.23039603z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M1004.96017383 478.58365209L483.27851088 25.80594621c-4.00443838-3.45210207-9.11354943-5.3852792-14.49882864-5.38527921h-122.20441284c-10.21822208 0-14.91308089 12.70373557-7.18037228 19.33177152l483.57045622 419.77561022H14.8973037c-6.07569962 0-11.04672658 4.97102697-11.04672658 11.04672657v82.85044938c0 6.07569962 4.97102697 11.04672658 11.04672658 11.04672657h807.92996557L339.25681303 984.24756148c-7.7327086 6.76612003-3.0378498 19.33177153 7.18037229 19.33177152h126.34693531c2.62359757 0 5.24719513-0.96658859 7.18037228-2.76168164L1004.96017383 545.41634791c20.2983601-17.67476253 20.2983601-49.1579333 0-66.83269582z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M1011.38217956 558.9924242L545.80649025 22.43713295c-17.81503843-20.62055629-49.79794206-20.62055629-67.75325638 0L12.61782044 558.9924242c-6.31241519 7.29434645-1.12220714 18.51641789 8.41655359 18.51641789h113.62347344c6.45269109 0 12.62483038-2.80551785 16.97338308-7.71517411L458.69516062 215.87758959V1005.77114384c0 6.1721393 5.04993216 11.22207145 11.22207144 11.22207145h84.16553588c6.1721393 0 11.22207145-5.04993216 11.22207144-11.22207145V215.87758959l307.06393007 353.91607839c4.20827679 4.90965626 10.38041608 7.71517413 16.97338308 7.71517411h113.62347344c9.53876074 0 14.72896878-11.22207145 8.41655359-18.51641789z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M1009.1026963 459.52804874H201.17273073l483.57045624-419.77561022c7.7327086-6.76612003 3.0378498-19.33177153-7.18037229-19.33177152h-122.20441283c-5.3852792 0-10.49439025 1.93317715-14.49882866 5.38527921L19.03982617 478.58365209c-20.2983601 17.67476253-20.2983601 49.1579333 0 66.69461175L543.89742302 1000.81765136c2.07126124 1.79509307 4.55677472 2.76168163 7.18037228 2.76168164h126.3469353c10.21822208 0 14.91308089-12.70373557 7.18037228-19.33177152L201.17273073 564.47195126H1009.1026963c6.07569962 0 11.04672658-4.97102697 11.04672658-11.04672657v-82.85044938c0-6.07569962-4.97102697-11.04672658-11.04672658-11.04672657z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M1002.96562597 446.49115791h-113.62347344c-6.45269109 0-12.62483038 2.80551785-16.97338308 7.71517411L565.30483938 808.12241041V18.22885616c0-6.1721393-5.04993216-11.22207145-11.22207144-11.22207145h-84.16553588c-6.1721393 0-11.22207145 5.04993216-11.22207144 11.22207145v789.89355425L151.63123055 454.20633202c-4.20827679-4.90965626-10.38041608-7.71517413-16.97338308-7.71517411h-113.62347344c-9.53876074 0-14.72896878 11.36234735-8.41655359 18.51641789L478.19350975 1001.56286705c17.81503843 20.62055629 49.79794206 20.62055629 67.75325638 0L1011.38217956 465.0075758c6.31241519-7.29434645 1.12220714-18.51641789-8.41655359-18.51641789z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M975.82443246 622.46726585H14.8973037c-6.07569962 0-11.04672658 4.97102697-11.04672658 11.04672658v82.85044937c0 6.07569962 4.97102697 11.04672658 11.04672658 11.04672659h835.6848661L651.32683905 980.10503902c-5.66144737 7.18037229-0.55233633 17.9509307 8.69929718 17.9509307h100.11095967c6.76612003 0 13.11798782-3.0378498 17.39859437-8.42312903l233.08593092-295.63802022c22.78387358-28.99765728 2.20934532-71.52755463-34.79718873-71.52755462zM1009.1026963 296.58883161H173.4178302l199.25533075-252.69387063c5.66144737-7.18037229 0.55233633-17.9509307-8.69929718-17.9509307h-100.11095967c-6.76612003 0-13.11798782 3.0378498-17.39859437 8.42312903L13.37837881 330.00517953c-22.78387358 28.99765728-2.20934532 71.52755463 34.65910466 71.52755462h961.06521283c6.07569962 0 11.04672658-4.97102697 11.04672658-11.04672658v-82.85044937c0-6.07569962-4.97102697-11.04672658-11.04672658-11.04672659z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M1010.75873115 64.13501693H13.24126885c-5.59831228 0-10.17874961 4.58043732-10.17874961 10.17874961v81.42999691c0 5.59831228 4.58043732 10.17874961 10.17874961 10.17874964h997.5174623c5.59831228 0 10.17874961-4.58043732 10.17874961-10.17874964v-81.42999691c0-5.59831228-4.58043732-10.17874961-10.17874961-10.17874961zM1010.75873115 858.07748691H13.24126885c-5.59831228 0-10.17874961 4.58043732-10.17874961 10.17874964v81.42999691c0 5.59831228 4.58043732 10.17874961 10.17874961 10.17874961h997.5174623c5.59831228 0 10.17874961-4.58043732 10.17874961-10.17874961v-81.42999691c0-5.59831228-4.58043732-10.17874961-10.17874961-10.17874964zM1010.75873115 461.10625194H13.24126885c-5.59831228 0-10.17874961 4.58043732-10.17874961 10.17874959v81.42999694c0 5.59831228 4.58043732 10.17874961 10.17874961 10.17874959h997.5174623c5.59831228 0 10.17874961-4.58043732 10.17874961-10.17874959v-81.42999694c0-5.59831228-4.58043732-10.17874961-10.17874961-10.17874959z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M591.98717801 512l405.34042913-483.16579151c6.79427767-8.02960089 1.08090782-20.22841761-9.41933951-20.2284176h-123.22349044c-7.25752386 0-14.20621693 3.24272343-18.99309439 8.80167789L511.38233839 415.95362022 177.07299399 17.40746878c-4.63246205-5.55895447-11.58115512-8.80167789-18.99309439-8.80167789H34.85640916c-10.50024731 0-16.21361717 12.19881672-9.41933952 20.2284176L430.77749876 512 25.43706964 995.16579151c-6.79427767 8.02960089-1.08090782 20.22841761 9.41933952 20.2284176h123.22349044c7.25752386 0 14.20621693-3.24272343 18.99309439-8.80167789l334.3093444-398.54615144 334.30934441 398.54615144c4.63246205 5.55895447 11.58115512 8.80167789 18.99309439 8.80167789h123.22349044c10.50024731 0 16.21361717-12.19881672 9.41933951-20.2284176L591.98717801 512z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M953.5488 832.61667556c-24.08448-57.08913778-58.74574221-108.31644445-102.70947556-152.28017777-43.96373333-43.96373333-95.19104-78.49756444-152.28017777-102.70947558-0.50972445-0.25486222-1.01944888-0.38229333-1.52917334-0.63715555C776.41955556 519.64586667 828.02915556 426.23886221 828.02915556 320.85333332c0-174.58062221-141.44853334-316.02915556-316.02915556-316.02915554S195.97084444 146.27271111 195.97084444 320.85333332c0 105.38552889 51.6096 198.79253333 130.99918223 256.26396447-0.50972445 0.25486222-1.01944888 0.38229333-1.52917334 0.63715555-57.08913778 24.08448-108.31644445 58.61831112-152.28017777 102.70947554-43.96373333 43.96373333-78.49756444 95.19104-102.70947556 152.28017779C46.74901333 888.55893332 34.13333334 947.8144 32.85902222 1008.72647111c-0.12743111 5.7344 4.46008889 10.44935111 10.19448889 10.44935111h76.45866667c5.60696888 0 10.06705778-4.46008889 10.19448889-9.93962666 2.54862221-98.37681778 42.05226667-190.50951112 111.88451555-260.34176001 72.25344-72.25344 168.20906666-112.01194667 270.40881778-112.01194667s198.15537778 39.75850667 270.40881778 112.01194667C852.24106667 818.72668444 891.74471111 910.85937779 894.29333333 1009.23619556c0.12743111 5.60696888 4.58752 9.93962667 10.19448889 9.93962666h76.45866667c5.7344 0 10.32192-4.71495112 10.19448889-10.44935111-1.27431111-60.91207112-13.88999112-120.16753779-37.59217778-176.10979555zM512 540.03484444c-58.49088 0-113.54112-22.81016889-154.95623111-64.22527999S292.81848888 379.34421333 292.81848888 320.85333332c0-58.49088 22.81016889-113.54112 64.22528001-154.9562311S453.50912 101.67182221 512 101.67182221s113.54112 22.81016889 154.95623111 64.22528001S731.18151112 262.36245333 731.18151112 320.85333332c0 58.49088-22.81016889 113.54112-64.22528001 154.95623113S570.49088 540.03484444 512 540.03484444z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M985.31555555 111.50222222H38.68444445c-20.13866667 0-36.40888889 16.27022222-36.4088889 36.40888889v728.17777778c0 20.13866667 16.27022222 36.40888889 36.4088889 36.40888889h946.6311111c20.13866667 0 36.40888889-16.27022222 36.4088889-36.40888889V147.91111111c0-20.13866667-16.27022222-36.40888889-36.4088889-36.40888889z m-45.5111111 126.06577778V830.57777778H84.19555555V237.568l-31.40266666-24.46222222 44.71466666-57.45777778 48.6968889 37.888h731.70488888l48.69688889-37.888 44.71466667 57.45777778-31.51644444 24.46222222z M877.90933333 193.42222222L512 477.86666667 146.09066667 193.42222222l-48.69688889-37.888-44.71466667 57.45777778 31.40266667 24.46222222 388.66488889 302.19377778c22.98311111 17.86311111 55.18222222 17.86311111 78.16533333 0L939.80444445 237.568l31.40266666-24.46222222-44.71466666-57.45777778-48.58311112 37.77422222z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M985.31555555 88.74666667H38.68444445c-20.13866667 0-36.40888889 16.27022222-36.4088889 36.40888888v564.33777778c0 20.13866667 16.27022222 36.40888889 36.4088889 36.40888889h432.35555555v127.43111111H275.34222222c-10.01244445 0-18.20444445 8.192-18.20444444 18.20444445v54.61333333c0 5.00622222 4.096 9.10222222 9.10222222 9.10222222h491.52c5.00622222 0 9.10222222-4.096 9.10222222-9.10222222v-54.61333333c0-10.01244445-8.192-18.20444445-18.20444444-18.20444445H552.96V725.90222222h432.35555555c20.13866667 0 36.40888889-16.27022222 36.4088889-36.40888889V125.15555555c0-20.13866667-16.27022222-36.40888889-36.4088889-36.40888888z m-45.5111111 555.23555555H84.19555555V170.66666667h855.6088889v473.31555555z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M512 2.27555555C230.51377778 2.27555555 2.27555555 230.51377778 2.27555555 512s228.23822222 509.72444445 509.72444445 509.72444445 509.72444445-228.23822222 509.72444445-509.72444445S793.48622222 2.27555555 512 2.27555555z m0 932.97777778c-233.69955555 0-423.25333333-189.55377778-423.25333333-423.25333333 0-101.26222222 35.61244445-194.33244445 95.00444444-267.15022222l595.39911111 595.39911111C706.33244445 899.64088889 613.26222222 935.25333333 512 935.25333333z m328.24888889-156.10311111L244.84977778 183.75111111C317.66755555 124.35911111 410.73777778 88.74666667 512 88.74666667c233.69955555 0 423.25333333 189.55377778 423.25333333 423.25333333 0 101.26222222-35.61244445 194.33244445-95.00444444 267.15022222z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M901.80266667 257.82044445L656.95288889 12.97066667c-6.82666667-6.82666667-16.04266667-10.69511111-25.71377778-10.69511112H147.91111111c-20.13866667 0-36.40888889 16.27022222-36.40888889 36.4088889v946.6311111c0 20.13866667 16.27022222 36.40888889 36.40888889 36.4088889h728.17777778c20.13866667 0 36.40888889-16.27022222 36.40888889-36.4088889V283.648c0-9.67111111-3.86844445-19.00088889-10.69511111-25.82755555zM828.52977778 300.37333333H614.4V86.24355555L828.52977778 300.37333333z m2.048 639.43111112H193.42222222V84.19555555h343.60888889v245.76c0 26.39644445 21.39022222 47.78666667 47.78666667 47.78666667h245.76v562.06222223z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M981.07392 55.79662222H42.92608c-31.22062222 0-50.71758221 34.02410666-35.04355556 61.16693334L304.28728889 620.82616888V927.42542221c0 22.55530667 18.09521779 40.77795555 40.52309333 40.77795557h334.37923556c22.42787556 0 40.52309333-18.22264888 40.52309333-40.77795557V620.82616888L1016.24490667 116.96355556c15.54659555-27.14282666-3.95036444-61.16693333-35.17098667-61.16693334zM628.47203556 876.45297779H395.52796444V677.66044445h233.07150222v198.79253334z m12.23338666-301.50200891l-12.10595556 21.15356445h-233.19893332l-12.10595556-21.15356445L130.59868445 147.54702221h762.8026311L640.70542222 574.95096888z',
        special: true,
        outlined: true,
      },
      {
        viewBox: [1024, 1024],
        path: 'M980.62285431 4.54099753H654.39920987c-4.2719763 0-7.76722963 3.49525333-7.76722962 7.76722964v72.4941432c0 4.2719763 3.49525333 7.76722963 7.76722962 7.76722963h207.64393877L604.04167111 350.57107753c-64.72691358-49.83972347-143.69374815-76.7661195-226.67365136-76.7661195-99.54999309 0-193.27456395 38.83614815-263.5679921 109.25903012S4.54099753 547.08198717 4.54099753 646.63198025s38.83614815 193.27456395 109.25903012 263.5679921C184.09345581 980.62285431 277.81802667 1019.45900247 377.36801975 1019.45900247s193.27456395-38.83614815 263.5679921-109.25903012C711.35889383 839.90654419 750.19504197 746.18197333 750.19504197 646.63198025c0-82.9799032-26.92639605-161.68783013-76.63666567-226.41474372L931.4304 162.34521283V369.60079013c0 4.2719763 3.49525333 7.76722963 7.76722963 7.76722962h72.4941432c4.2719763 0 7.76722963-3.49525333 7.76722964-7.76722962V43.37714569c0-21.35988148-17.47626667-38.83614815-38.83614816-38.83614816zM377.36801975 921.07409383c-151.33152395 0-274.44211358-123.11058963-274.44211358-274.44211358s123.11058963-274.44211358 274.44211358-274.44211358 274.44211358 123.11058963 274.44211358 274.44211358-123.11058963 274.44211358-274.44211358 274.44211358z',
        special: true,
        outlined: true,
      },
    ],
  },
];
