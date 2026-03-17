import { SVGPathData } from 'svg-pathdata';
import arcToBezier from 'svg-arc-to-cubic-bezier';

const typeMap = {
  1: 'Z',
  2: 'M',
  4: 'H',
  8: 'V',
  16: 'L',
  32: 'C',
  64: 'S',
  128: 'Q',
  256: 'T',
  512: 'A',
};

/**
 * 简单解析SVG路径
 * @param d SVG path d属性
 */
export const parseSvgPath = (d: string) => {
  const pathData = new SVGPathData(d);

  const ret = pathData.commands.map((item) => {
    return { ...item, type: typeMap[item.type] };
  });
  return ret;
};

export type SvgPath = ReturnType<typeof parseSvgPath>;

/**
 * 解析SVG路径，并将圆弧（A）类型的路径转为三次贝塞尔（C）类型的路径
 * @param d SVG path d属性
 */
export const toPoints = (d: string) => {
  const pathData = new SVGPathData(d);

  const points = [];
  for (const item of pathData.commands) {
    const type = typeMap[item.type];

    if (item.type === 2 || item.type === 16) {
      points.push({
        x: item.x,
        y: item.y,
        relative: item.relative,
        type,
      });
    }
    if (item.type === 32) {
      points.push({
        x: item.x,
        y: item.y,
        curve: {
          type: 'cubic',
          x1: item.x1,
          y1: item.y1,
          x2: item.x2,
          y2: item.y2,
        },
        relative: item.relative,
        type,
      });
    } else if (item.type === 128) {
      points.push({
        x: item.x,
        y: item.y,
        curve: {
          type: 'quadratic',
          x1: item.x1,
          y1: item.y1,
        },
        relative: item.relative,
        type,
      });
    } else if (item.type === 512) {
      const lastPoint = points[points.length - 1];
      if (!['M', 'L', 'Q', 'C'].includes(lastPoint.type)) continue;

      const cubicBezierPoints = arcToBezier({
        px: lastPoint.x as number,
        py: lastPoint.y as number,
        cx: item.x,
        cy: item.y,
        rx: item.rX,
        ry: item.rY,
        xAxisRotation: item.xRot,
        largeArcFlag: item.lArcFlag,
        sweepFlag: item.sweepFlag,
      });
      for (const cbPoint of cubicBezierPoints) {
        points.push({
          x: cbPoint.x,
          y: cbPoint.y,
          curve: {
            type: 'cubic',
            x1: cbPoint.x1,
            y1: cbPoint.y1,
            x2: cbPoint.x2,
            y2: cbPoint.y2,
          },
          relative: false,
          type: 'C',
        });
      }
    } else if (item.type === 1) {
      points.push({ close: true, type });
    } else continue;
  }
  return points;
};

export const getSvgPathRange = (path: string) => {
  try {
    const pathData = new SVGPathData(path);
    const xList = [];
    const yList = [];
    for (const item of pathData.commands) {
      const x = 'x' in item ? item.x : 0;
      const y = 'y' in item ? item.y : 0;
      xList.push(x);
      yList.push(y);
    }
    return {
      minX: Math.min(...xList),
      minY: Math.min(...yList),
      maxX: Math.max(...xList),
      maxY: Math.max(...yList),
    };
  } catch {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    };
  }
};

export type SvgPoints = ReturnType<typeof toPoints>;
