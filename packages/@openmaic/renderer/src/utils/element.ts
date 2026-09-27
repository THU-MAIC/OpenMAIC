import tinycolor from 'tinycolor2';
import type { PPTElement, PPTLineElement } from '@openmaic/dsl';

interface RotatedElementData {
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
}

export const getRectRotatedRange = (element: RotatedElementData) => {
  const { left, top, width, height, rotate = 0 } = element;

  const radius = Math.sqrt(Math.pow(width, 2) + Math.pow(height, 2)) / 2;
  const auxiliaryAngle = (Math.atan(height / width) * 180) / Math.PI;

  const tlbraRadian = ((180 - rotate - auxiliaryAngle) * Math.PI) / 180;
  const trblaRadian = ((auxiliaryAngle - rotate) * Math.PI) / 180;

  const middleLeft = left + width / 2;
  const middleTop = top + height / 2;

  const xAxis = [
    middleLeft + radius * Math.cos(tlbraRadian),
    middleLeft + radius * Math.cos(trblaRadian),
    middleLeft - radius * Math.cos(tlbraRadian),
    middleLeft - radius * Math.cos(trblaRadian),
  ];
  const yAxis = [
    middleTop - radius * Math.sin(tlbraRadian),
    middleTop - radius * Math.sin(trblaRadian),
    middleTop + radius * Math.sin(tlbraRadian),
    middleTop + radius * Math.sin(trblaRadian),
  ];

  return {
    xRange: [Math.min(...xAxis), Math.max(...xAxis)],
    yRange: [Math.min(...yAxis), Math.max(...yAxis)],
  };
};

// Preserve the existing endpoint-offset routing rule. Using the expanded
// bounds here would let a control point change the double elbow's direction.
const isHorizontalElbow = (start: number[], end: number[]) =>
  Math.max(start[0], end[0]) >= Math.max(start[1], end[1]);

export const getElementRange = (element: PPTElement) => {
  let minX: number, maxX: number, minY: number, maxY: number;

  if (element.type === 'line') {
    const xs = [element.start[0], element.end[0]];
    const ys = [element.start[1], element.end[1]];
    // Follow the same path-variant precedence as getLineElementPath. Bezier
    // control hulls conservatively enclose the curve; elbows use drawn vertices.
    if (element.broken) {
      xs.push(element.broken[0]);
      ys.push(element.broken[1]);
    } else if (element.broken2) {
      if (isHorizontalElbow(element.start, element.end)) xs.push(element.broken2[0]);
      else ys.push(element.broken2[1]);
    } else if (element.curve) {
      xs.push(element.curve[0]);
      ys.push(element.curve[1]);
    } else if (element.cubic) {
      xs.push(element.cubic[0][0], element.cubic[1][0]);
      ys.push(element.cubic[0][1], element.cubic[1][1]);
    }
    minX = element.left + Math.min(...xs);
    maxX = element.left + Math.max(...xs);
    minY = element.top + Math.min(...ys);
    maxY = element.top + Math.max(...ys);
  } else if ('rotate' in element && element.rotate) {
    const { left, top, width, height, rotate } = element;
    const { xRange, yRange } = getRectRotatedRange({ left, top, width, height, rotate });
    minX = xRange[0];
    maxX = xRange[1];
    minY = yRange[0];
    maxY = yRange[1];
  } else {
    minX = element.left;
    maxX = element.left + element.width;
    minY = element.top;
    maxY = element.top + element.height;
  }
  return { minX, maxX, minY, maxY };
};

export const getTableSubThemeColor = (themeColor: string) => {
  const rgba = tinycolor(themeColor);
  return [rgba.setAlpha(0.3).toRgbString(), rgba.setAlpha(0.1).toRgbString()];
};

export const getLineElementPath = (element: PPTLineElement) => {
  const startArr = Array.isArray(element.start) ? element.start : [0, 0];
  const endArr = Array.isArray(element.end) ? element.end : [100, 100];
  const start = startArr.join(',');
  const end = endArr.join(',');
  if (element.broken) {
    const mid = element.broken.join(',');
    return `M${start} L${mid} L${end}`;
  } else if (element.broken2) {
    if (isHorizontalElbow(startArr, endArr))
      return `M${start} L${element.broken2[0]},${startArr[1]} L${element.broken2[0]},${endArr[1]} ${end}`;
    return `M${start} L${startArr[0]},${element.broken2[1]} L${endArr[0]},${element.broken2[1]} ${end}`;
  } else if (element.curve) {
    const mid = element.curve.join(',');
    return `M${start} Q${mid} ${end}`;
  } else if (element.cubic) {
    const [c1, c2] = element.cubic;
    const p1 = c1.join(',');
    const p2 = c2.join(',');
    return `M${start} C${p1} ${p2} ${end}`;
  }
  return `M${start} L${end}`;
};
