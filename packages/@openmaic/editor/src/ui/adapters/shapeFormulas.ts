import { ShapePathFormulasKeys } from '@openmaic/dsl';
import type { ShapePathFormulaMap } from '../../react/shape/types';

export const BUILTIN_SHAPE_PATH_FORMULAS: ShapePathFormulaMap = {
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
