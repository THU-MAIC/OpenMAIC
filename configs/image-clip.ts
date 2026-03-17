export const enum ClipPathTypes {
  RECT = 'rect',
  ELLIPSE = 'ellipse',
  POLYGON = 'polygon',
}

export const enum ClipPaths {
  RECT = 'rect',
  ROUNDRECT = 'roundRect',
  ELLIPSE = 'ellipse',
  TRIANGLE = 'triangle',
  PENTAGON = 'pentagon',
  RHOMBUS = 'rhombus',
  STAR = 'star',
}

interface ClipPath {
  [key: string]: {
    name: string;
    type: ClipPathTypes;
    style: string;
    radius?: string;
    createPath?: (width: number, height: number) => string;
  };
}

export const CLIPPATHS: ClipPath = {
  rect: {
    name: '矩形',
    type: ClipPathTypes.RECT,
    radius: '0',
    style: '',
  },
  rect2: {
    name: '矩形2',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(0% 0%, 80% 0%, 100% 20%, 100% 100%, 0 100%)',
    createPath: (width: number, height: number) => {
      return `M 0 0 L ${width * 0.8} 0 L ${width} ${height * 0.2} L ${width} ${height} L 0 ${height} Z`;
    },
  },
  rect3: {
    name: '矩形3',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(0% 0%, 80% 0%, 100% 20%, 100% 100%, 20% 100%, 0% 80%)',
    createPath: (width: number, height: number) => {
      return `M 0 0 L ${width * 0.8} 0 L ${width} ${height * 0.2} L ${width} ${height} L ${width * 0.2} ${height} L 0 ${height * 0.8} Z`;
    },
  },
  roundRect: {
    name: '圆角矩形',
    type: ClipPathTypes.RECT,
    radius: '10px',
    style: 'inset(0 round 10px)',
  },
  ellipse: {
    name: '圆形',
    type: ClipPathTypes.ELLIPSE,
    style: 'ellipse(50% 50% at 50% 50%)',
  },
  triangle: {
    name: '三角形',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(50% 0%, 0% 100%, 100% 100%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.5} 0 L 0 ${height} L ${width} ${height} Z`;
    },
  },
  triangle2: {
    name: '三角形2',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(50% 100%, 0% 0%, 100% 0%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.5} ${height} L 0 0 L ${width} 0 Z`;
    },
  },
  triangle3: {
    name: '三角形3',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(0% 0%, 0% 100%, 100% 100%)',
    createPath: (width: number, height: number) => {
      return `M 0 0 L 0 ${height} L ${width} ${height} Z`;
    },
  },
  rhombus: {
    name: '菱形',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.5} 0 L ${width} ${height * 0.5} L ${width * 0.5} ${height} L 0 ${height * 0.5} Z`;
    },
  },
  pentagon: {
    name: '五边形',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.5} 0 L ${width} ${0.38 * height} L ${0.82 * width} ${height} L ${0.18 * width} ${height} L 0 ${0.38 * height} Z`;
    },
  },
  hexagon: {
    name: '六边形',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(20% 0%, 80% 0%, 100% 50%, 80% 100%, 20% 100%, 0% 50%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.2} 0 L ${width * 0.8} 0 L ${width} ${height * 0.5} L ${width * 0.8} ${height} L ${width * 0.2} ${height} L 0 ${height * 0.5} Z`;
    },
  },
  heptagon: {
    name: '七边形',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(50% 0%, 90% 20%, 100% 60%, 75% 100%, 25% 100%, 0% 60%, 10% 20%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.5} 0 L ${width * 0.9} ${height * 0.2} L ${width} ${height * 0.6} L ${width * 0.75} ${height} L ${width * 0.25} ${height} L 0 ${height * 0.6} L ${width * 0.1} ${height * 0.2} Z`;
    },
  },
  octagon: {
    name: '八边形',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.3} 0 L ${width * 0.7} 0 L ${width} ${height * 0.3} L ${width} ${height * 0.7} L ${width * 0.7} ${height} L ${width * 0.3} ${height} L 0 ${height * 0.7} L 0 ${height * 0.3} Z`;
    },
  },
  chevron: {
    name: 'V形',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(75% 0%, 100% 50%, 75% 100%, 0% 100%, 25% 50%, 0% 0%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.75} 0 L ${width} ${height * 0.5} L ${width * 0.75} ${height} L 0 ${height} L ${width * 0.25} ${height * 0.5} L 0 0 Z`;
    },
  },
  point: {
    name: '点',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(0% 0%, 75% 0%, 100% 50%, 75% 100%, 0% 100%)',
    createPath: (width: number, height: number) => {
      return `M 0 0 L ${width * 0.75} 0 L ${width} ${height * 0.5} L ${width * 0.75} ${height} L 0 ${height} Z`;
    },
  },
  arrow: {
    name: '箭头',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(0% 20%, 60% 20%, 60% 0%, 100% 50%, 60% 100%, 60% 80%, 0% 80%)',
    createPath: (width: number, height: number) => {
      return `M 0 ${height * 0.2} L ${width * 0.6} ${height * 0.2} L ${width * 0.6} 0 L ${width} ${height * 0.5} L ${width * 0.6} ${height} L ${width * 0.6} ${height * 0.8} L 0 ${height * 0.8} Z`;
    },
  },
  parallelogram: {
    name: '平行四边形',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(30% 0%, 100% 0%, 70% 100%, 0% 100%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.3} 0 L ${width} 0 L ${width * 0.7} ${height} L 0 ${height} Z`;
    },
  },
  parallelogram2: {
    name: '平行四边形2',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(30% 100%, 100% 100%, 70% 0%, 0% 0%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.3} ${height} L ${width} ${height} L ${width * 0.7} 0 L 0 0 Z`;
    },
  },
  trapezoid: {
    name: '梯形',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(25% 0%, 75% 0%, 100% 100%, 0% 100%)',
    createPath: (width: number, height: number) => {
      return `M ${width * 0.25} 0 L ${width * 0.75} 0 L ${width} ${height} L 0 ${height} Z`;
    },
  },
  trapezoid2: {
    name: '梯形2',
    type: ClipPathTypes.POLYGON,
    style: 'polygon(0% 0%, 100% 0%, 75% 100%, 25% 100%)',
    createPath: (width: number, height: number) => {
      return `M 0 0 L ${width} 0 L ${width * 0.75} ${height} L ${width * 0.25} ${height} Z`;
    },
  },
};
