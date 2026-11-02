import type { PPTShapeElement } from '@openmaic/dsl';
import { validateSvgPath } from '@openmaic/geometry';
import { SVGPathData } from 'svg-pathdata';
import tinycolor from 'tinycolor2';

const EPSILON = 1e-6;
const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a: number[], b: number[], c: number[]) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

export function hasVisibleFill(s: PPTShapeElement): boolean {
  const color = tinycolor(s.fill);
  return color.isValid() && color.getAlpha() > 0 && (s.opacity ?? 1) > 0;
}

export function isCurveScenarioShape(s: PPTShapeElement): boolean {
  const fill = tinycolor(s.fill);
  const stroke = tinycolor(s.outline?.color ?? '');
  const unfilled =
    s.fill.trim().toLowerCase() === 'none' || (fill.isValid() && fill.getAlpha() === 0);
  const angleDifference = Math.abs((s.rotate - 12.5) % 360);
  if (
    !unfilled ||
    !stroke.isValid() ||
    stroke.getAlpha() <= 0 ||
    !stroke.isDark() ||
    s.outline?.width !== 2 ||
    !((s.opacity ?? 1) > 0) ||
    ![s.left - 100, s.top - 300, s.width - 240, s.height - 80].every(
      (difference) => Math.abs(difference) < EPSILON,
    ) ||
    !(angleDifference < EPSILON || 360 - angleDifference < EPSILON) ||
    !s.viewBox.every((v) => Number.isFinite(v) && v > 0)
  )
    return false;
  const parsed = validateSvgPath(s.path);
  if (!parsed.ok || !parsed.bounds) return false;
  const commands = new SVGPathData(parsed.commands).toAbs().normalizeHVZ().normalizeST().commands;
  const first = commands[0];
  const last = commands[commands.length - 1];
  if (
    first?.type !== SVGPathData.MOVE_TO ||
    last?.type !== SVGPathData.CURVE_TO ||
    !commands.slice(1).every((c) => c.type === SVGPathData.CURVE_TO) ||
    distance([first.x, first.y], [last.x, last.y]) < EPSILON
  )
    return false;
  const sx = s.width / s.viewBox[0];
  const sy = s.height / s.viewBox[1];
  return (
    parsed.bounds.minX * sx >= -1 &&
    parsed.bounds.minY * sy >= -1 &&
    parsed.bounds.maxX * sx <= s.width + 1 &&
    parsed.bounds.maxY * sy <= s.height + 1
  );
}

function polygonContours(s: PPTShapeElement): number[][][] {
  const result = validateSvgPath(s.path);
  if (!result.ok) return [];
  const commands = new SVGPathData(result.commands).toAbs().normalizeHVZ().commands;
  if (
    commands.some(
      (c) =>
        c.type !== SVGPathData.MOVE_TO &&
        c.type !== SVGPathData.LINE_TO &&
        c.type !== SVGPathData.CLOSE_PATH,
    )
  )
    return [];
  const angle = (s.rotate * Math.PI) / 180;
  const cx = s.left + s.width / 2,
    cy = s.top + s.height / 2;
  const contours: number[][][] = [];
  let points: number[][] = [];
  for (const c of commands) {
    if (c.type === SVGPathData.MOVE_TO && points.length) {
      const vertices = closedPolygonVertices(points);
      if (!vertices.length) return [];
      contours.push(vertices);
      points = [];
    }
    if ('x' in c && 'y' in c) {
      const x = (c.x * s.width) / s.viewBox[0] - s.width / 2;
      const y = (c.y * s.height) / s.viewBox[1] - s.height / 2;
      points.push([
        cx + x * Math.cos(angle) - y * Math.sin(angle),
        cy + x * Math.sin(angle) + y * Math.cos(angle),
      ]);
    } else if (c.type === SVGPathData.CLOSE_PATH && points.length) {
      points.push(points[0]);
    }
  }
  const vertices = closedPolygonVertices(points);
  if (!vertices.length) return [];
  contours.push(vertices);
  return contours;
}

