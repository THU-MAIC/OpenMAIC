import { expectedComposition, type TriangleVertices } from './geometry-checks';

/** Four fixed placement/scale variants, generated before any model trials. */
export function compositionScenario(repetition: number) {
  const variant = repetition % 4;
  const scale = [14, 16, 12, 15][variant];
  const angle = ([0, 23, -17, 90][variant] * Math.PI) / 180;
  const transform = ([x, y]: number[]): [number, number] => [
    Math.round((x * Math.cos(angle) - y * Math.sin(angle)) * 100) / 100,
    Math.round((x * Math.sin(angle) + y * Math.cos(angle)) * 100) / 100,
  ];
  const rotated: TriangleVertices = [
    transform([0, 0]),
    transform([12 * scale, 0]),
    transform([0, 5 * scale]),
  ];
  // Center the entire target figure on the canvas, including the outward squares.
  const points = expectedComposition(rotated).flat();
  const centerX = (Math.min(...points.map((p) => p[0])) + Math.max(...points.map((p) => p[0]))) / 2;
  const centerY = (Math.min(...points.map((p) => p[1])) + Math.max(...points.map((p) => p[1]))) / 2;
  const vertices = rotated.map(([x, y]) => [
    Math.round((x + 500 - centerX) * 100) / 100,
    Math.round((y + 281.25 - centerY) * 100) / 100,
  ]) as TriangleVertices;
  return {
    variant,
    vertices,
    request:
      `请在白板上实际绘制一幅组合图：一个边长比为5–12–13的直角三角形ABC，` +
      `顶点A=(${vertices[0]}), B=(${vertices[1]}), C=(${vertices[2]})，` +
      '并在三条边上分别向三角形外侧作一个正方形。三角形和三个正方形都要有填充，完整放在画布内，不加文字、标注或其他图形。',
  };
}