function closedPolygonVertices(points: number[][]): number[][] {
  const vertices = points.filter((p, i) => i === 0 || distance(p, points[i - 1]) > EPSILON);
  if (vertices.length < 4 || vertices.some((p) => p.some((v) => !Number.isFinite(v)))) return [];
  const closed = distance(vertices[0], vertices[vertices.length - 1]) < EPSILON;
  if (!closed) return [];
  vertices.pop();
  // Collinear intermediate points do not add polygon corners. Keep reversals:
  // they must not hide a backtracking edge from the checks below.
  return vertices.filter((p, i) => {
    const before = vertices[(i + vertices.length - 1) % vertices.length];
    const after = vertices[(i + 1) % vertices.length];
    const dot = (p[0] - before[0]) * (after[0] - p[0]) + (p[1] - before[1]) * (after[1] - p[1]);
    return dot <= 0 || Math.abs(cross(before, p, after)) > EPSILON;
  });
}

function polygonVertices(s: PPTShapeElement): number[][] {
  const contours = polygonContours(s);
  return contours.length === 1 ? contours[0] : [];
}

function matchesVertices(actual: number[][], expected: number[][]): boolean {
  if (actual.length !== expected.length) return false;
  const indices = actual.map((p) => expected.findIndex((e) => distance(p, e) < 1));
  if (indices.includes(-1) || new Set(indices).size !== expected.length) return false;
  const step = (indices[1] - indices[0] + indices.length) % indices.length;
  return (
    (step === 1 || step === indices.length - 1) &&
    indices.every(
      (n, i) => (indices[(i + 1) % indices.length] - n + indices.length) % indices.length === step,
    )
  );
}

function matchesPolygon(s: PPTShapeElement, expected: number[][]): boolean {
  return matchesVertices(polygonVertices(s), expected);
}

export type TriangleVertices = [[number, number], [number, number], [number, number]];

/** Independent expected vertices; never include these square coordinates in the model prompt. */
export function expectedComposition(vertices: TriangleVertices): number[][][] {
  return [
    vertices,
    ...vertices.map((a, i) => {
      const b = vertices[(i + 1) % 3];
      const opposite = vertices[(i + 2) % 3];
      const sign = cross(a, b, opposite) > 0 ? 1 : -1;
      const nx = sign * (b[1] - a[1]);
      const ny = sign * (a[0] - b[0]);
      return [a, b, [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]];
    }),
  ];
}

export function assessComposition(shapes: PPTShapeElement[], vertices: TriangleVertices) {
  const expected = expectedComposition(vertices);
  const elementContours = shapes.map(polygonContours);
  const contours = elementContours.flat();
  const matches = contours.map((p) => expected.findIndex((e) => matchesVertices(p, e)));
  const withinCanvas = contours.every((p) =>
    p.every(([x, y]) => x >= -1 && y >= -1 && x <= 1001 && y <= 563.5),
  );
  const validElements =
    shapes.length > 0 && shapes.every((s, i) => hasVisibleFill(s) && elementContours[i].length > 0);
  const matchedContours = [...new Set(matches.filter((i) => i >= 0))];
  return {
    passed: validElements && withinCanvas && contours.length === 4 && matchedContours.length === 4,
    elementCount: shapes.length,
    contourCount: contours.length,
    matchedContours,
    unmatchedContours: matches.filter((i) => i < 0).length,
    validElements,
    withinCanvas,
  };
}

export function isRightTriangle(s: PPTShapeElement): boolean {
  return matchesPolygon(s, [
    [100, 100],
    [340, 100],
    [100, 280],
  ]);
}

export function squareOnHypotenuse(s: PPTShapeElement): boolean {
  return matchesPolygon(s, [
    [340, 100],
    [100, 280],
    [280, 520],
    [520, 340],
  ]);
}

export function isPentagon(s: PPTShapeElement): boolean {
  const vertices = polygonVertices(s);
  if (vertices.length !== 5) return false;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i],
      b = vertices[(i + 1) % vertices.length];
    if (Math.abs(cross(a, b, vertices[(i + 2) % vertices.length])) < EPSILON) return false;
    for (let j = i + 1; j < vertices.length; j++) {
      if (j === i + 1 || (i === 0 && j === vertices.length - 1)) continue;
      const c = vertices[j],
        d = vertices[(j + 1) % vertices.length];
      const side = (n: number) => (n > EPSILON ? 1 : n < -EPSILON ? -1 : 0);
      const overlaps =
        Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <=
          Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) + EPSILON &&
        Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <=
          Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) + EPSILON;
      if (
        overlaps &&
        side(cross(a, b, c)) * side(cross(a, b, d)) <= 0 &&
        side(cross(c, d, a)) * side(cross(c, d, b)) <= 0
      )
        return false;
    }
  }
  return true;
}
export function isCircle(s: PPTShapeElement, cx: number, cy: number, radius: number): boolean {
  const result = validateSvgPath(s.path);
  if (!result.ok) return false;
  try {
    const commands = new SVGPathData(result.commands)
      .toAbs()
      .normalizeHVZ()
      .normalizeST()
      .qtToC()
      .aToC()
      .scale(s.width / s.viewBox[0], s.height / s.viewBox[1])
      .translate(s.left, s.top)
      .rotate((s.rotate * Math.PI) / 180, s.left + s.width / 2, s.top + s.height / 2).commands;
    const points: number[][] = [];
    let x = 0,
      y = 0,
      moves = 0;
    for (const c of commands) {
      if (c.type === SVGPathData.MOVE_TO) {
        points.push([c.x, c.y]);
        moves++;
      } else if (c.type === SVGPathData.LINE_TO || c.type === SVGPathData.CURVE_TO) {
        for (let i = 1; i <= 32; i++) {
          const t = i / 32,
            u = 1 - t;
          points.push(
            c.type === SVGPathData.LINE_TO
              ? [x + t * (c.x - x), y + t * (c.y - y)]
              : [
                  u ** 3 * x + 3 * u ** 2 * t * c.x1 + 3 * u * t ** 2 * c.x2 + t ** 3 * c.x,
                  u ** 3 * y + 3 * u ** 2 * t * c.y1 + 3 * u * t ** 2 * c.y2 + t ** 3 * c.y,
                ],
          );
        }
      } else return false;
      x = c.x;
      y = c.y;
    }
    if (moves !== 1 || points.length < 33) return false;
    const first = points[0],
      last = points[points.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1) return false;
    const area =
      Math.abs(
        points.reduce((sum, p, i) => {
          const next = points[(i + 1) % points.length];
          return sum + p[0] * next[1] - next[0] * p[1];
        }, 0),
      ) / 2;
    return (
      Math.abs(area / (Math.PI * radius ** 2) - 1) < 0.02 &&
      points.every(([px, py]) => Math.abs(Math.hypot(px - cx, py - cy) - radius) < 1)
    );
  } catch {
    return false;
  }
}

export function areBasicShapes(shapes: PPTShapeElement[]): boolean {
  if (shapes.length !== 3 || shapes.some((s) => s.rotate !== 0 || !hasVisibleFill(s))) return false;
  return [80, 340, 600].every((x, i) => {
    const s = shapes.find(
      (v) => v.left === x && v.top === 100 && v.width === 120 && v.height === 120,
    );
    if (!s) return false;
    if (i === 1) return isCircle(s, x + 60, 160, 60);
    return matchesPolygon(
      s,
      i === 0
        ? [
            [x, 100],
            [x + 120, 100],
            [x + 120, 220],
            [x, 220],
          ]
        : [
            [x + 60, 100],
            [x + 120, 220],
            [x, 220],
          ],
    );
  });
}
