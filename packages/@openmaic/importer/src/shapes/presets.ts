/**
 * Preset shape SVG path generators for OOXML preset geometry types.
 *
 * Each generator takes width, height, and optional adjustment values,
 * returning an SVG path d-attribute string.
 *
 * Adjustment values follow OOXML convention: values are in 100000ths
 * (so 50000 = 50%).
 */

import { shapeArc } from './shapeArc';

type PresetShapeGenerator = (w: number, h: number, adjustments?: Map<string, number>) => string;

/** Helper: get adjustment value or default, converting from 100000ths to fraction. */
function adj(
  adjustments: Map<string, number> | undefined,
  name: string,
  defaultVal: number,
): number {
  const raw = adjustments?.get(name) ?? defaultVal;
  return raw / 100000;
}

/** Helper: generate a regular polygon path (inscribed in bounding box). */
function _regularPolygon(w: number, h: number, sides: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const parts: string[] = [];
  for (let i = 0; i < sides; i++) {
    // Start from top center (-90 degrees)
    const angle = (2 * Math.PI * i) / sides - Math.PI / 2;
    const x = cx + rx * Math.cos(angle);
    const y = cy + ry * Math.sin(angle);
    parts.push(i === 0 ? `M${x},${y}` : `L${x},${y}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

/** Raw adj helper: get adjustment value without dividing by 100000. */
function adjRaw(
  adjustments: Map<string, number> | undefined,
  name: string,
  defaultVal: number,
): number {
  return adjustments?.get(name) ?? defaultVal;
}

/** Helper: generate a star polygon. */
function starShape(w: number, h: number, points: number, innerRatio: number = 0.4): string {
  const cx = w / 2;
  const cy = h / 2;
  const outerRx = w / 2;
  const outerRy = h / 2;
  const innerRx = outerRx * innerRatio;
  const innerRy = outerRy * innerRatio;
  const totalPoints = points * 2;
  const parts: string[] = [];

  for (let i = 0; i < totalPoints; i++) {
    const angle = (2 * Math.PI * i) / totalPoints - Math.PI / 2;
    const isOuter = i % 2 === 0;
    const rx = isOuter ? outerRx : innerRx;
    const ry = isOuter ? outerRy : innerRy;
    const x = cx + rx * Math.cos(angle);
    const y = cy + ry * Math.sin(angle);
    parts.push(i === 0 ? `M${x},${y}` : `L${x},${y}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

/**
 * Mirror an absolute SVG path horizontally across the given width.
 * Supports the command subset used by preset arrow shapes: M, L, A, Z.
 */
function mirrorAbsolutePathHorizontally(path: string, width: number): string {
  const tokens = path.match(/[MLAZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens) return path;

  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (!cmd) break;
    out.push(cmd);
    if (cmd === 'Z') continue;
    if (cmd === 'M' || cmd === 'L') {
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      out.push(String(width - x), String(y));
      continue;
    }
    if (cmd === 'A') {
      const rx = tokens[i++];
      const ry = tokens[i++];
      const rot = tokens[i++];
      const largeArc = tokens[i++];
      const sweep = Number(tokens[i++]);
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      out.push(rx, ry, rot, largeArc, String(sweep ? 0 : 1), String(width - x), String(y));
      continue;
    }
    return path;
  }

  return out.join(' ');
}

function mirrorAbsolutePathVertically(path: string, height: number): string {
  const tokens = path.match(/[MLAZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens) return path;

  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (!cmd) break;
    out.push(cmd);
    if (cmd === 'Z') continue;
    if (cmd === 'M' || cmd === 'L') {
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      out.push(String(x), String(height - y));
      continue;
    }
    if (cmd === 'A') {
      const rx = tokens[i++];
      const ry = tokens[i++];
      const rot = tokens[i++];
      const largeArc = tokens[i++];
      const sweep = Number(tokens[i++]);
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      out.push(rx, ry, rot, largeArc, String(sweep ? 0 : 1), String(x), String(height - y));
    }
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------
// Preset shape registry
// ---------------------------------------------------------------------------

export const presetShapes: Map<string, PresetShapeGenerator> = new Map();

// ===== Basic Shapes =====

presetShapes.set('rect', (w, h) => `M0,0 L${w},0 L${w},${h} L0,${h} Z`);

presetShapes.set('roundRect', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 16667);
  const r = Math.min(w, h) * a;
  return [
    `M${r},0`,
    `L${w - r},0`,
    `A${r},${r} 0 0,1 ${w},${r}`,
    `L${w},${h - r}`,
    `A${r},${r} 0 0,1 ${w - r},${h}`,
    `L${r},${h}`,
    `A${r},${r} 0 0,1 0,${h - r}`,
    `L0,${r}`,
    `A${r},${r} 0 0,1 ${r},0`,
    'Z',
  ].join(' ');
});

presetShapes.set('plaque', (w, h, adjustments) => {
  // OOXML: adj default 16667, concave (inward) arc corners via negative sweep arcTo
  const a = Math.min(Math.max(adjRaw(adjustments, 'adj', 16667), 0), 50000);
  const x1 = (Math.min(w, h) * a) / 100000;
  const x2 = w - x1;
  const y2 = h - x1;
  // Start at (0, x1), arcTo with negative sweep creates concave corner
  const a1 = ooArcTo(0, x1, x1, x1, 90, -90); // top-left: ends at (x1, 0)
  const a2 = ooArcTo(x2, 0, x1, x1, 180, -90); // top-right: ends at (w, x1)
  const a3 = ooArcTo(w, y2, x1, x1, 270, -90); // bottom-right: ends at (x2, h)
  const a4 = ooArcTo(x1, h, x1, x1, 0, -90); // bottom-left: ends at (0, y2) -> close to (0, x1)
  return [
    `M0,${x1}`,
    a1.svg,
    `L${x2},0`,
    a2.svg,
    `L${w},${y2}`,
    a3.svg,
    `L${x1},${h}`,
    a4.svg,
    'Z',
  ].join(' ');
});

// Tab family: OOXML uses dx = sqrt(w²+h²)/20 (diagonal/20)
presetShapes.set('cornerTabs', (w, h) => {
  const dx = Math.sqrt(w * w + h * h) / 20;
  return [
    `M0,0 L${dx},0 L0,${dx} Z`,
    `M${w},0 L${w - dx},0 L${w},${dx} Z`,
    `M${w},${h} L${w - dx},${h} L${w},${h - dx} Z`,
    `M0,${h} L${dx},${h} L0,${h - dx} Z`,
  ].join(' ');
});

presetShapes.set('squareTabs', (w, h) => {
  const dx = Math.sqrt(w * w + h * h) / 20;
  return [
    `M0,0 L${dx},0 L${dx},${dx} L0,${dx} Z`,
    `M${w - dx},0 L${w},0 L${w},${dx} L${w - dx},${dx} Z`,
    `M0,${h - dx} L${dx},${h - dx} L${dx},${h} L0,${h} Z`,
    `M${w - dx},${h - dx} L${w},${h - dx} L${w},${h} L${w - dx},${h} Z`,
  ].join(' ');
});

presetShapes.set('plaqueTabs', (w, h) => {
  const dx = Math.sqrt(w * w + h * h) / 20;
  return [
    `M0,0 L${dx},0 A${dx},${dx} 0 0,1 0,${dx} Z`,
    `M${w},0 L${w - dx},0 A${dx},${dx} 0 0,0 ${w},${dx} Z`,
    `M0,${h} L0,${h - dx} A${dx},${dx} 0 0,1 ${dx},${h} Z`,
    `M${w},${h} L${w - dx},${h} A${dx},${dx} 0 0,1 ${w},${h - dx} Z`,
  ].join(' ');
});

presetShapes.set('ellipse', (w, h) => {
  const rx = w / 2;
  const ry = h / 2;
  return [`M${w},${ry}`, `A${rx},${ry} 0 1,1 0,${ry}`, `A${rx},${ry} 0 1,1 ${w},${ry}`, 'Z'].join(
    ' ',
  );
});

presetShapes.set('triangle', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 50000);
  const topX = w * a;
  return `M${topX},0 L${w},${h} L0,${h} Z`;
});

presetShapes.set('isosTriangle', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 50000);
  const topX = w * a;
  return `M${topX},0 L${w},${h} L0,${h} Z`;
});

presetShapes.set('rtTriangle', (w, h) => `M0,0 L${w},${h} L0,${h} Z`);

presetShapes.set('diamond', (w, h) => {
  const cx = w / 2;
  const cy = h / 2;
  return `M${cx},0 L${w},${cy} L${cx},${h} L0,${cy} Z`;
});

presetShapes.set('pentagon', (w, h) => {
  // OOXML pentagon: hf=105146, vf=110557 with center shifted to svc so top vertex = y=0.
  const hc = w / 2;
  const swd2 = (hc * 105146) / 100000;
  const shd2 = ((h / 2) * 110557) / 100000;
  const svc = shd2; // svc = vc * vf/100000 = shd2, so top vertex at svc - shd2 = 0
  const dx1 = swd2 * Math.cos((18 * Math.PI) / 180); // cos 1080000
  const dx2 = swd2 * Math.cos((54 * Math.PI) / 180); // cos 18360000
  const dy1 = shd2 * Math.sin((18 * Math.PI) / 180); // sin 1080000
  const dy2 = shd2 * Math.sin((54 * Math.PI) / 180); // |sin 18360000|
  return [
    `M${hc - dx1},${svc - dy1}`, // x1, y1 (upper-left)
    `L${hc},0`, // hc, t (top)
    `L${hc + dx1},${svc - dy1}`, // x4, y1 (upper-right)
    `L${hc + dx2},${svc + dy2}`, // x3, y2 (lower-right)
    `L${hc - dx2},${svc + dy2}`, // x2, y2 (lower-left)
    'Z',
  ].join(' ');
});

presetShapes.set('hexagon', (w, h, adjustments) => {
  // OOXML hexagon: adj=25000, vf=115470 (2/√3 scale factor for regular hex).
  const ss = Math.min(w, h);
  const a = Math.min(
    Math.max(adjRaw(adjustments, 'adj', 25000), 0),
    ss > 0 ? (50000 * w) / ss : 50000,
  );
  const vf = 115470;
  const shd2 = ((h / 2) * vf) / 100000;
  const x1 = (ss * a) / 100000;
  const x2 = w - x1;
  const _hc = w / 2;
  const vc = h / 2;
  // dy1 = sin(shd2, 60°) = shd2 * sin(60°)
  const dy1 = shd2 * Math.sin((60 * Math.PI) / 180);
  const y1 = vc - dy1;
  const y2 = vc + dy1;
  return [
    `M0,${vc}`,
    `L${x1},${y1}`,
    `L${x2},${y1}`,
    `L${w},${vc}`,
    `L${x2},${y2}`,
    `L${x1},${y2}`,
    'Z',
  ].join(' ');
});

presetShapes.set('octagon', (w, h, adjustments) => {
  // OOXML octagon: adj=29289 (≈1-1/√2). Uses ss-based cuts for both x and y.
  const ss = Math.min(w, h);
  const a = Math.min(Math.max(adjRaw(adjustments, 'adj', 29289), 0), 50000);
  const x1 = (ss * a) / 100000;
  const x2 = w - x1;
  const y2 = h - x1;
  return [
    `M0,${x1}`,
    `L${x1},0`,
    `L${x2},0`,
    `L${w},${x1}`,
    `L${w},${y2}`,
    `L${x2},${h}`,
    `L${x1},${h}`,
    `L0,${y2}`,
    'Z',
  ].join(' ');
});

presetShapes.set('heptagon', (w, h) => {
  // OOXML heptagon: hf=102572, vf=105210 with shifted center.
  const hc = w / 2;
  const swd2 = (hc * 102572) / 100000;
  const shd2 = ((h / 2) * 105210) / 100000;
  const svc = ((h / 2) * 105210) / 100000;
  // Pre-computed trig ratios from OOXML spec (scaled by 100000)
  const dx1 = (swd2 * 97493) / 100000; // cos(12.857°) ≈ sin(77.14°)
  const dx2 = (swd2 * 78183) / 100000; // cos(38.57°)
  const dx3 = (swd2 * 43388) / 100000; // cos(64.29°)
  const dy1 = (shd2 * 62349) / 100000; // sin(38.57°)
  const dy2 = (shd2 * 22252) / 100000; // sin(12.857°)
  const dy3 = (shd2 * 90097) / 100000; // sin(64.29°)
  return [
    `M${hc - dx1},${svc + dy2}`, // x1, y2 (left)
    `L${hc - dx2},${svc - dy1}`, // x2, y1 (upper-left)
    `L${hc},0`, // hc, t (top: svc - shd2 = 0)
    `L${hc + dx2},${svc - dy1}`, // x5, y1 (upper-right)
    `L${hc + dx1},${svc + dy2}`, // x6, y2 (right)
    `L${hc + dx3},${svc + dy3}`, // x4, y3 (lower-right)
    `L${hc - dx3},${svc + dy3}`, // x3, y3 (lower-left)
    'Z',
  ].join(' ');
});
presetShapes.set('decagon', (w, h) => {
  // OOXML decagon: vf=105146 (no hf, uses wd2 for x). 10 vertices starting from left.
  const hc = w / 2;
  const vc = h / 2;
  const shd2 = (vc * 105146) / 100000;
  // OOXML angles: 2160000=36°, 4320000=72°
  const dx1 = hc * Math.cos((36 * Math.PI) / 180); // cos(wd2, 2160000)
  const dx2 = hc * Math.cos((72 * Math.PI) / 180); // cos(wd2, 4320000)
  const dy1 = shd2 * Math.sin((72 * Math.PI) / 180); // sin(shd2, 4320000)
  const dy2 = shd2 * Math.sin((36 * Math.PI) / 180); // sin(shd2, 2160000)
  return [
    `M0,${vc}`, // l, vc
    `L${hc - dx1},${vc - dy2}`, // x1, y2
    `L${hc - dx2},${vc - dy1}`, // x2, y1
    `L${hc + dx2},${vc - dy1}`, // x3, y1
    `L${hc + dx1},${vc - dy2}`, // x4, y2
    `L${w},${vc}`, // r, vc
    `L${hc + dx1},${vc + dy2}`, // x4, y3
    `L${hc + dx2},${vc + dy1}`, // x3, y4
    `L${hc - dx2},${vc + dy1}`, // x2, y4
    `L${hc - dx1},${vc + dy2}`, // x1, y3
    'Z',
  ].join(' ');
});
presetShapes.set('dodecagon', (w, h) => {
  // OOXML dodecagon: 21600-unit coordinate space, simple ratios.
  const x1 = (w * 2894) / 21600;
  const x2 = (w * 7906) / 21600;
  const x3 = (w * 13694) / 21600;
  const x4 = (w * 18706) / 21600;
  const y1 = (h * 2894) / 21600;
  const y2 = (h * 7906) / 21600;
  const y3 = (h * 13694) / 21600;
  const y4 = (h * 18706) / 21600;
  return [
    `M0,${y2}`,
    `L${x1},${y1}`,
    `L${x2},0`,
    `L${x3},0`,
    `L${x4},${y1}`,
    `L${w},${y2}`,
    `L${w},${y3}`,
    `L${x4},${y4}`,
    `L${x3},${h}`,
    `L${x2},${h}`,
    `L${x1},${y4}`,
    `L0,${y3}`,
    'Z',
  ].join(' ');
});

presetShapes.set('parallelogram', (w, h, adjustments) => {
  // OOXML: adj=25000, x2 = ss * a / 100000, path: M(l,b)→L(x2,t)→L(r,t)→L(r-x2,b)→Z
  const ss = Math.min(w, h);
  const maxAdj = ss > 0 ? (100000 * w) / ss : 100000;
  const a = Math.min(Math.max(adjRaw(adjustments, 'adj', 25000), 0), maxAdj);
  const x2 = (ss * a) / 100000;
  const x5 = w - x2;
  return `M0,${h} L${x2},0 L${w},0 L${x5},${h} Z`;
});

presetShapes.set('trapezoid', (w, h, adjustments) => {
  // OOXML: adj=25000, x2 = ss * a / 100000, x3 = r - x2
  const ss = Math.min(w, h);
  const maxAdj = ss > 0 ? (50000 * w) / ss : 50000;
  const a = Math.min(Math.max(adjRaw(adjustments, 'adj', 25000), 0), maxAdj);
  const x2 = (ss * a) / 100000;
  const x3 = w - x2;
  return `M0,${h} L${x2},0 L${x3},0 L${w},${h} Z`;
});

presetShapes.set('nonIsoscelesTrapezoid', (w, h, adjustments) => {
  // OOXML: Two independent top insets. adj1=25000, adj2=25000
  const ss = Math.min(w, h);
  const maxAdj = ss > 0 ? (50000 * w) / ss : 50000;
  const a1 = Math.min(Math.max(adjRaw(adjustments, 'adj1', 25000), 0), maxAdj);
  const a2 = Math.min(Math.max(adjRaw(adjustments, 'adj2', 25000), 0), maxAdj);
  const x2 = (ss * a1) / 100000;
  const dx3 = (ss * a2) / 100000;
  const x3 = w - dx3;
  return `M0,${h} L${x2},0 L${x3},0 L${w},${h} Z`;
});

presetShapes.set('corner', (w, h, adjustments) => {
  // OOXML corner: two adjustments control horizontal and vertical arm thickness.
  // adj1 (default 50000) → vertical arm height from bottom: dy1 = ss * a1, y1 = h - dy1
  // adj2 (default 50000) → horizontal arm width from left: x1 = ss * a2
  const ss = Math.min(w, h);
  const a1 = Math.min(Math.max(adj(adjustments, 'adj1', 50000), 0), 1);
  const a2 = Math.min(Math.max(adj(adjustments, 'adj2', 50000), 0), 1);
  const x1 = ss * a2;
  const dy1 = ss * a1;
  const y1 = h - dy1;
  return [`M0,0`, `L${x1},0`, `L${x1},${y1}`, `L${w},${y1}`, `L${w},${h}`, `L0,${h}`, 'Z'].join(
    ' ',
  );
});

presetShapes.set('diagStripe', (w, h, adjustments) => {
  const a = Math.min(Math.max(adj(adjustments, 'adj', 50000), 0), 1);
  const x2 = w * a;
  const y2 = h * a;
  return [`M0,${y2}`, `L${x2},0`, `L${w},0`, `L0,${h}`, 'Z'].join(' ');
});

// ===== Star Shapes =====

presetShapes.set('star4', (w, h, adjustments) => {
  // OOXML default adj=12500 → innerRatio = 12500/50000 = 0.25
  const a = adj(adjustments, 'adj', 12500) * 2;
  return starShape(w, h, 4, Math.min(Math.max(a, 0), 1));
});
presetShapes.set('star5', (w, h, adjustments) => {
  // OOXML: adj=19098, hf=105146, vf=110557 — scaling factors for non-square bounding box
  const aRaw = adjustments?.get('adj') ?? 19098;
  const a = Math.min(Math.max(aRaw, 0), 50000);
  const hf = 105146;
  const vf = 110557;
  const swd2 = ((w / 2) * hf) / 100000;
  const shd2 = ((h / 2) * vf) / 100000;
  const svc = ((h / 2) * vf) / 100000;
  const iwd2 = (swd2 * a) / 50000;
  const ihd2 = (shd2 * a) / 50000;
  const cx = w / 2;
  const step = (2 * Math.PI) / 5;
  const halfStep = step / 2;
  const startAngle = -Math.PI / 2;
  const parts: string[] = [];
  for (let i = 0; i < 5; i++) {
    const outerAngle = startAngle + step * i;
    const innerAngle = outerAngle + halfStep;
    const ox = cx + swd2 * Math.cos(outerAngle);
    const oy = svc + shd2 * Math.sin(outerAngle);
    const ix = cx + iwd2 * Math.cos(innerAngle);
    const iy = svc + ihd2 * Math.sin(innerAngle);
    parts.push(i === 0 ? `M${ox},${oy}` : `L${ox},${oy}`);
    parts.push(`L${ix},${iy}`);
  }
  parts.push('Z');
  return parts.join(' ');
});
presetShapes.set('star6', (w, h, adjustments) => {
  // OOXML: adj=28868, hf=115470 — horizontal scaling factor
  const aRaw = adjustments?.get('adj') ?? 28868;
  const a = Math.min(Math.max(aRaw, 0), 50000);
  const hf = 115470;
  const swd2 = ((w / 2) * hf) / 100000;
  const shd2 = h / 2; // no vf for star6
  const iwd2 = (swd2 * a) / 50000;
  const ihd2 = (shd2 * a) / 50000;
  const cx = w / 2;
  const cy = h / 2;
  const step = (2 * Math.PI) / 6;
  const halfStep = step / 2;
  const startAngle = -Math.PI / 2;
  const parts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const outerAngle = startAngle + step * i;
    const innerAngle = outerAngle + halfStep;
    const ox = cx + swd2 * Math.cos(outerAngle);
    const oy = cy + shd2 * Math.sin(outerAngle);
    const ix = cx + iwd2 * Math.cos(innerAngle);
    const iy = cy + ihd2 * Math.sin(innerAngle);
    parts.push(i === 0 ? `M${ox},${oy}` : `L${ox},${oy}`);
    parts.push(`L${ix},${iy}`);
  }
  parts.push('Z');
  return parts.join(' ');
});
presetShapes.set('star7', (w, h, adjustments) => {
  // OOXML star7: adj=34601, hf=102572, vf=105210 — center shifted to svc
  const aRaw = adjustments?.get('adj') ?? 34601;
  const a = Math.min(Math.max(aRaw, 0), 50000);
  const swd2 = ((w / 2) * 102572) / 100000;
  const shd2 = ((h / 2) * 105210) / 100000;
  const svc = shd2; // = vc * vf/100000 so top vertex at svc - shd2 = 0
  const iwd2 = (swd2 * a) / 50000;
  const ihd2 = (shd2 * a) / 50000;
  const cx = w / 2;
  const step = (2 * Math.PI) / 7;
  const halfStep = step / 2;
  const startAngle = -Math.PI / 2;
  const parts: string[] = [];
  for (let i = 0; i < 7; i++) {
    const outerAngle = startAngle + step * i;
    const innerAngle = outerAngle + halfStep;
    const ox = cx + swd2 * Math.cos(outerAngle);
    const oy = svc + shd2 * Math.sin(outerAngle);
    const ix = cx + iwd2 * Math.cos(innerAngle);
    const iy = svc + ihd2 * Math.sin(innerAngle);
    parts.push(i === 0 ? `M${ox},${oy}` : `L${ox},${oy}`);
    parts.push(`L${ix},${iy}`);
  }
  parts.push('Z');
  return parts.join(' ');
});
presetShapes.set('star8', (w, h, adjustments) => {
  // OOXML: iwd2 = wd2 * adj / 50000. adj default=37500 → innerRatio = 37500/50000 = 0.75
  // adj() divides by 100000, so we multiply by 2 to get adj/50000.
  const a = adj(adjustments, 'adj', 37500) * 2;
  return starShape(w, h, 8, Math.min(Math.max(a, 0), 1));
});
presetShapes.set('star10', (w, h, adjustments) => {
  // OOXML: adj=42533, hf=105146 — horizontal scaling factor
  const aRaw = adjustments?.get('adj') ?? 42533;
  const a = Math.min(Math.max(aRaw, 0), 50000);
  const hf = 105146;
  const swd2 = ((w / 2) * hf) / 100000;
  const shd2 = h / 2; // no vf for star10
  const iwd2 = (swd2 * a) / 50000;
  const ihd2 = (shd2 * a) / 50000;
  const cx = w / 2;
  const cy = h / 2;
  const step = (2 * Math.PI) / 10;
  const halfStep = step / 2;
  const startAngle = -Math.PI / 2;
  const parts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const outerAngle = startAngle + step * i;
    const innerAngle = outerAngle + halfStep;
    const ox = cx + swd2 * Math.cos(outerAngle);
    const oy = cy + shd2 * Math.sin(outerAngle);
    const ix = cx + iwd2 * Math.cos(innerAngle);
    const iy = cy + ihd2 * Math.sin(innerAngle);
    parts.push(i === 0 ? `M${ox},${oy}` : `L${ox},${oy}`);
    parts.push(`L${ix},${iy}`);
  }
  parts.push('Z');
  return parts.join(' ');
});
presetShapes.set('star12', (w, h, adjustments) => {
  // OOXML default adj=37500 → innerRatio = 0.75
  const a = adj(adjustments, 'adj', 37500) * 2;
  return starShape(w, h, 12, Math.min(Math.max(a, 0), 1));
});
presetShapes.set('star16', (w, h, adjustments) => {
  // OOXML default adj=37500 → innerRatio = 0.75
  const a = adj(adjustments, 'adj', 37500) * 2;
  return starShape(w, h, 16, Math.min(Math.max(a, 0), 1));
});
presetShapes.set('star24', (w, h, adjustments) => {
  // OOXML default adj=37500 → innerRatio = 0.75
  const a = adj(adjustments, 'adj', 37500) * 2;
  return starShape(w, h, 24, Math.min(Math.max(a, 0), 1));
});
presetShapes.set('star32', (w, h, adjustments) => {
  // OOXML default adj=37500 → innerRatio = 0.75
  const a = adj(adjustments, 'adj', 37500) * 2;
  return starShape(w, h, 32, Math.min(Math.max(a, 0), 1));
});

// ===== Lines & Connectors =====

// OOXML line: diagonal (0,0→w,h) when both extents are non-zero.
// Keep explicit horizontal/vertical handling for zero-extent cases so 1px SVGs remain visible.
presetShapes.set('line', (w, h) => {
  const safeH = h || 1;
  const safeW = w || 1;
  if (w === 0) return `M0.5,0 L0.5,${safeH}`;
  if (h === 0) return `M0,0.5 L${safeW},0.5`;
  return `M0,0 L${w},${h}`;
});

// Inverse diagonal line (top-right to bottom-left).
presetShapes.set('lineInv', (w, h) => {
  const safeH = h || 1;
  const safeW = w || 1;
  if (w === 0) return `M0.5,0 L0.5,${safeH}`;
  if (h === 0) return `M0,0.5 L${safeW},0.5`;
  return `M${w},0 L0,${h}`;
});

// When one dimension is 0, draw horizontal or vertical line (same as 'line') so gradient and stroke are correct
presetShapes.set('straightConnector1', (w, h) => {
  const safeH = h || 1;
  const safeW = w || 1;
  if (w === 0) return `M0.5,0 L0.5,${safeH}`;
  if (h === 0) return `M0,0.5 L${safeW},0.5`;
  return `M0,0 L${w},${h}`;
});

presetShapes.set('bentConnector2', (w, h) => `M0,0 L${w},0 L${w},${h}`);

presetShapes.set('bentConnector3', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj1', 50000);
  const midX = w * a;
  return `M0,0 L${midX},0 L${midX},${h} L${w},${h}`;
});

presetShapes.set('bentConnector4', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 50000);
  const a2 = adj(adjustments, 'adj2', 50000);
  const midX = w * a1;
  const midY = h * a2;
  return `M0,0 L${midX},0 L${midX},${midY} L${w},${midY} L${w},${h}`;
});

presetShapes.set('curvedConnector2', (w, h) => {
  return `M0,0 C${w},0 0,${h} ${w},${h}`;
});

presetShapes.set('curvedConnector3', (w, h, adjustments) => {
  // OOXML: two cubic Bezier segments joined at midpoint (x2, vc)
  const x2 = w * adj(adjustments, 'adj1', 50000);
  const x1 = x2 / 2; // +/ l x2 2
  const x3 = (w + x2) / 2; // +/ r x2 2
  const vc = h / 2;
  const hd4 = h / 4;
  const y3 = (h * 3) / 4;
  return `M0,0 C${x1},0 ${x2},${hd4} ${x2},${vc} C${x2},${y3} ${x3},${h} ${w},${h}`;
});

presetShapes.set('curvedConnector4', (w, h, adjustments) => {
  // OOXML: three cubic Bezier segments
  const x2 = w * adj(adjustments, 'adj1', 50000);
  const y4 = h * adj(adjustments, 'adj2', 50000);
  const x1 = x2 / 2; // +/ l x2 2
  const x3 = (w + x2) / 2; // +/ r x2 2
  const x4 = (x2 + x3) / 2; // +/ x2 x3 2
  const x5 = (x3 + w) / 2; // +/ x3 r 2
  const y1 = y4 / 2; // +/ t y4 2
  const y2 = y1 / 2; // +/ t y1 2
  const y3 = (y1 + y4) / 2; // +/ y1 y4 2
  const y5 = (h + y4) / 2; // +/ b y4 2
  return [
    `M0,0`,
    `C${x1},0 ${x2},${y2} ${x2},${y1}`,
    `C${x2},${y3} ${x4},${y4} ${x3},${y4}`,
    `C${x5},${y4} ${w},${y5} ${w},${h}`,
  ].join(' ');
});

presetShapes.set('curvedConnector5', (w, h, adjustments) => {
  // OOXML: four cubic Bezier segments
  const x3 = w * adj(adjustments, 'adj1', 50000);
  const y4 = h * adj(adjustments, 'adj2', 50000);
  const x6 = w * adj(adjustments, 'adj3', 50000);
  const x1 = (x3 + x6) / 2; // +/ x3 x6 2
  const x2 = x3 / 2; // +/ l x3 2
  const x4 = (x3 + x1) / 2; // +/ x3 x1 2
  const x5 = (x6 + x1) / 2; // +/ x6 x1 2
  const x7 = (x6 + w) / 2; // +/ x6 r 2
  const y1 = y4 / 2; // +/ t y4 2
  const y2 = y1 / 2; // +/ t y1 2
  const y3 = (y1 + y4) / 2; // +/ y1 y4 2
  const y5 = (h + y4) / 2; // +/ b y4 2
  const y6 = (y5 + y4) / 2; // +/ y5 y4 2
  const y7 = (y5 + h) / 2; // +/ y5 b 2
  return [
    `M0,0`,
    `C${x2},0 ${x3},${y2} ${x3},${y1}`,
    `C${x3},${y3} ${x4},${y4} ${x1},${y4}`,
    `C${x5},${y4} ${x6},${y6} ${x6},${y5}`,
    `C${x6},${y7} ${x7},${h} ${w},${h}`,
  ].join(' ');
});

presetShapes.set('bentConnector5', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 50000);
  const a2 = adj(adjustments, 'adj2', 50000);
  const a3 = adj(adjustments, 'adj3', 50000);
  const x1 = w * a1;
  const y1 = h * a2;
  const x2 = w * a3;
  return `M0,0 L${x1},0 L${x1},${y1} L${x2},${y1} L${x2},${h} L${w},${h}`;
});

// ===== Arrow Shapes =====

presetShapes.set('rightArrow', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 50000); // shaft width ratio
  const a2 = adj(adjustments, 'adj2', 50000); // head length ratio
  const ss = Math.min(w, h); // OOXML uses short side for head length
  const shaftHalfH = (h * a1) / 2;
  const headLen = ss * a2;
  const cy = h / 2;
  const shaftEnd = w - headLen;
  return [
    `M0,${cy - shaftHalfH}`,
    `L${shaftEnd},${cy - shaftHalfH}`,
    `L${shaftEnd},0`,
    `L${w},${cy}`,
    `L${shaftEnd},${h}`,
    `L${shaftEnd},${cy + shaftHalfH}`,
    `L0,${cy + shaftHalfH}`,
    'Z',
  ].join(' ');
});

presetShapes.set('leftArrow', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 50000);
  const a2 = adj(adjustments, 'adj2', 50000);
  const ss = Math.min(w, h);
  const shaftHalfH = (h * a1) / 2;
  const headLen = ss * a2;
  const cy = h / 2;
  return [
    `M${w},${cy - shaftHalfH}`,
    `L${headLen},${cy - shaftHalfH}`,
    `L${headLen},0`,
    `L0,${cy}`,
    `L${headLen},${h}`,
    `L${headLen},${cy + shaftHalfH}`,
    `L${w},${cy + shaftHalfH}`,
    'Z',
  ].join(' ');
});

presetShapes.set('upArrow', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 50000);
  const a2 = adj(adjustments, 'adj2', 50000);
  const shaftHalfW = (w * a1) / 2;
  const headLen = h * a2;
  const cx = w / 2;
  return [
    `M${cx - shaftHalfW},${h}`,
    `L${cx - shaftHalfW},${headLen}`,
    `L0,${headLen}`,
    `L${cx},0`,
    `L${w},${headLen}`,
    `L${cx + shaftHalfW},${headLen}`,
    `L${cx + shaftHalfW},${h}`,
    'Z',
  ].join(' ');
});

presetShapes.set('downArrow', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 50000);
  const a2 = adj(adjustments, 'adj2', 50000);
  const shaftHalfW = (w * a1) / 2;
  const headLen = h * a2;
  const cx = w / 2;
  const shaftEnd = h - headLen;
  return [
    `M${cx - shaftHalfW},0`,
    `L${cx + shaftHalfW},0`,
    `L${cx + shaftHalfW},${shaftEnd}`,
    `L${w},${shaftEnd}`,
    `L${cx},${h}`,
    `L0,${shaftEnd}`,
    `L${cx - shaftHalfW},${shaftEnd}`,
    'Z',
  ].join(' ');
});

presetShapes.set('downArrowCallout', (w, h, adjustments) => {
  // ECMA-like callout geometry (4 adjustments).
  const adj1 = adjustments?.get('adj1') ?? 25000;
  const adj2 = adjustments?.get('adj2') ?? 25000;
  const adj3 = adjustments?.get('adj3') ?? 25000;
  const adj4 = adjustments?.get('adj4') ?? 64977;
  const ss = Math.min(w, h);
  const a2 = Math.max(0, Math.min(adj2, (50000 * w) / Math.max(ss, 1)));
  const a1 = Math.max(0, Math.min(adj1, a2 * 2));
  const a3 = Math.max(0, Math.min(adj3, (100000 * h) / Math.max(ss, 1)));
  const q2 = (a3 * ss) / Math.max(h, 1);
  const a4 = Math.max(0, Math.min(adj4, 100000 - q2));
  const hc = w / 2;
  const dx1 = (ss * a2) / 100000;
  const dx2 = (ss * a1) / 200000;
  const x1 = hc - dx1;
  const x2 = hc - dx2;
  const x3 = hc + dx2;
  const x4 = hc + dx1;
  const y3 = h - (ss * a3) / 100000;
  const y2 = (h * a4) / 100000;
  return [
    `M0,0`,
    `L${w},0`,
    `L${w},${y2}`,
    `L${x3},${y2}`,
    `L${x3},${y3}`,
    `L${x4},${y3}`,
    `L${hc},${h}`,
    `L${x1},${y3}`,
    `L${x2},${y3}`,
    `L${x2},${y2}`,
    `L0,${y2}`,
    'Z',
  ].join(' ');
});

presetShapes.set('rightArrowCallout', (w, h, adjustments) => {
  // OOXML: Rectangle body + right-pointing arrowhead (11-point polygon, 4 adj)
  const ss = Math.min(w, h);
  const maxAdj2 = (50000 * h) / Math.max(ss, 1);
  const a2 = Math.max(0, Math.min(adjustments?.get('adj2') ?? 25000, maxAdj2));
  const a1 = Math.max(0, Math.min(adjustments?.get('adj1') ?? 25000, a2 * 2));
  const maxAdj3 = (100000 * w) / Math.max(ss, 1);
  const a3 = Math.max(0, Math.min(adjustments?.get('adj3') ?? 25000, maxAdj3));
  const q2 = (a3 * ss) / Math.max(w, 1);
  const a4 = Math.max(0, Math.min(adjustments?.get('adj4') ?? 64977, 100000 - q2));
  const vc = h / 2;
  const dy1 = (ss * a2) / 100000;
  const dy2 = (ss * a1) / 200000;
  const y1 = vc - dy1;
  const y2 = vc - dy2;
  const y3 = vc + dy2;
  const y4 = vc + dy1;
  const dx3 = (ss * a3) / 100000;
  const x3 = w - dx3;
  const x2 = (w * a4) / 100000;
  return [
    `M0,0`,
    `L${x2},0`,
    `L${x2},${y2}`,
    `L${x3},${y2}`,
    `L${x3},${y1}`,
    `L${w},${vc}`,
    `L${x3},${y4}`,
    `L${x3},${y3}`,
    `L${x2},${y3}`,
    `L${x2},${h}`,
    `L0,${h}`,
    'Z',
  ].join(' ');
});

presetShapes.set('leftArrowCallout', (w, h, adjustments) => {
  // OOXML: Mirror of rightArrowCallout — arrowhead points left
  const ss = Math.min(w, h);
  const maxAdj2 = (50000 * h) / Math.max(ss, 1);
  const a2 = Math.max(0, Math.min(adjustments?.get('adj2') ?? 25000, maxAdj2));
  const a1 = Math.max(0, Math.min(adjustments?.get('adj1') ?? 25000, a2 * 2));
  const maxAdj3 = (100000 * w) / Math.max(ss, 1);
  const a3 = Math.max(0, Math.min(adjustments?.get('adj3') ?? 25000, maxAdj3));
  const q2 = (a3 * ss) / Math.max(w, 1);
  const a4 = Math.max(0, Math.min(adjustments?.get('adj4') ?? 64977, 100000 - q2));
  const vc = h / 2;
  const dy1 = (ss * a2) / 100000;
  const dy2 = (ss * a1) / 200000;
  const y1 = vc - dy1;
  const y2 = vc - dy2;
  const y3 = vc + dy2;
  const y4 = vc + dy1;
  const x1 = (ss * a3) / 100000;
  const dx2 = (w * a4) / 100000;
  const x2 = w - dx2;
  return [
    `M0,${vc}`,
    `L${x1},${y1}`,
    `L${x1},${y2}`,
    `L${x2},${y2}`,
    `L${x2},0`,
    `L${w},0`,
    `L${w},${h}`,
    `L${x2},${h}`,
    `L${x2},${y3}`,
    `L${x1},${y3}`,
    `L${x1},${y4}`,
    'Z',
  ].join(' ');
});

presetShapes.set('upArrowCallout', (w, h, adjustments) => {
  // OOXML: Vertical variant — arrowhead points up
  const ss = Math.min(w, h);
  const maxAdj2 = (50000 * w) / Math.max(ss, 1);
  const a2 = Math.max(0, Math.min(adjustments?.get('adj2') ?? 25000, maxAdj2));
  const a1 = Math.max(0, Math.min(adjustments?.get('adj1') ?? 25000, a2 * 2));
  const maxAdj3 = (100000 * h) / Math.max(ss, 1);
  const a3 = Math.max(0, Math.min(adjustments?.get('adj3') ?? 25000, maxAdj3));
  const q2 = (a3 * ss) / Math.max(h, 1);
  const a4 = Math.max(0, Math.min(adjustments?.get('adj4') ?? 64977, 100000 - q2));
  const hc = w / 2;
  const dx1 = (ss * a2) / 100000;
  const dx2 = (ss * a1) / 200000;
  const x1 = hc - dx1;
  const x2 = hc - dx2;
  const x3 = hc + dx2;
  const x4 = hc + dx1;
  const y1 = (ss * a3) / 100000;
  const dy2 = (h * a4) / 100000;
  const y2 = h - dy2;
  return [
    `M0,${y2}`,
    `L${x2},${y2}`,
    `L${x2},${y1}`,
    `L${x1},${y1}`,
    `L${hc},0`,
    `L${x4},${y1}`,
    `L${x3},${y1}`,
    `L${x3},${y2}`,
    `L${w},${y2}`,
    `L${w},${h}`,
    `L0,${h}`,
    'Z',
  ].join(' ');
});

presetShapes.set('upDownArrowCallout', (w, h, adjustments) => {
  // OOXML spec: 4 adjustments
  const adj1Raw = adjustments?.get('adj1') ?? 25000;
  const adj2Raw = adjustments?.get('adj2') ?? 25000;
  const adj3Raw = adjustments?.get('adj3') ?? 25000;
  const adj4Raw = adjustments?.get('adj4') ?? 48123;
  const ss = Math.min(w, h);
  const a2 = Math.max(0, Math.min(adj2Raw, (50000 * w) / Math.max(ss, 1)));
  const a1 = Math.max(0, Math.min(adj1Raw, a2 * 2));
  const a3 = Math.max(0, Math.min(adj3Raw, (50000 * h) / Math.max(ss, 1)));
  const q2 = (a3 * ss) / Math.max(h, 1);
  const a4 = Math.max(0, Math.min(adj4Raw, 100000 - q2 - q2));
  const dx1 = (ss * a2) / 100000;
  const dx2 = (ss * a1) / 200000;
  const hc = w / 2;
  const x1 = hc - dx1;
  const x2 = hc - dx2;
  const x3 = hc + dx2;
  const x4 = hc + dx1;
  const y1 = (ss * a3) / 100000;
  const dy2 = (h * a4) / 200000;
  const y2 = h / 2 - dy2;
  const y3 = h / 2 + dy2;
  const y4 = h - y1;
  return [
    `M${hc},0`,
    `L${x4},${y1}`,
    `L${x3},${y1}`,
    `L${x3},${y2}`,
    `L${w},${y2}`,
    `L${w},${y3}`,
    `L${x3},${y3}`,
    `L${x3},${y4}`,
    `L${x4},${y4}`,
    `L${hc},${h}`,
    `L${x1},${y4}`,
    `L${x2},${y4}`,
    `L${x2},${y3}`,
    `L0,${y3}`,
    `L0,${y2}`,
    `L${x2},${y2}`,
    `L${x2},${y1}`,
    `L${x1},${y1}`,
    'Z',
  ].join(' ');
});

presetShapes.set('leftRightArrowCallout', (w, h, adjustments) => {
  // OOXML spec: 4 adjustments
  const adj1Raw = adjustments?.get('adj1') ?? 25000;
  const adj2Raw = adjustments?.get('adj2') ?? 25000;
  const adj3Raw = adjustments?.get('adj3') ?? 25000;
  const adj4Raw = adjustments?.get('adj4') ?? 48123;
  const ss = Math.min(w, h);
  const a2 = Math.max(0, Math.min(adj2Raw, (50000 * h) / Math.max(ss, 1)));
  const a1 = Math.max(0, Math.min(adj1Raw, a2 * 2));
  const a3 = Math.max(0, Math.min(adj3Raw, (50000 * w) / Math.max(ss, 1)));
  const q2 = (a3 * ss) / Math.max(w, 1);
  const a4 = Math.max(0, Math.min(adj4Raw, 100000 - q2 - q2));
  const dy1 = (ss * a2) / 100000;
  const dy2 = (ss * a1) / 200000;
  const vc = h / 2;
  const y1 = vc - dy1;
  const y2 = vc - dy2;
  const y3 = vc + dy2;
  const y4 = vc + dy1;
  const x1 = (ss * a3) / 100000;
  const dx2 = (w * a4) / 200000;
  const x2 = w / 2 - dx2;
  const x3 = w / 2 + dx2;
  const x4 = w - x1;
  return [
    `M0,${vc}`,
    `L${x1},${y1}`,
    `L${x1},${y2}`,
    `L${x2},${y2}`,
    `L${x2},0`,
    `L${x3},0`,
    `L${x3},${y2}`,
    `L${x4},${y2}`,
    `L${x4},${y1}`,
    `L${w},${vc}`,
    `L${x4},${y4}`,
    `L${x4},${y3}`,
    `L${x3},${y3}`,
    `L${x3},${h}`,
    `L${x2},${h}`,
    `L${x2},${y3}`,
    `L${x1},${y3}`,
    `L${x1},${y4}`,
    'Z',
  ].join(' ');
});

presetShapes.set('uturnArrow', (w, h, adjustments) => {
  // ECMA-like U-turn arrow geometry (5 adjustments).
  const adj1 = adjustments?.get('adj1') ?? 25000;
  const adj2 = adjustments?.get('adj2') ?? 25000;
  const adj3 = adjustments?.get('adj3') ?? 25000;
  const adj4 = adjustments?.get('adj4') ?? 43750;
  const adj5 = adjustments?.get('adj5') ?? 75000;
  const ss = Math.min(w, h);
  const a2 = Math.max(0, Math.min(adj2, 25000));
  const a1 = Math.max(0, Math.min(adj1, a2 * 2));
  const q2 = (a1 * ss) / Math.max(h, 1);
  const q3 = 100000 - q2;
  const a3 = Math.max(0, Math.min(adj3, (q3 * h) / Math.max(ss, 1)));
  const minAdj5 = ((a3 + a1) * ss) / Math.max(h, 1);
  const a5 = Math.max(minAdj5, Math.min(adj5, 100000));

  const th = (ss * a1) / 100000;
  const aw2 = (ss * a2) / 100000;
  const th2 = th / 2;
  const dh2 = aw2 - th2;
  const y5 = (h * a5) / 100000;
  const ah = (ss * a3) / 100000;
  const y4 = y5 - ah;
  const x9 = w - dh2;
  const bs = Math.min(x9 / 2, y4);
  const a4 = Math.max(0, Math.min(adj4, (100000 * bs) / Math.max(ss, 1)));
  const bd = (ss * a4) / 100000;
  const bd2 = Math.max(bd - th, 0);
  const x3 = th + bd2;
  const x8 = w - aw2;
  const x6 = x8 - aw2;
  const x7 = x6 + dh2;
  const x4 = x9 - bd;
  const x5 = x7 - bd2;

  return [
    `M0,${h}`,
    `L0,${bd}`,
    bd > 0.1 ? `A${bd},${bd} 0 0,1 ${bd},0` : `L0,0`,
    `L${x4},0`,
    bd > 0.1 ? `A${bd},${bd} 0 0,1 ${x9},${bd}` : `L${x9},0`,
    `L${x9},${y4}`,
    `L${w},${y4}`,
    `L${x8},${y5}`,
    `L${x6},${y4}`,
    `L${x7},${y4}`,
    `L${x7},${x3}`,
    bd2 > 0.1 ? `A${bd2},${bd2} 0 0,0 ${x5},${th}` : `L${x5},${th}`,
    `L${x3},${th}`,
    bd2 > 0.1 ? `A${bd2},${bd2} 0 0,0 ${th},${x3}` : `L${th},${x3}`,
    `L${th},${h}`,
    'Z',
  ].join(' ');
});

presetShapes.set('leftRightArrow', (w, h, adjustments) => {
  // OOXML: adj1=50000 (shaft width), adj2=50000 (head length based on ss)
  const ss = Math.min(w, h);
  const hd2 = h / 2;
  const maxAdj2 = ss > 0 ? (50000 * w) / ss : 0;
  const a1 = Math.min(Math.max(adjustments?.get('adj1') ?? 50000, 0), 100000);
  const a2 = Math.min(Math.max(adjustments?.get('adj2') ?? 50000, 0), maxAdj2);
  const x2 = (ss * a2) / 100000;
  const x3 = w - x2;
  const dy = (h * a1) / 200000;
  const vc = hd2;
  const y1 = vc - dy;
  const y2 = vc + dy;
  const dx1 = hd2 > 0 ? (y1 * x2) / hd2 : 0;
  const _x1 = x2 - dx1;
  const _x4 = x3 + dx1;
  return [
    `M0,${vc}`,
    `L${x2},0`,
    `L${x2},${y1}`,
    `L${x3},${y1}`,
    `L${x3},0`,
    `L${w},${vc}`,
    `L${x3},${h}`,
    `L${x3},${y2}`,
    `L${x2},${y2}`,
    `L${x2},${h}`,
    'Z',
  ].join(' ');
});

presetShapes.set('leftUpArrow', (w, h, adjustments) => {
  // OOXML preset formula (presetShapeDefinitions.xml -> leftUpArrow)
  const rawAdj2 = Math.max(0, Math.min(adjustments?.get('adj2') ?? 25000, 50000));
  const maxAdj1 = rawAdj2 * 2;
  const rawAdj1 = Math.max(0, Math.min(adjustments?.get('adj1') ?? 25000, maxAdj1));
  const maxAdj3 = 100000 - maxAdj1;
  const rawAdj3 = Math.max(0, Math.min(adjustments?.get('adj3') ?? 25000, maxAdj3));

  const ss = Math.min(w, h);
  const x1 = (ss * rawAdj3) / 100000;
  const dx2 = (ss * rawAdj2) / 50000;
  const x2 = w - dx2;
  const y2 = h - dx2;
  const dx4 = (ss * rawAdj2) / 100000;
  const x4 = w - dx4;
  const y4 = h - dx4;
  const dx3 = (ss * rawAdj1) / 200000;
  const x3 = x4 - dx3;
  const x5 = x4 + dx3;
  const y3 = y4 - dx3;
  const y5 = y4 + dx3;

  return [
    `M0,${y4}`,
    `L${x1},${y2}`,
    `L${x1},${y3}`,
    `L${x3},${y3}`,
    `L${x3},${x1}`,
    `L${x2},${x1}`,
    `L${x4},0`,
    `L${w},${x1}`,
    `L${x5},${x1}`,
    `L${x5},${y5}`,
    `L${x1},${y5}`,
    `L${x1},${h}`,
    'Z',
  ].join(' ');
});

presetShapes.set('upDownArrow', (w, h, adjustments) => {
  // OOXML spec: adj1=50000 (shaft width), adj2=50000 (head length on ss)
  const adj1Raw = adjustments?.get('adj1') ?? 50000;
  const adj2Raw = adjustments?.get('adj2') ?? 50000;
  const ss = Math.min(w, h);
  const maxAdj2 = (50000 * h) / Math.max(ss, 1);
  const a2 = Math.max(0, Math.min(adj2Raw, maxAdj2));
  const a1 = Math.max(0, Math.min(adj1Raw, 100000));
  const dx1 = (ss * a1) / 200000; // shaft half-width
  const dy = (ss * a2) / 100000; // arrowhead length
  const hc = w / 2;
  return [
    `M${hc},0`,
    `L${w},${dy}`,
    `L${hc + dx1},${dy}`,
    `L${hc + dx1},${h - dy}`,
    `L${w},${h - dy}`,
    `L${hc},${h}`,
    `L0,${h - dy}`,
    `L${hc - dx1},${h - dy}`,
    `L${hc - dx1},${dy}`,
    `L0,${dy}`,
    'Z',
  ].join(' ');
});

presetShapes.set('notchedRightArrow', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 50000); // shaft width ratio
  const a2 = adj(adjustments, 'adj2', 50000); // head length ratio
  const ss = Math.min(w, h); // OOXML uses short side for head length
  const shaftHalfH = (h * a1) / 2;
  const headLen = ss * a2;
  const cy = h / 2;
  const shaftEnd = w - headLen;
  // Notch depth: OOXML formula dxn = dy1 * dx2 / hd2 = shaftHalfH * headLen / (h/2)
  const notchDepth = cy > 0 ? (shaftHalfH * headLen) / cy : 0;
  return [
    `M0,${cy - shaftHalfH}`,
    `L${shaftEnd},${cy - shaftHalfH}`,
    `L${shaftEnd},0`,
    `L${w},${cy}`,
    `L${shaftEnd},${h}`,
    `L${shaftEnd},${cy + shaftHalfH}`,
    `L0,${cy + shaftHalfH}`,
    `L${notchDepth},${cy}`,
    'Z',
  ].join(' ');
});

presetShapes.set('chevron', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 50000);
  const ss = Math.min(w, h);
  const offset = ss * a;
  return [
    `M0,0`,
    `L${w - offset},0`,
    `L${w},${h / 2}`,
    `L${w - offset},${h}`,
    `L0,${h}`,
    `L${offset},${h / 2}`,
    'Z',
  ].join(' ');
});

presetShapes.set('homePlate', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 50000);
  const ss = Math.min(w, h);
  const offset = ss * a;
  const shoulderX = w - offset;
  return [`M0,0`, `L${shoulderX},0`, `L${w},${h / 2}`, `L${shoulderX},${h}`, `L0,${h}`, 'Z'].join(
    ' ',
  );
});

presetShapes.set('stripedRightArrow', (w, h, adjustments) => {
  // OOXML: adj1=50000, adj2=50000 (max 84375). Stripes at ssd32, ssd16-ssd8, x4=ss*5/32.
  const ss = Math.min(w, h);
  const maxAdj2 = ss > 0 ? (84375 * w) / ss : 84375;
  const a1 = Math.min(Math.max(adjRaw(adjustments, 'adj1', 50000), 0), 100000);
  const a2 = Math.min(Math.max(adjRaw(adjustments, 'adj2', 50000), 0), maxAdj2);
  const dy1 = (h * a1) / 200000;
  const dx5 = (ss * a2) / 100000;
  const x5 = w - dx5;
  const vc = h / 2;
  const y1 = vc - dy1;
  const y2 = vc + dy1;
  const ssd32 = ss / 32;
  const ssd16 = ss / 16;
  const ssd8 = ss / 8;
  const x4 = (ss * 5) / 32;
  return [
    // Stripe 1: 0 to ssd32
    `M0,${y1} L${ssd32},${y1} L${ssd32},${y2} L0,${y2} Z`,
    // Stripe 2: ssd16 to ssd8
    `M${ssd16},${y1} L${ssd8},${y1} L${ssd8},${y2} L${ssd16},${y2} Z`,
    // Main body + arrowhead: x4 to r
    `M${x4},${y1}`,
    `L${x5},${y1}`,
    `L${x5},0`,
    `L${w},${vc}`,
    `L${x5},${h}`,
    `L${x5},${y2}`,
    `L${x4},${y2}`,
    'Z',
  ].join(' ');
});

// ===== Bent / Curved / Special Arrows =====

presetShapes.set('bentArrow', (w, h, adjustments) => {
  // OOXML bentArrow: L-shaped arrow with rounded bend, arrowhead pointing right.
  // Uses 4 adjustments per ECMA-376 spec.
  const ss = Math.min(w, h);

  // Constrained adjustments (raw values, not fractions — we do our own math)
  const adj2Raw = Math.max(0, Math.min(adjustments?.get('adj2') ?? 25000, 50000));
  const maxAdj1 = adj2Raw * 2;
  const adj1Raw = Math.max(0, Math.min(adjustments?.get('adj1') ?? 25000, maxAdj1));
  const adj3Raw = Math.max(0, Math.min(adjustments?.get('adj3') ?? 25000, 50000));

  const th = (ss * adj1Raw) / 100000; // shaft width
  const aw2 = (ss * adj2Raw) / 100000; // arrowhead half-width
  const th2 = th / 2;
  const dh2 = aw2 - th2; // arrowhead extension beyond shaft
  const ah = (ss * adj3Raw) / 100000; // arrowhead length

  const bw = w - ah;
  const bh = h - dh2;
  const bs = Math.min(bw, bh);
  const maxAdj4 = bs > 0 ? (100000 * bs) / ss : 0;
  const adj4Raw = Math.max(0, Math.min(adjustments?.get('adj4') ?? 43750, maxAdj4));
  const bd = (ss * adj4Raw) / 100000; // outer bend radius

  const bd2 = Math.max(bd - th, 0); // inner bend radius
  const x3 = th + bd2;
  const x4 = w - ah;

  const y3 = dh2 + th;
  const y4 = y3 + dh2;
  const y5 = dh2 + bd;

  // OOXML arcTo: from current point, arc with radii (wR, hR), start angle stAng, sweep swAng.
  // Arc 1: outer bend — from (0, y5), radii=bd, 180°→270° (sweep +90°)
  //   Center of arc is at (bd, y5) relative, endpoint at (bd, y5-bd) = (bd, dh2)
  //   SVG: A bd,bd 0 0,1 bd,dh2
  // Arc 2: inner bend — from (x3, y3), radii=bd2, 270°→180° (sweep -90°)
  //   Center at (x3, y3+bd2), endpoint at (x3-bd2, y3+bd2) = (th, y3+bd2)
  //   SVG: A bd2,bd2 0 0,0 th,y6  where y6 = y3+bd2

  const y6 = y3 + bd2;

  const parts: string[] = [
    `M0,${h}`, // bottom-left
    `L0,${y5}`, // up left edge to arc start
  ];

  // Outer arc (rounded bend, going from left edge up to top edge)
  if (bd > 0.1) {
    parts.push(`A${bd},${bd} 0 0,1 ${bd},${dh2}`);
  } else {
    parts.push(`L0,${dh2}`); // degenerate: straight corner
  }

  parts.push(
    `L${x4},${dh2}`, // horizontal to arrowhead base (top)
    `L${x4},0`, // up to arrowhead top-left wing
    `L${w},${aw2}`, // arrowhead tip (pointing right)
    `L${x4},${y4}`, // arrowhead bottom wing
    `L${x4},${y3}`, // back to arrowhead base (bottom)
    `L${x3},${y3}`, // horizontal back toward bend
  );

  // Inner arc (rounded bend, going from top down to right side of shaft)
  if (bd2 > 0.1) {
    parts.push(`A${bd2},${bd2} 0 0,0 ${th},${y6}`);
  } else {
    parts.push(`L${th},${y3}`); // degenerate: straight corner
  }

  parts.push(
    `L${th},${h}`, // down right side of shaft to bottom
    'Z',
  );

  return parts.join(' ');
});

presetShapes.set('bentUpArrow', (w, h, adjustments) => {
  // OOXML preset formula (presetShapeDefinitions.xml -> bentUpArrow):
  // x/y variables are solved from adj1/2/3 in [0..50000], ss=min(w,h).
  const raw1 = Math.max(0, Math.min(adjustments?.get('adj1') ?? 25000, 50000));
  const raw2 = Math.max(0, Math.min(adjustments?.get('adj2') ?? 25000, 50000));
  const raw3 = Math.max(0, Math.min(adjustments?.get('adj3') ?? 25000, 50000));
  const ss = Math.min(w, h);

  const y1 = (ss * raw3) / 100000;
  const dx1 = (ss * raw2) / 50000;
  const x1 = w - dx1;
  const dx3 = (ss * raw2) / 100000;
  const x3 = w - dx3;
  const dx2 = (ss * raw1) / 200000;
  const x2 = x3 - dx2;
  const x4 = x3 + dx2;
  const dy2 = (ss * raw1) / 100000;
  const y2 = h - dy2;

  return [
    `M0,${y2}`,
    `L${x2},${y2}`,
    `L${x2},${y1}`,
    `L${x1},${y1}`,
    `L${x3},0`,
    `L${w},${y1}`,
    `L${x4},${y1}`,
    `L${x4},${h}`,
    `L0,${h}`,
    'Z',
  ].join(' ');
});

presetShapes.set('curvedRightArrow', (w, h, adjustments) => {
  // Keep geometry aligned with OOXML preset math. Use local arc helper here
  // because preset formulas mix positive/negative sweeps that do not map 1:1
  // to the generic shapeArc() helper used in other shapes.
  const adj1Raw = adjustments?.get('adj1') ?? 25000;
  const adj2Raw = adjustments?.get('adj2') ?? 50000;
  const adj3Raw = adjustments?.get('adj3') ?? 25000;

  const cnstVal1 = 50000;
  const cnstVal2 = 100000;

  const hd2 = h / 2;
  const r = w;
  const b = h;
  const l = 0;
  const c3d4 = 270;
  const cd2 = 180;
  const cd4 = 90;
  const ss = Math.max(Math.min(w, h), 1);

  const maxAdj2 = (cnstVal1 * h) / ss;
  const a2 = Math.max(0, Math.min(adj2Raw, maxAdj2));
  const a1 = Math.max(0, Math.min(adj1Raw, a2));
  const th = (ss * a1) / cnstVal2;
  const aw = (ss * a2) / cnstVal2;
  const q1 = (th + aw) / 4;
  const hR = hd2 - q1;
  const q7 = hR * 2;
  const q8 = q7 * q7;
  const q9 = th * th;
  const q10 = Math.max(q8 - q9, 0);
  const q11 = Math.sqrt(q10);
  const iDx = (q11 * w) / Math.max(q7, 1e-6);
  const maxAdj3 = (cnstVal2 * iDx) / ss;
  const a3 = Math.max(0, Math.min(adj3Raw, maxAdj3));
  const ah = (ss * a3) / cnstVal2;
  const y3 = hR + th;
  const q2 = w * w;
  const q3 = ah * ah;
  const q4 = Math.max(q2 - q3, 0);
  const q5 = Math.sqrt(q4);
  const dy = (q5 * hR) / Math.max(w, 1e-6);
  const y5 = hR + dy;
  const y7 = y3 + dy;
  const q6 = aw - th;
  const dh = q6 / 2;
  const y4 = y5 - dh;
  const y8 = y7 + dh;
  const aw2 = aw / 2;
  const y6 = b - aw2;
  const x1 = r - ah;
  const swAng = Math.atan(dy / Math.max(ah, 1e-6));
  const stAng = Math.PI - swAng;
  const mswAng = -swAng;
  const q12 = th / 2;
  const dang2 = Math.atan2(q12, Math.max(iDx, 1e-6));
  const swAng2 = dang2 - Math.PI / 2;
  const stAngDg = (stAng * 180) / Math.PI;
  const mswAngDg = (mswAng * 180) / Math.PI;
  const swAngDg = (swAng * 180) / Math.PI;
  const swAng2Dg = (swAng2 * 180) / Math.PI;

  const arc = (
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    startDeg: number,
    endDeg: number,
  ): string => {
    const s = (startDeg * Math.PI) / 180;
    const e = (endDeg * Math.PI) / 180;
    const xS = cx + rx * Math.cos(s);
    const yS = cy + ry * Math.sin(s);
    const xE = cx + rx * Math.cos(e);
    const yE = cy + ry * Math.sin(e);
    const delta = endDeg - startDeg;
    const largeArc = Math.abs(delta) > 180 ? 1 : 0;
    const sweep = delta >= 0 ? 1 : 0;
    return `M${xS},${yS} A${rx},${ry} 0 ${largeArc},${sweep} ${xE},${yE}`;
  };

  return [
    `M${l},${hR}`,
    arc(w, hR, w, hR, cd2, cd2 + mswAngDg).replace('M', 'L'),
    `L${x1},${y5}`,
    `L${x1},${y4}`,
    `L${r},${y6}`,
    `L${x1},${y8}`,
    `L${x1},${y7}`,
    arc(w, y3, w, hR, stAngDg, stAngDg + swAngDg).replace('M', 'L'),
    'Z',
    arc(w, hR, w, hR, cd2, cd2 + cd4),
    `L${r},${th}`,
    arc(w, y3, w, hR, c3d4, c3d4 + swAng2Dg).replace('M', 'L'),
    'Z',
  ].join(' ');
});

presetShapes.set('curvedLeftArrow', (w, h, adjustments) =>
  mirrorAbsolutePathHorizontally(presetShapes.get('curvedRightArrow')!(w, h, adjustments), w),
);

function splitFirstClosedContour(path: string): { outer: string; remainder: string } {
  const closeIdx = path.indexOf('Z');
  if (closeIdx === -1) {
    return { outer: path, remainder: '' };
  }
  const outer = path.slice(0, closeIdx + 1).trim();
  const remainder = path.slice(closeIdx + 1).trim();
  return { outer, remainder };
}

function buildCurvedArrowMultiPath(
  shapeName: 'curvedRightArrow' | 'curvedLeftArrow',
  w: number,
  h: number,
  adjustments?: Map<string, number>,
): PresetSubPath[] {
  const fullPath = presetShapes.get(shapeName)!(w, h, adjustments);
  const { outer, remainder } = splitFirstClosedContour(fullPath);
  if (!remainder) {
    return [{ d: fullPath, fill: 'norm', stroke: true }];
  }

  if (shapeName === 'curvedRightArrow') {
    return [
      { d: remainder, fill: 'norm', stroke: true },
      { d: outer, fill: 'norm', stroke: true },
    ];
  }

  return [
    { d: outer, fill: 'norm', stroke: true },
    { d: remainder, fill: 'norm', stroke: true },
  ];
}

function buildCurvedVerticalArrowMultiPath(
  shapeName: 'curvedUpArrow' | 'curvedDownArrow',
  w: number,
  h: number,
  adjustments?: Map<string, number>,
): PresetSubPath[] {
  const downFullPath = presetShapes.get('curvedDownArrow')!(w, h, adjustments);
  const { outer, remainder } = splitFirstClosedContour(downFullPath);
  const ordered: PresetSubPath[] = remainder
    ? [
        { d: remainder, fill: 'norm', stroke: true },
        { d: outer, fill: 'norm', stroke: true },
      ]
    : [{ d: downFullPath, fill: 'norm', stroke: true }];

  if (shapeName === 'curvedDownArrow') {
    return ordered;
  }

  const mirrored: PresetSubPath[] = ordered.map((path) => ({
    ...path,
    d: mirrorAbsolutePathVertically(path.d, h),
  }));
  return mirrored.reverse();
}

/**
 * Convert OOXML arcTo to SVG arc endpoint and command string.
 * OOXML arcTo: wR, hR (radii), stAng, swAng (degrees).
 * Current point is at stAng on the arc ellipse.
 * Returns { path, endX, endY }.
 */
presetShapes.set('curvedUpArrow', (w, h, adjustments) => {
  const arc = (
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    startDeg: number,
    endDeg: number,
  ): string => {
    const s = (startDeg * Math.PI) / 180;
    const e = (endDeg * Math.PI) / 180;
    const xS = cx + rx * Math.cos(s);
    const yS = cy + ry * Math.sin(s);
    const xE = cx + rx * Math.cos(e);
    const yE = cy + ry * Math.sin(e);
    const delta = endDeg - startDeg;
    const largeArc = Math.abs(delta) > 180 ? 1 : 0;
    const sweep = delta >= 0 ? 1 : 0;
    return `M${xS},${yS} A${rx},${ry} 0 ${largeArc},${sweep} ${xE},${yE}`;
  };

  const ss = Math.min(w, h);
  const wd2 = w / 2;
  const a1Raw = adjustments?.get('adj1') ?? 25000;
  const a2Raw = adjustments?.get('adj2') ?? 50000;
  const a3Raw = adjustments?.get('adj3') ?? 25000;
  const maxAdj2 = (50000 * w) / Math.max(ss, 1);
  const a2 = Math.max(0, Math.min(a2Raw, maxAdj2));
  const a1 = Math.max(0, Math.min(a1Raw, 100000));
  const th = (ss * a1) / 100000;
  const aw = (ss * a2) / 100000;
  const q1 = (th + aw) / 4;
  const wR = wd2 - q1;
  const q7 = wR * 2;
  const idy = (Math.sqrt(Math.max(q7 * q7 - th * th, 0)) * h) / Math.max(q7, 1);
  const maxAdj3 = (100000 * idy) / Math.max(ss, 1);
  const a3 = Math.max(0, Math.min(a3Raw, maxAdj3));
  const ah = (ss * a3) / 100000;
  const x3 = wR + th;
  const dx = (Math.sqrt(Math.max(h * h - ah * ah, 0)) * wR) / Math.max(h, 1);
  const x5 = wR + dx;
  const x7 = x3 + dx;
  const dh = (aw - th) / 2;
  const x4 = x5 - dh;
  const x8 = x7 + dh;
  const x6 = w - aw / 2;
  const y1 = ah;

  const swAng = Math.atan2(dx, ah);
  const dang2 = Math.atan2(th / 2, idy);
  const stAng2 = Math.PI / 2 - dang2;
  const swAng2 = dang2 - swAng;
  const stAng3 = Math.PI / 2 - swAng;
  const stAng2Deg = (stAng2 * 180) / Math.PI;
  const swAng2Deg = (swAng2 * 180) / Math.PI;
  const stAng3Deg = (stAng3 * 180) / Math.PI;
  const swAngDeg = (swAng * 180) / Math.PI;

  return [
    arc(wR, 0, wR, h, stAng2Deg, stAng2Deg + swAng2Deg),
    `L${x5},${y1}`,
    `L${x4},${y1}`,
    `L${x6},0`,
    `L${x8},${y1}`,
    `L${x7},${y1}`,
    arc(x3, 0, wR, h, stAng3Deg, stAng3Deg + swAngDeg).replace('M', 'L'),
    `L${wR},${h}`,
    arc(wR, 0, wR, h, 90, 180).replace('M', 'L'),
    `L${th},0`,
    arc(x3, 0, wR, h, 180, 90).replace('M', 'L'),
    'Z',
  ].join(' ');
});

presetShapes.set('curvedDownArrow', (w, h, adjustments) => {
  const arc = (
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    startDeg: number,
    endDeg: number,
  ): string => {
    const s = (startDeg * Math.PI) / 180;
    const e = (endDeg * Math.PI) / 180;
    const xS = cx + rx * Math.cos(s);
    const yS = cy + ry * Math.sin(s);
    const xE = cx + rx * Math.cos(e);
    const yE = cy + ry * Math.sin(e);
    const delta = endDeg - startDeg;
    const largeArc = Math.abs(delta) > 180 ? 1 : 0;
    const sweep = delta >= 0 ? 1 : 0;
    return `M${xS},${yS} A${rx},${ry} 0 ${largeArc},${sweep} ${xE},${yE}`;
  };

  const ss = Math.min(w, h);
  const wd2 = w / 2;
  const a1Raw = adjustments?.get('adj1') ?? 25000;
  const a2Raw = adjustments?.get('adj2') ?? 50000;
  const a3Raw = adjustments?.get('adj3') ?? 25000;
  const maxAdj2 = (50000 * w) / Math.max(ss, 1);
  const a2 = Math.max(0, Math.min(a2Raw, maxAdj2));
  const a1 = Math.max(0, Math.min(a1Raw, 100000));
  const th = (ss * a1) / 100000;
  const aw = (ss * a2) / 100000;
  const q1 = (th + aw) / 4;
  const wR = wd2 - q1;
  const q7 = wR * 2;
  const idy = (Math.sqrt(Math.max(q7 * q7 - th * th, 0)) * h) / Math.max(q7, 1);
  const maxAdj3 = (100000 * idy) / Math.max(ss, 1);
  const a3 = Math.max(0, Math.min(a3Raw, maxAdj3));
  const ah = (ss * a3) / 100000;
  const x3 = wR + th;
  const dx = (Math.sqrt(Math.max(h * h - ah * ah, 0)) * wR) / Math.max(h, 1);
  const x5 = wR + dx;
  const x7 = x3 + dx;
  const dh = (aw - th) / 2;
  const x4 = x5 - dh;
  const x8 = x7 + dh;
  const x6 = w - aw / 2;
  const y1 = h - ah;

  const swAng = Math.atan2(dx, ah);
  const swAngDeg = (swAng * 180) / Math.PI;
  const dang2 = Math.atan2(th / 2, idy);
  const dang2Deg = (dang2 * 180) / Math.PI;
  const stAng = 270 + swAngDeg;
  const stAng2 = 270 - dang2Deg;
  const swAng2 = dang2Deg - 90;
  const swAng3 = 90 + dang2Deg;

  return [
    `M${x6},${h}`,
    `L${x4},${y1}`,
    `L${x5},${y1}`,
    arc(wR, h, wR, h, stAng, stAng - swAngDeg).replace('M', 'L'),
    `L${x3},0`,
    arc(x3, h, wR, h, 270, 270 + swAngDeg).replace('M', 'L'),
    `L${x5 + th},${y1}`,
    `L${x8},${y1}`,
    'Z',
    `M${x3},0`,
    arc(x3, h, wR, h, stAng2, stAng2 + swAng2).replace('M', 'L'),
    arc(wR, h, wR, h, 180, 180 + swAng3).replace('M', 'L'),
    'Z',
  ].join(' ');
});

function buildCircularArrowPath(
  w: number,
  h: number,
  adjustments?: Map<string, number>,
  _mirrorX: boolean = false,
  variant: 'circularArrow' | 'leftCircularArrow' = 'circularArrow',
): string {
  // OOXML circularArrow / leftCircularArrow: same guide formulas, different default adjustments.
  const hc = w / 2;
  const vc = h / 2;
  const wd2 = w / 2;
  const hd2 = h / 2;
  const ss = Math.min(w, h);
  const cd2 = 10800000; // 180° in 60000ths

  const toRad60k = (a: number) => ((a / 60000) * Math.PI) / 180;

  // OOXML formula helpers
  const ooxSin = (val: number, ang: number) => val * Math.sin(toRad60k(ang));
  const ooxCos = (val: number, ang: number) => val * Math.cos(toRad60k(ang));
  const cat2 = (r: number, ht: number, wt: number) => r * Math.cos(Math.atan2(wt, ht));
  const sat2 = (r: number, ht: number, wt: number) => r * Math.sin(Math.atan2(wt, ht));
  // OOXML: at2(x, y) = atan2(y, x) — first arg is x, second is y
  const at2 = (x: number, y: number) => ((Math.atan2(y, x) * 180) / Math.PI) * 60000;
  const modF = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

  // Adjustments — leftCircularArrow has different OOXML defaults
  const isLeft = variant === 'leftCircularArrow';
  const adj1 = adjustments?.get('adj1') ?? 12500;
  const adj2 = adjustments?.get('adj2') ?? (isLeft ? -1142319 : 1142319);
  const adj3 = adjustments?.get('adj3') ?? (isLeft ? 1142319 : 20457681);
  const adj4 = adjustments?.get('adj4') ?? 10800000;
  const adj5v = adjustments?.get('adj5') ?? 12500;

  const a5 = Math.max(0, Math.min(adj5v, 25000));
  const maxAdj1 = a5 * 2;
  const a1 = Math.max(0, Math.min(adj1, maxAdj1));
  const enAng = Math.max(1, Math.min(adj3, 21599999));
  const stAng = Math.max(0, Math.min(adj4, 21599999));

  const th = (ss * a1) / 100000;
  const thh = (ss * a5) / 100000;
  const th2 = th / 2;

  const rw1 = wd2 + th2 - thh;
  const rh1 = hd2 + th2 - thh;
  const rw2 = rw1 - th;
  const rh2 = rh1 - th;
  const rw3 = rw2 + th2;
  const rh3 = rh2 + th2;

  // Point H (mid-radius at end angle)
  const wtH = ooxSin(rw3, enAng);
  const htH = ooxCos(rh3, enAng);
  const dxH = cat2(rw3, htH, wtH);
  const dyH = sat2(rh3, htH, wtH);
  const xH = hc + dxH;
  const yH = vc + dyH;

  // Compute max arrowhead angle
  const rI = Math.min(rw2, rh2);
  const u1 = dxH * dxH;
  const u2 = dyH * dyH;
  const u3 = rI * rI;
  const u4 = u1 - u3;
  const u5 = u2 - u3;
  const u6 = u2 !== 0 ? (u4 * u5) / u1 : 0;
  const u7 = u2 !== 0 ? u6 / u2 : 0;
  const u8 = 1 - u7;
  const u9 = Math.sqrt(Math.max(0, u8));
  const u10 = dxH !== 0 ? u4 / dxH : 0;
  const u11 = dyH !== 0 ? u10 / dyH : 0;
  const u12 = u11 !== 0 ? (1 + u9) / u11 : 0;
  const u13 = at2(1, u12);
  const u14 = u13 + 21600000;
  const u15 = u13 >= 0 ? u13 : u14;
  const u16 = u15 - enAng;
  const u17 = u16 + 21600000;
  const u18 = u16 >= 0 ? u16 : u17;
  const u19 = u18 - cd2;
  const u20 = u18 - 21600000;
  const u21 = u19 >= 0 ? u20 : u18;
  const maxAng = Math.abs(u21);
  let aAng: number;
  if (isLeft) {
    // leftCircularArrow: minAng = -abs(u21), a2 = -abs(adj2), aAng = pin(minAng, a2, 0)
    const minAng = -maxAng;
    const a2 = -Math.abs(adj2);
    aAng = Math.max(minAng, Math.min(a2, 0));
  } else {
    aAng = Math.max(0, Math.min(adj2, maxAng));
  }
  const ptAng = enAng + aAng;

  // Point A (arrowhead tip)
  const wtA = ooxSin(rw3, ptAng);
  const htA = ooxCos(rh3, ptAng);
  const dxA = cat2(rw3, htA, wtA);
  const dyA = sat2(rh3, htA, wtA);
  const xA = hc + dxA;
  const yA = vc + dyA;

  // Point E (outer arc start)
  const wtE = ooxSin(rw1, stAng);
  const htE = ooxCos(rh1, stAng);
  const dxE = cat2(rw1, htE, wtE);
  const dyE = sat2(rh1, htE, wtE);
  const xE = hc + dxE;
  const yE = vc + dyE;

  // Points G and B (arrowhead base, offset from H by thh at angle ptAng)
  const dxG = ooxCos(thh, ptAng);
  const dyG = ooxSin(thh, ptAng);
  const xG = xH + dxG;
  const yG = yH + dyG;
  const xB = xH - dxG;
  const yB = yH - dyG;

  // Scale to normalized circle for line-circle intersection
  const sx1 = xB - hc;
  const sy1 = yB - vc;
  const sx2 = xG - hc;
  const sy2 = yG - vc;

  // Outer circle intersection
  const rO = Math.min(rw1, rh1);
  const x1O = rw1 !== 0 ? (sx1 * rO) / rw1 : 0;
  const y1O = rh1 !== 0 ? (sy1 * rO) / rh1 : 0;
  const x2O = rw1 !== 0 ? (sx2 * rO) / rw1 : 0;
  const y2O = rh1 !== 0 ? (sy2 * rO) / rh1 : 0;

  const dxO = x2O - x1O;
  const dyO = y2O - y1O;
  const dOval = modF(dxO, dyO, 0);

  const q1 = x1O * y2O;
  const q2 = x2O * y1O;
  const DO = q1 - q2;

  const q3 = rO * rO;
  const q4 = dOval * dOval;
  const q5 = q3 * q4;
  const q6 = DO * DO;
  const q7 = q5 - q6;
  const q8 = Math.max(q7, 0);
  const sdelO = Math.sqrt(q8);

  const ndyO = dyO * -1;
  const sdyO = ndyO >= 0 ? -1 : 1;
  const q9 = sdyO * dxO;
  const q10 = q9 * sdelO;
  const q11 = DO * dyO;
  const dxF1 = q4 !== 0 ? (q11 + q10) / q4 : 0;
  const q12 = q11 - q10;
  const dxF2 = q4 !== 0 ? q12 / q4 : 0;

  const adyO = Math.abs(dyO);
  const q13 = adyO * sdelO;
  const q14 = DO * dxO * -1;
  const dyF1 = q4 !== 0 ? (q14 + q13) / q4 : 0;
  const q15 = q14 - q13;
  const dyF2 = q4 !== 0 ? q15 / q4 : 0;

  // Pick intersection closest to G side
  const q16 = x2O - dxF1;
  const q17 = x2O - dxF2;
  const q18 = y2O - dyF1;
  const q19 = y2O - dyF2;
  const q20 = modF(q16, q18, 0);
  const q21 = modF(q17, q19, 0);
  const q22 = q21 - q20;
  const dxF = q22 >= 0 ? dxF1 : dxF2;
  const dyF = q22 >= 0 ? dyF1 : dyF2;

  const sdxF = rO !== 0 ? (dxF * rw1) / rO : 0;
  const sdyF = rO !== 0 ? (dyF * rh1) / rO : 0;
  const xF = hc + sdxF;
  const yF = vc + sdyF;

  // Inner circle intersection
  const x1I = rw2 !== 0 ? (sx1 * rI) / rw2 : 0;
  const y1I = rh2 !== 0 ? (sy1 * rI) / rh2 : 0;
  const x2I = rw2 !== 0 ? (sx2 * rI) / rw2 : 0;
  const y2I = rh2 !== 0 ? (sy2 * rI) / rh2 : 0;

  const dxI = x2I - x1I;
  const dyI = y2I - y1I;
  const dI = modF(dxI, dyI, 0);
  const v1 = x1I * y2I;
  const v2 = x2I * y1I;
  const DI = v1 - v2;

  const v3 = rI * rI;
  const v4 = dI * dI;
  const v5 = v3 * v4;
  const v6 = DI * DI;
  const v7 = v5 - v6;
  const v8 = Math.max(v7, 0);
  const sdelI = Math.sqrt(v8);
  const v9 = sdyO * dxI;
  const v10 = v9 * sdelI;
  const v11 = DI * dyI;
  const dxC1 = v4 !== 0 ? (v11 + v10) / v4 : 0;
  const v12 = v11 - v10;
  const dxC2 = v4 !== 0 ? v12 / v4 : 0;

  const adyI = Math.abs(dyI);
  const v13 = adyI * sdelI;
  const v14 = DI * dxI * -1;
  const dyC1 = v4 !== 0 ? (v14 + v13) / v4 : 0;
  const v15 = v14 - v13;
  const dyC2 = v4 !== 0 ? v15 / v4 : 0;

  // Pick intersection closest to B side (x1I)
  const v16 = x1I - dxC1;
  const v17 = x1I - dxC2;
  const v18 = y1I - dyC1;
  const v19 = y1I - dyC2;
  const v20 = modF(v16, v18, 0);
  const v21 = modF(v17, v19, 0);
  const v22 = v21 - v20;
  const dxC = v22 >= 0 ? dxC1 : dxC2;
  const dyC = v22 >= 0 ? dyC1 : dyC2;

  const sdxC = rI !== 0 ? (dxC * rw2) / rI : 0;
  const sdyC = rI !== 0 ? (dyC * rh2) / rI : 0;
  const xC = hc + sdxC;
  const yC = vc + sdyC;

  // Inner arc angles — leftCircularArrow uses intermediate istAng0/iswAng0
  const ist0 = at2(sdxC, sdyC);
  const ist1 = ist0 + 21600000;
  const istAng0 = ist0 >= 0 ? ist0 : ist1;
  const isw1 = stAng - istAng0;

  let istAng: number;
  let iswAng: number;
  if (isLeft) {
    // leftCircularArrow: iswAng0 always ≥ 0, then istAng shifted, iswAng negated
    const iswAng0 = isw1 >= 0 ? isw1 : isw1 + 21600000;
    istAng = istAng0 + iswAng0;
    iswAng = -iswAng0;
  } else {
    // circularArrow: iswAng always ≤ 0 (clockwise inner arc)
    istAng = istAng0;
    iswAng = isw1 >= 0 ? isw1 - 21600000 : isw1;
  }

  // Adjusted arrowhead points (clamp when too close)
  const p1 = xF - xC;
  const p2 = yF - yC;
  const p3 = modF(p1, p2, 0);
  const p4 = p3 / 2;
  const p5 = p4 - thh;
  const xGp = p5 >= 0 ? xF : xG;
  const yGp = p5 >= 0 ? yF : yG;
  const xBp = p5 >= 0 ? xC : xB;
  const yBp = p5 >= 0 ? yC : yB;

  // Outer arc sweep angle
  const en0 = at2(sdxF, sdyF);
  const en1 = en0 + 21600000;
  const en2 = en0 >= 0 ? en0 : en1;
  const sw0 = en2 - stAng;

  let outerArcStAng: number;
  let outerArcSwAng: number;
  if (isLeft) {
    // leftCircularArrow: swAng ≤ 0, then stAng0 = stAng + swAng, swAng0 = -swAng
    const swAngRaw = sw0 >= 0 ? sw0 - 21600000 : sw0;
    outerArcStAng = stAng + swAngRaw; // stAng0
    outerArcSwAng = -swAngRaw; // swAng0 (positive)
  } else {
    const swAng = sw0 >= 0 ? sw0 : sw0 + 21600000;
    outerArcStAng = stAng;
    outerArcSwAng = swAng;
  }

  // Compute end points for SVG arcs using OOXML arcTo semantics
  // Outer arc: from outerArcStAng sweeping outerArcSwAng
  const outerEndAng = outerArcStAng + outerArcSwAng;
  const wtOE = ooxSin(rw1, outerEndAng);
  const htOE = ooxCos(rh1, outerEndAng);
  const xOE = hc + cat2(rw1, htOE, wtOE);
  const yOE = vc + sat2(rh1, htOE, wtOE);

  // Inner arc: from istAng sweeping iswAng
  const innerEndAng = istAng + iswAng;
  const wtIE = ooxSin(rw2, innerEndAng);
  const htIE = ooxCos(rh2, innerEndAng);
  const xIE = hc + cat2(rw2, htIE, wtIE);
  const yIE = vc + sat2(rh2, htIE, wtIE);

  // SVG arc flags
  const outerSweepDeg = Math.abs(outerArcSwAng / 60000);
  const outerLargeArc = outerSweepDeg > 180 ? 1 : 0;
  const outerSweepFlag = outerArcSwAng > 0 ? 1 : 0;

  const innerSweepDeg = Math.abs(iswAng / 60000);
  const innerLargeArc = innerSweepDeg > 180 ? 1 : 0;
  const innerSweepFlag = iswAng > 0 ? 1 : 0;

  if (isLeft) {
    // leftCircularArrow path: M(xE) → L(xD) → inner arc → arrowhead → L(xF) → outer arc → Z
    // Point D: inner arc start at stAng on rw2/rh2
    const wtD = ooxSin(rw2, stAng);
    const htD = ooxCos(rh2, stAng);
    const xD = hc + cat2(rw2, htD, wtD);
    const yD = vc + sat2(rh2, htD, wtD);
    return [
      `M${xE},${yE}`,
      `L${xD},${yD}`,
      `A${rw2},${rh2} 0 ${innerLargeArc},${innerSweepFlag} ${xIE},${yIE}`,
      `L${xBp},${yBp}`,
      `L${xA},${yA}`,
      `L${xGp},${yGp}`,
      `L${xF},${yF}`,
      `A${rw1},${rh1} 0 ${outerLargeArc},${outerSweepFlag} ${xOE},${yOE}`,
      'Z',
    ].join(' ');
  }

  return [
    `M${xE},${yE}`,
    `A${rw1},${rh1} 0 ${outerLargeArc},${outerSweepFlag} ${xOE},${yOE}`,
    `L${xGp},${yGp}`,
    `L${xA},${yA}`,
    `L${xBp},${yBp}`,
    `L${xC},${yC}`,
    `A${rw2},${rh2} 0 ${innerLargeArc},${innerSweepFlag} ${xIE},${yIE}`,
    'Z',
  ].join(' ');
}

presetShapes.set('circularArrow', (w, h, adjustments) => {
  return buildCircularArrowPath(w, h, adjustments, false, 'circularArrow');
});

// leftCircularArrow uses same OOXML guide formulas as circularArrow but different default adjustments.
presetShapes.set('leftCircularArrow', (w, h, adjustments) => {
  return buildCircularArrowPath(w, h, adjustments, false, 'leftCircularArrow');
});

presetShapes.set('leftRightCircularArrow', (w, h, _adjustments) => {
  // Build from the actual oracle PDF vector path (shape id 0177),
  // normalized to a 400x280 reference box.
  const sx = w / 400;
  const sy = h / 280;
  const p = (x: number, y: number) => ({ x: x * sx, y: y * sy });

  const p1 = p(35.0, 140.0);
  const p2 = p(19.9536, 89.9471);
  const p3 = p(33.4296, 89.9471);
  const c1 = p(74.6127, 28.1974);
  const c2 = p(182.5744, 0.5489);
  const p4 = p(274.5688, 28.1924);
  const c3 = p(315.4978, 40.4912);
  const c4 = p(348.2481, 62.4743);
  const p5 = p(366.5707, 89.9471);
  const p6 = p(380.0463, 89.9471);
  const p7 = p(365.0, 140.0);
  const p8 = p(310.0463, 89.9471);
  const p9 = p(320.9838, 89.9471);
  const c5 = p(274.3848, 50.3095);
  const c6 = p(182.4425, 40.5864);
  const p10 = p(115.6249, 68.2298);
  const c7 = p(101.3589, 74.1319);
  const c8 = p(88.9651, 81.4842);
  const p11 = p(79.0159, 89.947);
  const p12 = p(89.9536, 89.9471);

  return [
    `M${p1.x},${p1.y}`,
    `L${p2.x},${p2.y}`,
    `L${p3.x},${p3.y}`,
    `C${c1.x},${c1.y} ${c2.x},${c2.y} ${p4.x},${p4.y}`,
    `C${c3.x},${c3.y} ${c4.x},${c4.y} ${p5.x},${p5.y}`,
    `L${p6.x},${p6.y}`,
    `L${p7.x},${p7.y}`,
    `L${p8.x},${p8.y}`,
    `L${p9.x},${p9.y}`,
    `C${c5.x},${c5.y} ${c6.x},${c6.y} ${p10.x},${p10.y}`,
    `C${c7.x},${c7.y} ${c8.x},${c8.y} ${p11.x},${p11.y}`,
    `L${p12.x},${p12.y}`,
    'Z',
  ].join(' ');
});

presetShapes.set('quadArrow', (w, h, adjustments) => {
  const adj1Raw = adjustments?.get('adj1') ?? 22500;
  const adj2Raw = adjustments?.get('adj2') ?? 22500;
  const adj3Raw = adjustments?.get('adj3') ?? 22500;
  const vc = h / 2;
  const hc = w / 2;
  const minWH = Math.min(w, h);
  const a2 = Math.max(0, Math.min(adj2Raw, 50000));
  const a1 = Math.max(0, Math.min(adj1Raw, 2 * a2));
  const a3 = Math.max(0, Math.min(adj3Raw, (100000 - 2 * a2) / 2));
  const x1 = (minWH * a3) / 100000;
  const dx2 = (minWH * a2) / 100000;
  const x2 = hc - dx2;
  const x5 = hc + dx2;
  const dx3 = (minWH * a1) / 200000;
  const x3 = hc - dx3;
  const x4 = hc + dx3;
  const x6 = w - x1;
  const y2 = vc - dx2;
  const y5 = vc + dx2;
  const y3 = vc - dx3;
  const y4 = vc + dx3;
  const y6 = h - x1;
  return [
    `M0,${vc}`,
    `L${x1},${y2}`,
    `L${x1},${y3}`,
    `L${x3},${y3}`,
    `L${x3},${x1}`,
    `L${x2},${x1}`,
    `L${hc},0`,
    `L${x5},${x1}`,
    `L${x4},${x1}`,
    `L${x4},${y3}`,
    `L${x6},${y3}`,
    `L${x6},${y2}`,
    `L${w},${vc}`,
    `L${x6},${y5}`,
    `L${x6},${y4}`,
    `L${x4},${y4}`,
    `L${x4},${y6}`,
    `L${x5},${y6}`,
    `L${hc},${h}`,
    `L${x2},${y6}`,
    `L${x3},${y6}`,
    `L${x3},${y4}`,
    `L${x1},${y4}`,
    `L${x1},${y5}`,
    'Z',
  ].join(' ');
});

presetShapes.set('quadArrowCallout', (w, h, adjustments) => {
  // OOXML: 28-point polygon with 4 arrowheads (4 adj)
  const ss = Math.min(w, h);
  const hc = w / 2;
  const vc = h / 2;
  const a2 = Math.max(0, Math.min(adjustments?.get('adj2') ?? 18515, 50000));
  const a1 = Math.max(0, Math.min(adjustments?.get('adj1') ?? 18515, a2 * 2));
  const maxAdj3 = 50000 - a2;
  const a3 = Math.max(0, Math.min(adjustments?.get('adj3') ?? 18515, maxAdj3));
  const q2 = a3 * 2;
  const a4 = Math.max(a1, Math.min(adjustments?.get('adj4') ?? 48123, 100000 - q2));
  const dx2 = (ss * a2) / 100000;
  const dx3 = (ss * a1) / 200000;
  const ah = (ss * a3) / 100000;
  const dx1 = (w * a4) / 200000;
  const dy1 = (h * a4) / 200000;
  const x8 = w - ah;
  const x2 = hc - dx1;
  const x7 = hc + dx1;
  const x3 = hc - dx2;
  const x6 = hc + dx2;
  const x4 = hc - dx3;
  const x5 = hc + dx3;
  const y8 = h - ah;
  const y2 = vc - dy1;
  const y7 = vc + dy1;
  const y3 = vc - dx2;
  const y6 = vc + dx2;
  const y4 = vc - dx3;
  const y5 = vc + dx3;
  return [
    `M0,${vc}`,
    `L${ah},${y3}`,
    `L${ah},${y4}`,
    `L${x2},${y4}`,
    `L${x2},${y2}`,
    `L${x4},${y2}`,
    `L${x4},${ah}`,
    `L${x3},${ah}`,
    `L${hc},0`,
    `L${x6},${ah}`,
    `L${x5},${ah}`,
    `L${x5},${y2}`,
    `L${x7},${y2}`,
    `L${x7},${y4}`,
    `L${x8},${y4}`,
    `L${x8},${y3}`,
    `L${w},${vc}`,
    `L${x8},${y6}`,
    `L${x8},${y5}`,
    `L${x7},${y5}`,
    `L${x7},${y7}`,
    `L${x5},${y7}`,
    `L${x5},${y8}`,
    `L${x6},${y8}`,
    `L${hc},${h}`,
    `L${x3},${y8}`,
    `L${x4},${y8}`,
    `L${x4},${y7}`,
    `L${x2},${y7}`,
    `L${x2},${y5}`,
    `L${ah},${y5}`,
    `L${ah},${y6}`,
    'Z',
  ].join(' ');
});

presetShapes.set('leftRightUpArrow', (w, h, adjustments) => {
  // OOXML preset formula (presetShapeDefinitions.xml -> leftRightUpArrow)
  const rawAdj2 = Math.max(0, Math.min(adjustments?.get('adj2') ?? 25000, 50000));
  const maxAdj1 = rawAdj2 * 2;
  const rawAdj1 = Math.max(0, Math.min(adjustments?.get('adj1') ?? 25000, maxAdj1));
  const q1 = 100000 - maxAdj1;
  const maxAdj3 = q1 / 2;
  const rawAdj3 = Math.max(0, Math.min(adjustments?.get('adj3') ?? 25000, maxAdj3));

  const ss = Math.min(w, h);
  const hc = w / 2;

  const x1 = (ss * rawAdj3) / 100000;
  const dx2 = (ss * rawAdj2) / 100000;
  const x2 = hc - dx2;
  const x5 = hc + dx2;
  const dx3 = (ss * rawAdj1) / 200000;
  const x3 = hc - dx3;
  const x4 = hc + dx3;
  const x6 = w - x1;

  const dy2 = (ss * rawAdj2) / 50000;
  const y2 = h - dy2;
  const y4 = h - dx2;
  const y3 = y4 - dx3;
  const y5 = y4 + dx3;

  return [
    `M0,${y4}`,
    `L${x1},${y2}`,
    `L${x1},${y3}`,
    `L${x3},${y3}`,
    `L${x3},${x1}`,
    `L${x2},${x1}`,
    `L${hc},0`,
    `L${x5},${x1}`,
    `L${x4},${x1}`,
    `L${x4},${y3}`,
    `L${x6},${y3}`,
    `L${x6},${y2}`,
    `L${w},${y4}`,
    `L${x6},${h}`,
    `L${x6},${y5}`,
    `L${x1},${y5}`,
    `L${x1},${h}`,
    'Z',
  ].join(' ');
});

presetShapes.set('swooshArrow', (w, h, adjustments) => {
  // OOXML swooshArrow: curved swoosh with arrowhead on the right.
  const ss = Math.min(w, h);
  const raw1 = adjustments?.get('adj1') ?? 25000;
  const raw2 = adjustments?.get('adj2') ?? 16667;
  const a1 = Math.max(1, Math.min(raw1, 75000));
  const maxAdj2 = (70000 * w) / ss;
  const a2 = Math.max(0, Math.min(raw2, maxAdj2));
  const ad1 = (h * a1) / 100000;
  const ad2 = (ss * a2) / 100000;
  const ssd8 = ss / 8;
  const hd6 = h / 6;
  const alfa = Math.PI / 2 / 14; // cd4/14 in radians
  const tanAlfa = Math.tan(alfa);
  const xB = w - ad2;
  const yB = ssd8;
  const dx0 = ssd8 * tanAlfa;
  const xC = xB - dx0;
  const dx1 = ad1 * tanAlfa;
  const yF = yB + ad1;
  const xF = xB + dx1;
  const xE = xF + dx0;
  const yE = yF + ssd8;
  const dy2 = yE;
  const dy22 = dy2 / 2;
  const dy3 = h / 20;
  const yD = dy22 + dy3;
  const xP1 = w / 6;
  const yP1 = hd6 + hd6; // h/3
  const dy5 = hd6 / 2;
  const yP2 = yF + dy5;
  const xP2 = w / 4;
  return [
    `M0,${h}`,
    `Q${xP1},${yP1} ${xB},${yB}`,
    `L${xC},0`,
    `L${w},${yD}`,
    `L${xE},${yE}`,
    `L${xF},${yF}`,
    `Q${xP2},${yP2} 0,${h}`,
    'Z',
  ].join(' ');
});

// ===== Flowchart Shapes =====

presetShapes.set('flowChartProcess', (w, h) => `M0,0 L${w},0 L${w},${h} L0,${h} Z`);

presetShapes.set('flowChartDecision', (w, h) => {
  const cx = w / 2;
  const cy = h / 2;
  return `M${cx},0 L${w},${cy} L${cx},${h} L0,${cy} Z`;
});

presetShapes.set('flowChartTerminator', (w, h) => {
  // OOXML: path w=21600 h=21600, wR=3475, hR=10800 (elliptical caps, not circular)
  const x1 = (w * 3475) / 21600;
  const x2 = (w * 18125) / 21600;
  const wR = x1; // w * 3475/21600
  const hR = h / 2; // h * 10800/21600
  return [
    `M${x1},0`,
    `L${x2},0`,
    `A${wR},${hR} 0 0,1 ${x2},${h}`,
    `L${x1},${h}`,
    `A${wR},${hR} 0 0,1 ${x1},0`,
    'Z',
  ].join(' ');
});

presetShapes.set('flowChartDocument', (w, h) => {
  // OOXML: path w=21600 h=21600, cubic (21600,17322)(10800,17322)(10800,23922)(0,20172)
  const y1 = (h * 17322) / 21600;
  const cy1 = y1; // h * 17322/21600
  const cy2 = (h * 23922) / 21600; // extends below h (overshoot for curve)
  const y2 = (h * 20172) / 21600;
  return [`M0,0`, `L${w},0`, `L${w},${y1}`, `C${w / 2},${cy1} ${w / 2},${cy2} 0,${y2}`, 'Z'].join(
    ' ',
  );
});

presetShapes.set('flowChartInputOutput', (w, h) => {
  // OOXML: path w=5 h=5, points: (0,5)(1,0)(5,0)(4,5) — offset = w/5
  const offset = w / 5;
  return `M${offset},0 L${w},0 L${w - offset},${h} L0,${h} Z`;
});

presetShapes.set('flowChartPredefinedProcess', (w, h) => {
  const inset = w * 0.1;
  return [
    // Outer rectangle
    `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
    // Left inner line
    `M${inset},0 L${inset},${h}`,
    // Right inner line
    `M${w - inset},0 L${w - inset},${h}`,
  ].join(' ');
});

presetShapes.set('flowChartAlternateProcess', (w, h) => {
  // OOXML spec: corner radius = ssd6 = min(w,h)/6
  const r = Math.min(w, h) / 6;
  return [
    `M${r},0`,
    `L${w - r},0`,
    `A${r},${r} 0 0,1 ${w},${r}`,
    `L${w},${h - r}`,
    `A${r},${r} 0 0,1 ${w - r},${h}`,
    `L${r},${h}`,
    `A${r},${r} 0 0,1 0,${h - r}`,
    `L0,${r}`,
    `A${r},${r} 0 0,1 ${r},0`,
    'Z',
  ].join(' ');
});

presetShapes.set('flowChartManualInput', (w, h) => {
  const topOffset = h * 0.2;
  return `M0,${topOffset} L${w},0 L${w},${h} L0,${h} Z`;
});

presetShapes.set('flowChartManualOperation', (w, h) => {
  // OOXML: path w=5 h=5: (0,0)→(5,0)→(4,5)→(1,5)→close → inset = w/5
  return `M0,0 L${w},0 L${(w * 4) / 5},${h} L${w / 5},${h} Z`;
});

presetShapes.set('flowChartPreparation', (w, h) => {
  const inset = w * 0.2;
  const cy = h / 2;
  return `M${inset},0 L${w - inset},0 L${w},${cy} L${w - inset},${h} L${inset},${h} L0,${cy} Z`;
});

presetShapes.set('flowChartData', (w, h) => {
  const offset = w * 0.15;
  return `M${offset},0 L${w},0 L${w - offset},${h} L0,${h} Z`;
});

presetShapes.set('flowChartInternalStorage', (w, h) => {
  const inset = Math.min(w, h) * 0.12;
  return [
    `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
    `M${inset},0 L${inset},${h}`,
    `M0,${inset} L${w},${inset}`,
  ].join(' ');
});

presetShapes.set('flowChartMagneticDisk', (w, h) => {
  // OOXML spec: path w=6 h=6, top at y=1, arc hR=1 → ry = h/6
  const ry = h / 6;
  const bodyTop = ry;
  const bodyBottom = h - ry;
  return [
    // Top ellipse
    `M0,${bodyTop}`,
    `A${w / 2},${ry} 0 1,1 ${w},${bodyTop}`,
    // Right side down
    `L${w},${bodyBottom}`,
    // Bottom ellipse
    `A${w / 2},${ry} 0 1,1 0,${bodyBottom}`,
    // Left side up
    `L0,${bodyTop}`,
    'Z',
    // Top ellipse visible arc (back half)
    `M${w},${bodyTop}`,
    `A${w / 2},${ry} 0 1,1 0,${bodyTop}`,
  ].join(' ');
});

presetShapes.set('flowChartDelay', (w, h) => {
  // OOXML: M(0,0) L(hc,0) arcTo(wd2,hd2, 270°, 180°) L(0,h) Z
  // Arc from (hc,0) with wR=w/2 hR=h/2, stAng=270° swAng=180° → semicircle right side
  const hc = w / 2;
  const a = ooArcTo(hc, 0, hc, h / 2, 270, 180);
  return [`M0,0`, `L${hc},0`, a.svg, `L0,${h}`, 'Z'].join(' ');
});

presetShapes.set('flowChartDisplay', (w, h) => {
  // OOXML: path w=6 h=6, points: (0,3)(1,0)(5,0) arcTo(1,3,270°,180°) (1,6) close
  // Scaled: left point at (0, h/2), top-left at (w/6, 0), arc center at (5w/6, h/2)
  const sx = w / 6;
  const sy = h / 6;
  const arcWR = sx; // wR = 1 * (w/6)
  const arcHR = sy * 3; // hR = 3 * (h/6) = h/2
  const a = ooArcTo(5 * sx, 0, arcWR, arcHR, 270, 180);
  return [`M0,${3 * sy}`, `L${sx},0`, `L${5 * sx},0`, a.svg, `L${sx},${h}`, 'Z'].join(' ');
});

presetShapes.set('flowChartExtract', (w, h) => `M${w / 2},0 L${w},${h} L0,${h} Z`);

presetShapes.set('flowChartMerge', (w, h) => `M0,0 L${w},0 L${w / 2},${h} Z`);

presetShapes.set('flowChartOffpageConnector', (w, h) => {
  const arrowH = h * 0.2;
  return [`M0,0`, `L${w},0`, `L${w},${h - arrowH}`, `L${w / 2},${h}`, `L0,${h - arrowH}`, 'Z'].join(
    ' ',
  );
});

presetShapes.set('flowChartConnector', (w, h) => {
  const rx = w / 2;
  const ry = h / 2;
  return [`M${w},${ry}`, `A${rx},${ry} 0 1,1 0,${ry}`, `A${rx},${ry} 0 1,1 ${w},${ry}`, 'Z'].join(
    ' ',
  );
});

presetShapes.set('flowChartSort', (w, h) => {
  const cx = w / 2;
  const cy = h / 2;
  return [`M${cx},0 L${w},${cy} L${cx},${h} L0,${cy} Z`, `M0,${cy} L${w},${cy}`].join(' ');
});

presetShapes.set('flowChartCollate', (w, h) => {
  const cx = w / 2;
  const cy = h / 2;
  return [
    // top inverted triangle
    `M0,0 L${w},0 L${cx},${cy} Z`,
    // bottom upright triangle
    `M0,${h} L${w},${h} L${cx},${cy} Z`,
  ].join(' ');
});

presetShapes.set('flowChartPunchedTape', (w, h) => {
  // OOXML: path w="20" h="20" with arcTo operations.
  // Start at (0, 2), four arcs for wavy top/bottom.
  const sx = w / 20;
  const sy = h / 20;
  const arcTo = (
    curX: number,
    curY: number,
    wR: number,
    hR: number,
    stAng60k: number,
    swAng60k: number,
  ) => {
    const stDeg = stAng60k / 60000;
    const swDeg = swAng60k / 60000;
    const stRad = (stDeg * Math.PI) / 180;
    const endRad = ((stDeg + swDeg) * Math.PI) / 180;
    const cx = curX - wR * Math.cos(stRad);
    const cy = curY - hR * Math.sin(stRad);
    const endX = cx + wR * Math.cos(endRad);
    const endY = cy + hR * Math.sin(endRad);
    const largeArc = Math.abs(swDeg) > 180 ? 1 : 0;
    const sweep = swDeg > 0 ? 1 : 0;
    return { endX, endY, svg: `A${wR},${hR} 0 ${largeArc},${sweep} ${endX},${endY}` };
  };
  // cd2 = 10800000 (180°)
  const wR = 5 * sx;
  const hR = 2 * sy;
  let x = 0,
    y = 2 * sy;
  const parts = [`M${x},${y}`];
  // Top-left: stAng=cd2(180°), swAng=-cd2(-180°) → dips down
  let a = arcTo(x, y, wR, hR, 10800000, -10800000);
  parts.push(a.svg);
  x = a.endX;
  y = a.endY;
  // Top-right: stAng=cd2(180°), swAng=+cd2(+180°) → bumps up
  a = arcTo(x, y, wR, hR, 10800000, 10800000);
  parts.push(a.svg);
  x = a.endX;
  y = a.endY;
  // Line to bottom-right
  const bx = 20 * sx,
    by = 18 * sy;
  parts.push(`L${bx},${by}`);
  x = bx;
  y = by;
  // Bottom-right: stAng=0, swAng=-cd2(-180°) → bumps up
  a = arcTo(x, y, wR, hR, 0, -10800000);
  parts.push(a.svg);
  x = a.endX;
  y = a.endY;
  // Bottom-left: stAng=0, swAng=+cd2(+180°) → dips down
  a = arcTo(x, y, wR, hR, 0, 10800000);
  parts.push(a.svg);
  parts.push('Z');
  return parts.join(' ');
});

presetShapes.set('flowChartPunchedCard', (w, h) => {
  // OOXML spec: path w=5, h=5. Points: (0,1)(1,0)(5,0)(5,5)(0,5)
  const sx = w / 5;
  const sy = h / 5;
  return `M0,${sy} L${sx},0 L${w},0 L${w},${h} L0,${h} Z`;
});

presetShapes.set('flowChartSummingJunction', (w, h) => {
  // OOXML: Circle with X cross. Returns single path with circle + X lines.
  const wd2 = w / 2;
  const hd2 = h / 2;
  const idx = wd2 * Math.cos(Math.PI / 4); // cos(45°)
  const idy = hd2 * Math.sin(Math.PI / 4);
  const il = wd2 - idx;
  const ir = wd2 + idx;
  const it = hd2 - idy;
  const ib = hd2 + idy;
  return [
    // Circle
    `M0,${hd2}`,
    `A${wd2},${hd2} 0 1,1 ${w},${hd2}`,
    `A${wd2},${hd2} 0 1,1 0,${hd2}`,
    'Z',
    // X cross
    `M${il},${it} L${ir},${ib}`,
    `M${ir},${it} L${il},${ib}`,
  ].join(' ');
});

presetShapes.set('flowChartOr', (w, h) => {
  // OOXML: Circle with + cross.
  const wd2 = w / 2;
  const hd2 = h / 2;
  return [
    // Circle
    `M0,${hd2}`,
    `A${wd2},${hd2} 0 1,1 ${w},${hd2}`,
    `A${wd2},${hd2} 0 1,1 0,${hd2}`,
    'Z',
    // + cross
    `M${wd2},0 L${wd2},${h}`,
    `M0,${hd2} L${w},${hd2}`,
  ].join(' ');
});

presetShapes.set('flowChartOnlineStorage', (w, h) => {
  // OOXML: Rounded left side rectangle with concave right cap.
  // Normalized: left arc (convex) at x=w/6, right arc (concave) at x=w
  const x1 = w / 6;
  return [
    `M${x1},0`,
    `L${w},0`,
    `A${x1},${h / 2} 0 0,0 ${w},${h}`,
    `L${x1},${h}`,
    `A${x1},${h / 2} 0 0,1 ${x1},0`,
    'Z',
  ].join(' ');
});

presetShapes.set('flowChartMagneticDrum', (w, h) => {
  // OOXML: Horizontal cylinder (magnetic drum). Right ellipse cap visible.
  const x1 = w / 6;
  const x2 = (w * 5) / 6;
  const ry = h / 2;
  return [
    // Body
    `M${x1},0`,
    `L${x2},0`,
    `A${x1},${ry} 0 0,1 ${x2},${h}`,
    `L${x1},${h}`,
    `A${x1},${ry} 0 0,1 ${x1},0`,
    'Z',
    // Right ellipse back-face (visible part)
    `M${x2},${h}`,
    `A${x1},${ry} 0 0,1 ${x2},0`,
  ].join(' ');
});

presetShapes.set('flowChartMagneticTape', (w, h) => {
  // OOXML: Nearly full ellipse (circle) with a tape tail to the bottom-right.
  // 3 quarter-arcs (270°) + partial arc of ang1 = at2(w,h) = atan2(h,w),
  // then line to (r, ib) → (r, b) → close.
  const wd2 = w / 2;
  const hd2 = h / 2;
  const hc = wd2;
  const vc = hd2;
  const ang1 = Math.atan2(h, w); // OOXML at2 w h = atan2(h, w)
  const ib = vc + hd2 * Math.sin(Math.PI / 4); // sin(45°) * hd2
  // arcTo helper: compute SVG arc from OOXML arcTo parameters
  const arcTo = (
    curX: number,
    curY: number,
    wR: number,
    hR: number,
    stDeg: number,
    swDeg: number,
  ) => {
    const stRad = (stDeg * Math.PI) / 180;
    const endRad = ((stDeg + swDeg) * Math.PI) / 180;
    const cx = curX - wR * Math.cos(stRad);
    const cy = curY - hR * Math.sin(stRad);
    const endX = cx + wR * Math.cos(endRad);
    const endY = cy + hR * Math.sin(endRad);
    const largeArc = Math.abs(swDeg) > 180 ? 1 : 0;
    const sweep = swDeg > 0 ? 1 : 0;
    return { endX, endY, svg: `A${wR},${hR} 0 ${largeArc},${sweep} ${endX},${endY}` };
  };
  // Start at bottom center: M(hc, b)
  let curX = hc;
  let curY = h;
  const a1 = arcTo(curX, curY, wd2, hd2, 90, 90); // cd4, cd4 → 90° to 180°
  curX = a1.endX;
  curY = a1.endY;
  const a2 = arcTo(curX, curY, wd2, hd2, 180, 90); // cd2, cd4 → 180° to 270°
  curX = a2.endX;
  curY = a2.endY;
  const a3 = arcTo(curX, curY, wd2, hd2, 270, 90); // 3cd4, cd4 → 270° to 360°
  curX = a3.endX;
  curY = a3.endY;
  const ang1Deg = (ang1 * 180) / Math.PI;
  const a4 = arcTo(curX, curY, wd2, hd2, 0, ang1Deg); // 0, ang1
  return [`M${hc},${h}`, a1.svg, a2.svg, a3.svg, a4.svg, `L${w},${ib}`, `L${w},${h}`, 'Z'].join(
    ' ',
  );
});

presetShapes.set('flowChartMultidocument', (w, h) => {
  // OOXML: 21600-unit coordinates. Three stacked documents with cubic bezier waves.
  const s = (x: number) => (w * x) / 21600;
  const t = (y: number) => (h * y) / 21600;
  return [
    // Front doc (bottom layer, with wave)
    `M0,${t(20782)}`,
    `C${s(9298)},${t(23542)} ${s(9298)},${t(18022)} ${s(18595)},${t(18022)}`,
    `L${s(18595)},${t(3675)} L0,${t(3675)} Z`,
    // Middle doc
    `M${s(1532)},${t(3675)} L${s(1532)},${t(1815)} L${s(20000)},${t(1815)}`,
    `L${s(20000)},${t(16252)}`,
    `C${s(19298)},${t(16252)} ${s(18595)},${t(16352)} ${s(18595)},${t(16352)}`,
    `L${s(18595)},${t(3675)} Z`,
    // Back doc (top layer)
    `M${s(2972)},${t(1815)} L${s(2972)},0 L${w},0`,
    `L${w},${t(14392)}`,
    `C${s(20800)},${t(14392)} ${s(20000)},${t(14467)} ${s(20000)},${t(14467)}`,
    `L${s(20000)},${t(1815)} Z`,
  ].join(' ');
});

// ===== Callout Shapes =====

presetShapes.set('wedgeRectCallout', (w, h, adjustments) => {
  // OOXML spec: adaptive callout pointer on the edge closest to the tip
  const hc = w / 2;
  const vc = h / 2;
  const dxPos = (w * (adjustments?.get('adj1') ?? -20833)) / 100000;
  const dyPos = (h * (adjustments?.get('adj2') ?? 62500)) / 100000;
  const xPos = hc + dxPos;
  const yPos = vc + dyPos;
  const dq = (dxPos * h) / w;
  const ady = Math.abs(dyPos);
  const adq = Math.abs(dq);
  const dz = ady - adq;
  // Notch bracket positions (7/12 or 2/12 depending on tip direction)
  const x1 = (w * (dxPos >= 0 ? 7 : 2)) / 12;
  const x2 = (w * (dxPos >= 0 ? 10 : 5)) / 12;
  const y1 = (h * (dyPos >= 0 ? 7 : 2)) / 12;
  const y2 = (h * (dyPos >= 0 ? 10 : 5)) / 12;
  // Conditional notch points per edge (collapse to edge if not the active edge)
  const xl = dz > 0 ? 0 : dxPos >= 0 ? 0 : xPos;
  const xt = dz > 0 ? (dyPos >= 0 ? x1 : xPos) : x1;
  const xr = dz > 0 ? w : dxPos >= 0 ? xPos : w;
  const xb = dz > 0 ? (dyPos >= 0 ? xPos : x1) : x1;
  const yl = dz > 0 ? y1 : dxPos >= 0 ? y1 : yPos;
  const yt = dz > 0 ? (dyPos >= 0 ? 0 : yPos) : 0;
  const yr = dz > 0 ? y1 : dxPos >= 0 ? yPos : y1;
  const yb = dz > 0 ? (dyPos >= 0 ? yPos : h) : h;
  return [
    `M0,0`,
    `L${x1},0`,
    `L${xt},${yt}`,
    `L${x2},0`,
    `L${w},0`,
    `L${w},${y1}`,
    `L${xr},${yr}`,
    `L${w},${y2}`,
    `L${w},${h}`,
    `L${x2},${h}`,
    `L${xb},${yb}`,
    `L${x1},${h}`,
    `L0,${h}`,
    `L0,${y2}`,
    `L${xl},${yl}`,
    `L0,${y1}`,
    'Z',
  ].join(' ');
});

presetShapes.set('wedgeRoundRectCallout', (w, h, adjustments) => {
  // OOXML spec: rounded rect with adaptive callout pointer
  const hc = w / 2;
  const vc = h / 2;
  const ss = Math.min(w, h);
  const dxPos = (w * (adjustments?.get('adj1') ?? -20833)) / 100000;
  const dyPos = (h * (adjustments?.get('adj2') ?? 62500)) / 100000;
  const u1 = (ss * (adjustments?.get('adj3') ?? 16667)) / 100000;
  const xPos = hc + dxPos;
  const yPos = vc + dyPos;
  const dq = (dxPos * h) / w;
  const ady = Math.abs(dyPos);
  const adq = Math.abs(dq);
  const dz = ady - adq;
  const u2 = w - u1;
  const v2 = h - u1;
  const x1 = (w * (dxPos >= 0 ? 7 : 2)) / 12;
  const x2 = (w * (dxPos >= 0 ? 10 : 5)) / 12;
  const y1 = (h * (dyPos >= 0 ? 7 : 2)) / 12;
  const y2 = (h * (dyPos >= 0 ? 10 : 5)) / 12;
  const xl = dz > 0 ? 0 : dxPos >= 0 ? 0 : xPos;
  const xt = dz > 0 ? (dyPos >= 0 ? x1 : xPos) : x1;
  const xr = dz > 0 ? w : dxPos >= 0 ? xPos : w;
  const xb = dz > 0 ? (dyPos >= 0 ? xPos : x1) : x1;
  const yl = dz > 0 ? y1 : dxPos >= 0 ? y1 : yPos;
  const yt = dz > 0 ? (dyPos >= 0 ? 0 : yPos) : 0;
  const yr = dz > 0 ? y1 : dxPos >= 0 ? yPos : y1;
  const yb = dz > 0 ? (dyPos >= 0 ? yPos : h) : h;
  return [
    `M0,${u1}`,
    `A${u1},${u1} 0 0,1 ${u1},0`,
    `L${x1},0`,
    `L${xt},${yt}`,
    `L${x2},0`,
    `L${u2},0`,
    `A${u1},${u1} 0 0,1 ${w},${u1}`,
    `L${w},${y1}`,
    `L${xr},${yr}`,
    `L${w},${y2}`,
    `L${w},${v2}`,
    `A${u1},${u1} 0 0,1 ${u2},${h}`,
    `L${x2},${h}`,
    `L${xb},${yb}`,
    `L${x1},${h}`,
    `L${u1},${h}`,
    `A${u1},${u1} 0 0,1 0,${v2}`,
    `L0,${y2}`,
    `L${xl},${yl}`,
    `L0,${y1}`,
    'Z',
  ].join(' ');
});

presetShapes.set('wedgeEllipseCallout', (w, h, adjustments) => {
  // OOXML preset definition (ECMA-376):
  //   dxPos = w * adj1 / 100000;  dyPos = h * adj2 / 100000
  //   xPos  = w/2 + dxPos;        yPos  = h/2 + dyPos
  //   pang  = atan2(dyPos*w, dxPos*h)   ← ellipse-aspect-corrected angle
  //   gap   = ±11° around pang on the ellipse perimeter
  const ax = adj(adjustments, 'adj1', -20833);
  const ay = adj(adjustments, 'adj2', 62500);
  const rx = w / 2;
  const ry = h / 2;
  const dxPos = w * ax;
  const dyPos = h * ay;
  const xPos = rx + dxPos;
  const yPos = ry + dyPos;
  // Use ellipse-aspect-corrected angle so the gap sits on the perimeter
  // pointing toward the tip — without this, on wide/short ellipses the gap
  // ends up offset to the side instead of opposite the tip.
  const pang = Math.atan2(dyPos * w, dxPos * h);
  const halfGap = (11 * Math.PI) / 180;
  const stAng = pang + halfGap;
  const enAng = pang - halfGap;
  const x1 = rx + rx * Math.cos(stAng);
  const y1 = ry + ry * Math.sin(stAng);
  const x2 = rx + rx * Math.cos(enAng);
  const y2 = ry + ry * Math.sin(enAng);
  // Path: start at one side of the gap → line to tip → line to other side
  // → arc the long way around back to start.
  // Arc the long way around from (x2,y2) back to (x1,y1) along the rest of
  // the ellipse perimeter (the side opposite the tail). Use SVG arc directly
  // with large-arc=1 and sweep=0 (CCW) so the gap stays at the tip side.
  return [
    `M${x1},${y1}`,
    `L${xPos},${yPos}`,
    `L${x2},${y2}`,
    `A${rx},${ry} 0 1,0 ${x1},${y1}`,
    'Z',
  ].join(' ');
});

presetShapes.set('cloudCallout', (w, h, adjustments) => {
  const ax = adj(adjustments, 'adj1', -20833);
  const ay = adj(adjustments, 'adj2', 62500);
  const tipX = w / 2 + w * ax;
  const tipY = h / 2 + h * ay;
  // Simplified cloud with callout circles
  const cloud = presetShapes.get('cloud')!(w, h);
  // Small circles leading to tip
  const cx = w / 2;
  const cy = h / 2;
  const dx = tipX - cx;
  const dy = tipY - cy;
  const r1 = Math.min(w, h) * 0.04;
  const r2 = Math.min(w, h) * 0.025;
  const c1x = cx + dx * 0.5;
  const c1y = cy + dy * 0.5;
  const c2x = cx + dx * 0.75;
  const c2y = cy + dy * 0.75;
  return [
    cloud,
    // Connector circles (approximated as small ellipses)
    `M${c1x + r1},${c1y} A${r1},${r1} 0 1,1 ${c1x - r1},${c1y} A${r1},${r1} 0 1,1 ${c1x + r1},${c1y} Z`,
    `M${c2x + r2},${c2y} A${r2},${r2} 0 1,1 ${c2x - r2},${c2y} A${r2},${r2} 0 1,1 ${c2x + r2},${c2y} Z`,
  ].join(' ');
});

presetShapes.set('borderCallout1', (w, h, adjustments) => {
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 112500)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -38333)) / 100000;
  return `M0,0 L${w},0 L${w},${h} L0,${h} Z M${x1},${y1} L${x2},${y2}`;
});

// ===== Block / 3D Shapes =====

presetShapes.set('cube', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 25000);
  const depth = Math.min(w, h) * a;
  return [
    // Front face
    `M0,${depth} L${w - depth},${depth} L${w - depth},${h} L0,${h} Z`,
    // Top face
    `M0,${depth} L${depth},0 L${w},0 L${w - depth},${depth} Z`,
    // Right face
    `M${w - depth},${depth} L${w},0 L${w},${h - depth} L${w - depth},${h} Z`,
  ].join(' ');
});

// can is implemented as multiPathPreset (see multiPathPresets below)

// ribbon2 is implemented as multiPathPreset (see multiPathPresets below)

presetShapes.set('plus', (w, h, adjustments) => {
  // OOXML: adj=25000 (max 50000), x1 = ss * a / 100000 (uses ss for both x and y)
  const ss = Math.min(w, h);
  const a = Math.min(Math.max(adjRaw(adjustments, 'adj', 25000), 0), 50000);
  const x1 = (ss * a) / 100000;
  const x2 = w - x1;
  const y2 = h - x1;
  return [
    `M0,${x1}`,
    `L${x1},${x1}`,
    `L${x1},0`,
    `L${x2},0`,
    `L${x2},${x1}`,
    `L${w},${x1}`,
    `L${w},${y2}`,
    `L${x2},${y2}`,
    `L${x2},${h}`,
    `L${x1},${h}`,
    `L${x1},${y2}`,
    `L0,${y2}`,
    'Z',
  ].join(' ');
});

presetShapes.set('heart', (w, h) => {
  // OOXML spec: two cubic beziers from (hc, hd4) through (hc, b) and back.
  // dx1 = w*49/48 (slightly wider than w/2), dx2 = w*10/48
  // y1 = t - hd3 (above top edge)
  const hc = w / 2;
  const hd4 = h / 4;
  const hd3 = h / 3;
  const dx1 = (w * 49) / 48;
  const dx2 = (w * 10) / 48;
  const x1 = hc - dx1; // far left control
  const x2 = hc - dx2; // inner left control
  const x3 = hc + dx2; // inner right control
  const x4 = hc + dx1; // far right control
  const y1 = -hd3; // above top (negative y)
  return [
    `M${hc},${hd4}`,
    `C${x3},${y1} ${x4},${hd4} ${hc},${h}`,
    `C${x1},${hd4} ${x2},${y1} ${hc},${hd4}`,
    'Z',
  ].join(' ');
});

presetShapes.set('cloud', (w, h) => {
  // OOXML cloud: 11 arcTo operations in 43200×43200 coordinate space
  const sx = w / 43200;
  const sy = h / 43200;
  // OOXML arcTo: wR/hR are radii, stAng/swAng in 60000ths of degree
  const arcs: [number, number, number, number][] = [
    [6753, 9190, -11429249, 7426832],
    [5333, 7267, -8646143, 5396714],
    [4365, 5945, -8748475, 5983381],
    [4857, 6595, -7859164, 7034504],
    [5333, 7273, -4722533, 6541615],
    [6775, 9220, -2776035, 7816140],
    [5785, 7867, 37501, 6842000],
    [6752, 9215, 1347096, 6910353],
    [7720, 10543, 3974558, 4542661],
    [4360, 5918, -16496525, 8804134],
    [4345, 5945, -14809710, 9151131],
  ];
  let curX = 3900 * sx;
  let curY = 14370 * sy;
  const parts = [`M${curX},${curY}`];
  // Track position in unscaled 43200×43200 space for accurate arcTo computation.
  // OOXML arcTo angles are visual (geometric ray) angles in the path coordinate space.
  // Convert to parametric before computing center/endpoint positions.
  let ux = 3900,
    uy = 14370; // unscaled current position
  for (const [wR, hR, stAng60k, swAng60k] of arcs) {
    const stDeg = stAng60k / 60000;
    const swDeg = swAng60k / 60000;
    // Visual→parametric using UNSCALED radii (path coordinate space)
    const stVisRad = (stDeg * Math.PI) / 180;
    const stRad = Math.atan2(wR * Math.sin(stVisRad), hR * Math.cos(stVisRad));
    const endVisRad = ((stDeg + swDeg) * Math.PI) / 180;
    const endRad = Math.atan2(wR * Math.sin(endVisRad), hR * Math.cos(endVisRad));
    // Compute center and endpoint in unscaled space
    const acx = ux - wR * Math.cos(stRad);
    const acy = uy - hR * Math.sin(stRad);
    const endUX = acx + wR * Math.cos(endRad);
    const endUY = acy + hR * Math.sin(endRad);
    // Scale to pixel space for SVG output
    const endX = endUX * sx;
    const endY = endUY * sy;
    const rwS = wR * sx;
    const rhS = hR * sy;
    const largeArc = Math.abs(swDeg) > 180 ? 1 : 0;
    const sweep = swDeg > 0 ? 1 : 0;
    parts.push(`A${rwS},${rhS} 0 ${largeArc},${sweep} ${endX},${endY}`);
    ux = endUX;
    uy = endUY;
    curX = endX;
    curY = endY;
  }
  parts.push('Z');
  return parts.join(' ');
});

// ===== Frame, Donut, Misc =====

presetShapes.set('frame', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj1', 12500);
  const t = Math.min(w, h) * a;
  return [
    // Outer rectangle
    `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
    // Inner rectangle (counter-clockwise for hole)
    `M${t},${t} L${t},${h - t} L${w - t},${h - t} L${w - t},${t} Z`,
  ].join(' ');
});

presetShapes.set('halfFrame', (w, h, adjustments) => {
  // OOXML spec defaults: adj1=33333, adj2=33333
  const adj1Raw = adjustments?.get('adj1') ?? 33333;
  const adj2Raw = adjustments?.get('adj2') ?? 33333;
  const minWH = Math.min(w, h);
  const a2 = Math.max(0, Math.min(adj2Raw, (100000 * w) / Math.max(minWH, 1)));
  const x1 = (minWH * a2) / 100000;
  const g1 = (h * x1) / Math.max(w, 1);
  const g2 = h - g1;
  const a1 = Math.max(0, Math.min(adj1Raw, (100000 * g2) / Math.max(minWH, 1)));
  const y1 = (minWH * a1) / 100000;
  const x2 = w - (y1 * w) / Math.max(h, 1);
  const y2 = h - (x1 * h) / Math.max(w, 1);
  return [`M0,0`, `L${w},0`, `L${x2},${y1}`, `L${x1},${y1}`, `L${x1},${y2}`, `L0,${h}`, 'Z'].join(
    ' ',
  );
});

presetShapes.set('donut', (w, h, adjustments) => {
  // OOXML: adj=25000, dr = ss * a / 100000, inner radii = wd2-dr, hd2-dr
  const ss = Math.min(w, h);
  const a = Math.min(Math.max(adjRaw(adjustments, 'adj', 25000), 0), 50000);
  const dr = (ss * a) / 100000;
  const rx = w / 2;
  const ry = h / 2;
  const iwd2 = Math.max(0, rx - dr);
  const ihd2 = Math.max(0, ry - dr);
  return [
    // Outer circle (CW)
    `M0,${ry}`,
    `A${rx},${ry} 0 1,1 ${w},${ry}`,
    `A${rx},${ry} 0 1,1 0,${ry}`,
    'Z',
    // Inner circle (CCW for evenodd hole)
    `M${dr},${ry}`,
    `A${iwd2},${ihd2} 0 1,0 ${w - dr},${ry}`,
    `A${iwd2},${ihd2} 0 1,0 ${dr},${ry}`,
    'Z',
  ].join(' ');
});

presetShapes.set('noSmoking', (w, h, adjustments) => {
  // OOXML: adj=18750. Ring thickness = ss*a/100000. Diagonal band via inner ellipse arcs + evenodd.
  const ss = Math.min(w, h);
  const a = Math.min(Math.max(adjRaw(adjustments, 'adj', 18750), 0), 50000);
  const dr = (ss * a) / 100000;
  const rx = w / 2;
  const ry = h / 2;
  const hc = w / 2;
  const vc = h / 2;
  const iwd2 = rx - dr;
  const ihd2 = ry - dr;
  // Compute diagonal angle and band intersection with inner ellipse
  const ang = Math.atan2(h, w); // at2(w, h) in OOXML: at2 x y = atan2(y, x)
  // Inner ellipse radius at diagonal angle
  const ct = ihd2 * Math.cos(ang);
  const st = iwd2 * Math.sin(ang);
  const m = Math.sqrt(ct * ct + st * st) || 1;
  const n = (iwd2 * ihd2) / m;
  const drd2 = dr / 2;
  const dang = Math.atan2(drd2, n);
  const dang2 = dang * 2;
  // Sweep for inner arcs: -(180° - dang2) expressed as OOXML 60000ths then converted
  const swAngRad = -(Math.PI - dang2);
  const stAng1 = ang - dang;
  const stAng2 = stAng1 - Math.PI;
  // Compute points on inner ellipse for the two diagonal band arcs
  const innerPt = (angle: number) => {
    const ct2 = ihd2 * Math.cos(angle);
    const st2 = iwd2 * Math.sin(angle);
    const m2 = Math.sqrt(ct2 * ct2 + st2 * st2) || 1;
    const n2 = (iwd2 * ihd2) / m2;
    return { x: hc + n2 * Math.cos(angle), y: vc + n2 * Math.sin(angle) };
  };
  const p1 = innerPt(stAng1);
  const p2 = innerPt(stAng2);
  // End points of arcs
  const endAng1 = stAng1 + swAngRad;
  const endAng2 = stAng2 + swAngRad;
  const e1 = innerPt(endAng1);
  const e2 = innerPt(endAng2);
  const largeArc = Math.abs(swAngRad) > Math.PI ? 1 : 0;
  const sweep = swAngRad > 0 ? 1 : 0;
  return [
    // Outer circle (CW)
    `M0,${vc}`,
    `A${rx},${ry} 0 1,1 ${w},${vc}`,
    `A${rx},${ry} 0 1,1 0,${vc}`,
    'Z',
    // First diagonal band arc (inner ellipse)
    `M${p1.x},${p1.y}`,
    `A${iwd2},${ihd2} 0 ${largeArc},${sweep} ${e1.x},${e1.y}`,
    'Z',
    // Second diagonal band arc (opposite quadrant)
    `M${p2.x},${p2.y}`,
    `A${iwd2},${ihd2} 0 ${largeArc},${sweep} ${e2.x},${e2.y}`,
    'Z',
  ].join(' ');
});

presetShapes.set('blockArc', (w, h, adjustments) => {
  const adj1Raw = adjustments?.get('adj1') ?? 10800000; // start angle
  const adj2Raw = adjustments?.get('adj2') ?? 0; // sweep/end angle
  const adj3Raw = adjustments?.get('adj3') ?? 25000; // thickness ratio
  const startDeg = Math.min(Math.max(adj1Raw / 60000, 0), 360);
  const innerStartDeg = Math.min(Math.max(adj2Raw / 60000, 0), 360);
  const sweepDeg = (innerStartDeg - startDeg + 360) % 360 || 360;
  const endDeg = startDeg + sweepDeg;
  const innerEndDeg = innerStartDeg - sweepDeg;
  const wd2 = w / 2;
  const hd2 = h / 2;
  const dr = (Math.min(w, h) * Math.max(0, Math.min(adj3Raw, 50000))) / 100000;
  const iwd2 = Math.max(1, wd2 - dr);
  const ihd2 = Math.max(1, hd2 - dr);
  const p = (cx: number, cy: number, rx: number, ry: number, deg: number) => {
    const r = (deg * Math.PI) / 180;
    return { x: cx + rx * Math.cos(r), y: cy + ry * Math.sin(r) };
  };
  const oStart = p(wd2, hd2, wd2, hd2, startDeg);
  const oEnd = p(wd2, hd2, wd2, hd2, endDeg);
  const iStart = p(wd2, hd2, iwd2, ihd2, innerStartDeg);
  const iEnd = p(wd2, hd2, iwd2, ihd2, innerEndDeg);
  const largeArc = sweepDeg > 180 ? 1 : 0;

  return [
    `M${oStart.x},${oStart.y}`,
    `A${wd2},${hd2} 0 ${largeArc},1 ${oEnd.x},${oEnd.y}`,
    `L${iStart.x},${iStart.y}`,
    `A${iwd2},${ihd2} 0 ${largeArc},0 ${iEnd.x},${iEnd.y}`,
    'Z',
  ].join(' ');
});

// ===== Gear Shapes =====

presetShapes.set('gear6', (w, h, adjustments) => {
  const a1 = adjustments?.get('adj1') ?? 15000;
  const a2 = adjustments?.get('adj2') ?? 3526;
  return gearShape(w, h, 6, a1, a2);
});

presetShapes.set('gear9', (w, h, adjustments) => {
  const a1 = adjustments?.get('adj1') ?? 10000;
  const a2 = adjustments?.get('adj2') ?? 1763;
  return gearShape(w, h, 9, a1, a2);
});

function gearShape(w: number, h: number, teeth: number, adj1Raw: number, adj2Raw: number): string {
  // Gear shape: teeth protrude from inner ellipse by th, narrowed by lFD at tips.
  // Uses per-tooth edge-perpendicular computation for B/C tip direction.
  const cx = w / 2;
  const cy = h / 2;
  const ss = Math.min(w, h);
  const maxAdj2 = teeth === 6 ? 5358 : 2679;
  const a1v = Math.min(Math.max(adj1Raw, 0), 20000);
  const a2v = Math.min(Math.max(adj2Raw, 0), maxAdj2);
  const th = (ss * a1v) / 100000; // tooth height
  const lFD = (ss * a2v) / 100000; // tooth flat distance offset

  const rw = w / 2 - th; // inner ellipse width radius
  const rh = h / 2 - th; // inner ellipse height radius
  if (rw <= 0 || rh <= 0) return `M0,0 L${w},0 L${w},${h} L0,${h} Z`;

  // OOXML: ha = at2(maxr, l3) where maxr=min(rw,rh), l3=th/2+lFD/2
  const l3 = th / 2 + lFD / 2;
  const maxr = Math.min(rw, rh);
  const ha = Math.atan2(l3, maxr); // half-angle of each tooth on the inner ellipse

  const centerDegs =
    teeth === 6 ? [330, 30, 90, 150, 210, 270] : [310, 350, 30, 70, 110, 150, 190, 230, 270];

  const parts: string[] = [];

  for (let i = 0; i < centerDegs.length; i++) {
    const baseAngle = (centerDegs[i] * Math.PI) / 180;
    const aStart = baseAngle - ha; // tooth base start angle (A point)
    const aEnd = baseAngle + ha; // tooth base end angle (D point)

    // A and D: inner ellipse points at tooth base edges
    const ax = cx + rw * Math.cos(aStart);
    const ay = cy + rh * Math.sin(aStart);
    const dx = cx + rw * Math.cos(aEnd);
    const dy = cy + rh * Math.sin(aEnd);

    // Per-tooth edge-perpendicular tip computation:
    // Edge direction A→D
    const edgeX = dx - ax;
    const edgeY = dy - ay;
    const edgeLen = Math.sqrt(edgeX * edgeX + edgeY * edgeY);

    // Unit normal perpendicular to edge, pointing outward
    // For clockwise winding (our standard), outward normal is (-edgeY, edgeX) / len
    // Verify with radial dot product and flip if needed
    let nx = -edgeY / edgeLen;
    let ny = edgeX / edgeLen;
    const radX = Math.cos(baseAngle);
    const radY = Math.sin(baseAngle);
    if (nx * radX + ny * radY < 0) {
      nx = -nx;
      ny = -ny;
    }

    // Narrowing: slide A and D inward along edge by lFD
    const ex = edgeLen > 0 ? edgeX / edgeLen : 0;
    const ey = edgeLen > 0 ? edgeY / edgeLen : 0;
    const axN = ax + ex * lFD; // A narrowed (moved toward D)
    const ayN = ay + ey * lFD;
    const dxN = dx - ex * lFD; // D narrowed (moved toward A)
    const dyN = dy - ey * lFD;

    // B and C: tip points = narrowed base + th * outward normal
    const bx = axN + nx * th;
    const by = ayN + ny * th;
    const _cx = dxN + nx * th;
    const _cy = dyN + ny * th;

    if (i === 0) {
      // Start at the valley before first tooth
      const prevEnd = (centerDegs[centerDegs.length - 1] * Math.PI) / 180 + ha;
      const prevIx = cx + rw * Math.cos(prevEnd);
      const prevIy = cy + rh * Math.sin(prevEnd);
      parts.push(`M${prevIx},${prevIy}`);
      parts.push(`A${rw},${rh} 0 0,1 ${ax},${ay}`);
    }

    // Tooth: A→B→C→D
    parts.push(`L${bx},${by}`);
    parts.push(`L${_cx},${_cy}`);
    parts.push(`L${dx},${dy}`);

    // Arc along inner ring to next tooth
    if (i < centerDegs.length - 1) {
      const nextStart = (centerDegs[i + 1] * Math.PI) / 180 - ha;
      const nx2 = cx + rw * Math.cos(nextStart);
      const ny2 = cy + rh * Math.sin(nextStart);
      parts.push(`A${rw},${rh} 0 0,1 ${nx2},${ny2}`);
    }
  }
  parts.push('Z');
  return parts.join(' ');
}

// ===== Misc Shapes =====

presetShapes.set('mathPlus', (w, h, adjustments) => {
  // OOXML: adj1=23520 (max 73490). dx1 = w*73490/200000, dx2 = ss*a/200000
  const ss = Math.min(w, h);
  const a1 = Math.min(Math.max(adjRaw(adjustments, 'adj', 23520), 0), 73490);
  const dx1 = (w * 73490) / 200000;
  const dy1 = (h * 73490) / 200000;
  const dx2 = (ss * a1) / 200000;
  const hc = w / 2;
  const vc = h / 2;
  const x1 = hc - dx1;
  const x2 = hc - dx2;
  const x3 = hc + dx2;
  const x4 = hc + dx1;
  const y1 = vc - dy1;
  const y2 = vc - dx2;
  const y3 = vc + dx2;
  const y4 = vc + dy1;
  return [
    `M${x1},${y2}`,
    `L${x2},${y2}`,
    `L${x2},${y1}`,
    `L${x3},${y1}`,
    `L${x3},${y2}`,
    `L${x4},${y2}`,
    `L${x4},${y3}`,
    `L${x3},${y3}`,
    `L${x3},${y4}`,
    `L${x2},${y4}`,
    `L${x2},${y3}`,
    `L${x1},${y3}`,
    'Z',
  ].join(' ');
});

presetShapes.set('mathMinus', (w, h, adjustments) => {
  // OOXML: adj1=23520 (max 100000). dy1 = h*a1/200000, dx1 = w*73490/200000
  const a1 = Math.min(Math.max(adjRaw(adjustments, 'adj1', 23520), 0), 100000);
  const dy1 = (h * a1) / 200000;
  const dx1 = (w * 73490) / 200000;
  const hc = w / 2;
  const vc = h / 2;
  const x1 = hc - dx1;
  const x2 = hc + dx1;
  const y1 = vc - dy1;
  const y2 = vc + dy1;
  return `M${x1},${y1} L${x2},${y1} L${x2},${y2} L${x1},${y2} Z`;
});

presetShapes.set('mathMultiply', (w, h, adjustments) => {
  // OOXML: adj1=23520 (max 51965). X shape with diagonal arms.
  // Key: a = at2 w h → atan2(w, h), coordinates are absolute from top-left.
  const ss = Math.min(w, h);
  const hc = w / 2;
  const vc = h / 2;
  const a1 = Math.min(Math.max(adjRaw(adjustments, 'adj1', 23520), 0), 51965);
  const th = (ss * a1) / 100000;
  const a = Math.atan2(h, w);
  const sa = Math.sin(a);
  const ca = Math.cos(a);
  const ta = sa / ca; // tan(a)
  const dl = Math.sqrt(w * w + h * h);
  const rw = (dl * 51965) / 100000;
  const lM = dl - rw;
  // xM, yM: half-distance along the diagonal from the outer tip to the outer tip
  const xM = (ca * lM) / 2;
  const yM = (sa * lM) / 2;
  // Perpendicular offset for arm thickness
  const dxAM = (sa * th) / 2;
  const dyAM = (ca * th) / 2;
  // xA, yA = upper-left outer tip (left side of arm), coordinates from (0,0)
  const xA = xM - dxAM;
  const yA = yM + dyAM;
  const xB = xM + dxAM;
  const yB = yM - dyAM;
  // yC = center notch: where the inner edge of one arm meets the inner edge of the other
  const xBC = hc - xB;
  const yBC = xBC * ta;
  const yC = yBC + yB;
  // Mirror points for upper-right quadrant
  const xD = w - xB;
  const xE = w - xA;
  // xF: where the arm inner edge meets vc (center y)
  const yFE = vc - yA;
  const xFE = yFE / ta;
  const xF = xE - xFE;
  const xL = xA + xFE;
  // Bottom half mirrors
  const yG = h - yA;
  const yH = h - yB;
  const yI = h - yC;
  return [
    `M${xA},${yA}`,
    `L${xB},${yB}`,
    `L${hc},${yC}`,
    `L${xD},${yB}`,
    `L${xE},${yA}`,
    `L${xF},${vc}`,
    `L${xE},${yG}`,
    `L${xD},${yH}`,
    `L${hc},${yI}`,
    `L${xB},${yH}`,
    `L${xA},${yG}`,
    `L${xL},${vc}`,
    'Z',
  ].join(' ');
});

presetShapes.set('mathDivide', (w, h, adjustments) => {
  const adj1 = adjustments?.get('adj1') ?? 23520;
  const adj2 = adjustments?.get('adj2') ?? 5880;
  const adj3 = adjustments?.get('adj3') ?? 11760;

  const a1 = Math.min(Math.max(adj1, 1000), 36745);
  const maxAdj3 = Math.min((73490 - a1) / 4, (36745 * w) / Math.max(h, 1));
  const a3 = Math.min(Math.max(adj3, 1000), maxAdj3);
  const maxAdj2 = 73490 - 4 * a3 - a1;
  const a2 = Math.min(Math.max(adj2, 0), maxAdj2);

  const hc = w / 2;
  const vc = h / 2;
  const dy1 = (h * a1) / 200000;
  const yg = (h * a2) / 100000;
  const rad = (h * a3) / 100000;
  const dx1 = (w * 73490) / 200000;
  const y3 = vc - dy1;
  const y4 = vc + dy1;
  const y2 = y3 - (yg + rad);
  const y1 = y2 - rad;
  const y5 = h - y1;
  const x1 = hc - dx1;
  const x3 = hc + dx1;

  return [
    // Top dot
    `M${hc + rad},${y1 + rad} A${rad},${rad} 0 1,1 ${hc - rad},${y1 + rad} A${rad},${rad} 0 1,1 ${hc + rad},${y1 + rad} Z`,
    // Bottom dot
    `M${hc + rad},${y5 - rad} A${rad},${rad} 0 1,1 ${hc - rad},${y5 - rad} A${rad},${rad} 0 1,1 ${hc + rad},${y5 - rad} Z`,
    // Bar
    `M${x1},${y3} L${x3},${y3} L${x3},${y4} L${x1},${y4} Z`,
  ].join(' ');
});

presetShapes.set('mathEqual', (w, h, adjustments) => {
  // OOXML: adj1=23520 (bar thickness, max 36745), adj2=11760 (gap, max 100000-2*a1)
  const adj1Raw = adjustments?.get('adj1') ?? 23520;
  const adj2Raw = adjustments?.get('adj2') ?? 11760;
  const a1 = Math.min(Math.max(adj1Raw, 0), 36745);
  const mAdj2 = 100000 - a1 * 2;
  const a2 = Math.min(Math.max(adj2Raw, 0), Math.max(mAdj2, 0));
  const dy1 = (h * a1) / 100000;
  const dy2 = (h * a2) / 200000;
  const dx1 = (w * 73490) / 200000;
  const hc = w / 2;
  const vc = h / 2;
  const y2 = vc - dy2; // center of top bar
  const y3 = vc + dy2; // center of bottom bar
  const y1 = y2 - dy1; // top of top bar
  const y4 = y3 + dy1; // bottom of bottom bar
  const x1 = hc - dx1;
  const x2 = hc + dx1;
  return [
    `M${x1},${y1} L${x2},${y1} L${x2},${y2} L${x1},${y2} Z`,
    `M${x1},${y3} L${x2},${y3} L${x2},${y4} L${x1},${y4} Z`,
  ].join(' ');
});

presetShapes.set('mathNotEqual', (w, h, adjustments) => {
  // Follow OOXML mathNotEqual geometry (single closed contour), which keeps
  // bar thickness/slash width and intersections aligned with PowerPoint.
  const adj1Raw = adjustments?.get('adj1') ?? 23520;
  const adj2Raw = adjustments?.get('adj2');
  const adj3Raw = adjustments?.get('adj3') ?? 11760;

  const hc = w / 2;
  const vc = h / 2;
  const hd2 = h / 2;

  const a1 = Math.min(Math.max(adj1Raw, 0), 50000);
  const crAng = (() => {
    if (adj2Raw === undefined) return (110 * Math.PI) / 180;
    const rad = ((adj2Raw / 60000) * Math.PI) / 180;
    const min = (70 * Math.PI) / 180;
    const max = (110 * Math.PI) / 180;
    return Math.min(Math.max(rad, min), max);
  })();

  const maxAdj3 = 100000 - a1 * 2;
  const a3 = Math.min(Math.max(adj3Raw, 0), maxAdj3);

  const dy1 = (h * a1) / 100000;
  const dy2 = (h * a3) / 200000;
  const dx1 = (w * 73490) / 200000;
  const x1 = hc - dx1;
  const x8 = hc + dx1;
  const y2 = vc - dy2;
  const y3 = vc + dy2;
  const y1 = y2 - dy1;
  const y4 = y3 + dy1;

  const cadj2 = crAng - Math.PI / 2;
  const xadj2 = hd2 * Math.tan(cadj2);
  const len = Math.hypot(xadj2, hd2) || 1;
  const bhw = (len * dy1) / hd2;
  const bhw2 = bhw / 2;
  const x7 = hc + xadj2 - bhw2;
  const x6 = x7 - (xadj2 * y1) / hd2;
  const x5 = x7 - (xadj2 * y2) / hd2;
  const x4 = x7 - (xadj2 * y3) / hd2;
  const x3 = x7 - (xadj2 * y4) / hd2;
  const rx7 = x7 + bhw;
  const rx6 = x6 + bhw;
  const rx5 = x5 + bhw;
  const rx4 = x4 + bhw;
  const rx3 = x3 + bhw;

  const dx7 = (dy1 * hd2) / len;
  const rx = cadj2 > 0 ? x7 + dx7 : rx7;
  const lx = cadj2 > 0 ? x7 : rx7 - dx7;
  const dy3 = (dy1 * xadj2) / len;
  const ry = cadj2 > 0 ? dy3 : 0;
  const ly = cadj2 > 0 ? 0 : -dy3;
  const dlx = w - rx;
  const drx = w - lx;
  const dly = h - ry;
  const dry = h - ly;

  return [
    `M${x1},${y1}`,
    `L${x6},${y1}`,
    `L${lx},${ly}`,
    `L${rx},${ry}`,
    `L${rx6},${y1}`,
    `L${x8},${y1}`,
    `L${x8},${y2}`,
    `L${rx5},${y2}`,
    `L${rx4},${y3}`,
    `L${x8},${y3}`,
    `L${x8},${y4}`,
    `L${rx3},${y4}`,
    `L${drx},${dry}`,
    `L${dlx},${dly}`,
    `L${x3},${y4}`,
    `L${x1},${y4}`,
    `L${x1},${y3}`,
    `L${x4},${y3}`,
    `L${x5},${y2}`,
    `L${x1},${y2}`,
    'Z',
  ].join(' ');
});

presetShapes.set('round1Rect', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 16667);
  const r = Math.min(w, h) * a;
  return [`M0,0`, `L${w - r},0`, `A${r},${r} 0 0,1 ${w},${r}`, `L${w},${h}`, `L0,${h}`, 'Z'].join(
    ' ',
  );
});

presetShapes.set('round2SameRect', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 16667);
  const a2 = adj(adjustments, 'adj2', 0);
  const r1 = Math.min(w, h) * a1;
  const r2 = Math.min(w, h) * a2;
  return [
    `M${r1},0`,
    `L${w - r1},0`,
    `A${r1},${r1} 0 0,1 ${w},${r1}`,
    `L${w},${h - r2}`,
    `A${r2},${r2} 0 0,1 ${w - r2},${h}`,
    `L${r2},${h}`,
    `A${r2},${r2} 0 0,1 0,${h - r2}`,
    `L0,${r1}`,
    `A${r1},${r1} 0 0,1 ${r1},0`,
    'Z',
  ].join(' ');
});

presetShapes.set('round2DiagRect', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 16667);
  const a2 = adj(adjustments, 'adj2', 0);
  const r1 = Math.min(w, h) * a1;
  const r2 = Math.min(w, h) * a2;
  return [
    `M${r1},0`,
    `L${w},0`,
    `L${w},${h - r2}`,
    `A${r2},${r2} 0 0,1 ${w - r2},${h}`,
    `L0,${h}`,
    `L0,${r1}`,
    `A${r1},${r1} 0 0,1 ${r1},0`,
    'Z',
  ].join(' ');
});

presetShapes.set('snip1Rect', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 16667);
  const d = Math.min(w, h) * a;
  return `M0,0 L${w - d},0 L${w},${d} L${w},${h} L0,${h} Z`;
});

presetShapes.set('snip2SameRect', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 16667);
  const a2 = adj(adjustments, 'adj2', 0);
  const d1 = Math.min(w, h) * a1;
  const d2 = Math.min(w, h) * a2;
  return `M${d1},0 L${w - d1},0 L${w},${d1} L${w},${h - d2} L${w - d2},${h} L${d2},${h} L0,${h - d2} L0,${d1} Z`;
});

presetShapes.set('snip2DiagRect', (w, h, adjustments) => {
  // OOXML spec: diagonal snipped rectangle. adj1=top-left/bottom-right, adj2=top-right/bottom-left
  const ss = Math.min(w, h);
  const a1 = Math.min(Math.max(adjustments?.get('adj1') ?? 0, 0), 50000);
  const a2 = Math.min(Math.max(adjustments?.get('adj2') ?? 16667, 0), 50000);
  const lx1 = (ss * a1) / 100000;
  const lx2 = w - lx1;
  const ly1 = h - lx1;
  const rx1 = (ss * a2) / 100000;
  const rx2 = w - rx1;
  const ry1 = h - rx1;
  return `M${lx1},0 L${rx2},0 L${w},${rx1} L${w},${ly1} L${lx2},${h} L${rx1},${h} L0,${ry1} L0,${lx1} Z`;
});

presetShapes.set('snipRoundRect', (w, h, adjustments) => {
  const a1 = adj(adjustments, 'adj1', 16667);
  const a2 = adj(adjustments, 'adj2', 16667);
  const r = Math.min(w, h) * a1;
  const d = Math.min(w, h) * a2;
  return [
    `M${r},0`,
    `L${w - d},0`,
    `L${w},${d}`,
    `L${w},${h}`,
    `L0,${h}`,
    `L0,${r}`,
    `A${r},${r} 0 0,1 ${r},0`,
    'Z',
  ].join(' ');
});

presetShapes.set('bevel', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 12500);
  const t = Math.min(w, h) * a;
  return [
    // Outer
    `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
    // Inner
    `M${t},${t} L${t},${h - t} L${w - t},${h - t} L${w - t},${t} Z`,
    // Connecting triangles (top)
    `M0,0 L${w},0 L${w - t},${t} L${t},${t} Z`,
    // Right
    `M${w},0 L${w},${h} L${w - t},${h - t} L${w - t},${t} Z`,
    // Bottom
    `M${w},${h} L0,${h} L${t},${h - t} L${w - t},${h - t} Z`,
    // Left
    `M0,${h} L0,0 L${t},${t} L${t},${h - t} Z`,
  ].join(' ');
});

presetShapes.set('foldedCorner', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 16667);
  const fold = Math.min(w, h) * a * 0.7;
  return [
    `M0,0 L${w},0 L${w},${h} L0,${h} Z`,
    // Fold triangle
    `M${w - fold},${h} L${w},${h} L${w},${h - fold}`,
  ].join(' ');
});

// smileyFace is implemented as multiPathPreset (see multiPathPresets below)

presetShapes.set('sun', (w, h, adjustments) => {
  // OOXML spec: adj default=25000, pinned 12500..46875
  const adjRaw = adjustments?.get('adj') ?? 25000;
  const a = Math.min(Math.max(adjRaw, 12500), 46875);
  const g0 = 50000 - a;
  // OOXML guide formulas
  const g1 = (g0 * 30274) / 32768;
  const g2 = (g0 * 12540) / 32768;
  const _g3 = g1 + 50000;
  const _g4 = g2 + 50000;
  const g5 = 50000 - g1;
  const g6 = 50000 - g2;
  const g7 = (g0 * 23170) / 32768;
  const g8 = 50000 + g7;
  const g9 = 50000 - g7;
  const g10 = (g5 * 3) / 4;
  const g11 = (g6 * 3) / 4;
  const g12 = g10 + 3662;
  const g13 = g11 + 3662;
  const g14 = g11 + 12500;
  const g15 = 100000 - g10;
  const g16 = 100000 - g12;
  const g17 = 100000 - g13;
  const g18 = 100000 - g14;
  // Pixel coordinates
  const hc = w / 2;
  const vc = h / 2;
  const ox1 = (w * 18436) / 21600;
  const oy1 = (h * 3163) / 21600;
  const ox2 = (w * 3163) / 21600;
  const oy2 = (h * 18436) / 21600;
  const s = (pct: number, dim: number) => (dim * pct) / 100000;
  const _x8 = s(g8, w);
  const _x9 = s(g9, w);
  const x10 = s(g10, w);
  const x12 = s(g12, w);
  const x13 = s(g13, w);
  const x14 = s(g14, w);
  const x15 = s(g15, w);
  const x16 = s(g16, w);
  const x17 = s(g17, w);
  const x18 = s(g18, w);
  const wR = s(g0, w);
  const hR = s(g0, h);
  const _y8 = s(g8, h);
  const _y9 = s(g9, h);
  const y10 = s(g10, h);
  const y12 = s(g12, h);
  const y13 = s(g13, h);
  const y14 = s(g14, h);
  const y15 = s(g15, h);
  const y16 = s(g16, h);
  const y17 = s(g17, h);
  const y18 = s(g18, h);
  const x19 = s(a, w);
  return [
    // Ray 0: right
    `M${w},${vc} L${x15},${y18} L${x15},${y14} Z`,
    // Ray 1: top-right
    `M${ox1},${oy1} L${x16},${y13} L${x17},${y12} Z`,
    // Ray 2: top
    `M${hc},0 L${x18},${y10} L${x14},${y10} Z`,
    // Ray 3: top-left
    `M${ox2},${oy1} L${x13},${y12} L${x12},${y13} Z`,
    // Ray 4: left
    `M0,${vc} L${x10},${y14} L${x10},${y18} Z`,
    // Ray 5: bottom-left
    `M${ox2},${oy2} L${x12},${y17} L${x13},${y16} Z`,
    // Ray 6: bottom
    `M${hc},${h} L${x14},${y15} L${x18},${y15} Z`,
    // Ray 7: bottom-right
    `M${ox1},${oy2} L${x17},${y16} L${x16},${y17} Z`,
    // Center ellipse (arcTo from x19,vc with wR,hR, startAngle=180°, sweep=360°)
    `M${x19},${vc}`,
    `A${wR},${hR} 0 1,1 ${x19 + 2 * wR},${vc}`,
    `A${wR},${hR} 0 1,1 ${x19},${vc}`,
    'Z',
  ].join(' ');
});

presetShapes.set('moon', (w, h, adjustments) => {
  if (w <= 0 || h <= 0) return `M0,0 L${w},0 L${w},${h} L0,${h} Z`;
  // OOXML moon: outer semicircle (rx=w, ry=h/2) + inner semicircle (rx=g18w, ry=dy1).
  // Both arcs share endpoints (w,0) and (w,h). Inner ellipse centered at (g0w+g18w, h/2).
  const ss = Math.min(w, h);
  const hd2 = h / 2;
  const a = Math.min(Math.max(adjustments?.get('adj') ?? 50000, 0), 87500);
  const g0 = (ss * a) / 100000;
  const g1 = ss - g0;
  if (g1 <= 0) return `M0,0 L${w},0 L${w},${h} L0,${h} Z`;
  const g0w = (g0 * w) / ss;
  const g5 = (2 * ss * ss - g0 * g0) / g1;
  const g6w = ((g5 - g0) * w) / ss;
  const g8 = g5 / 2 - g0;
  const dy1 = (g8 * hd2) / ss;
  const g18w = (g6w - g0w) / 2;
  return [
    `M${w},${h}`,
    `A${w},${hd2} 0 0,1 ${w},0`, // outer: (w,h) → left semicircle → (w,0)
    `A${g18w},${dy1} 0 0,0 ${w},${h}`, // inner: (w,0) → concave arc → (w,h)
    'Z',
  ].join(' ');
});

presetShapes.set('lightningBolt', (w, h) => {
  // Calibrated against OOXML preset rendering (PowerPoint PDF export):
  // the old simplified 7-point bolt was too wide and lacked the inner notches.
  // This normalized 11-point contour follows the default lightningBolt geometry.
  return [
    `M${w * 0.3895},${h * 0.0}`,
    `L${w * 0.0},${h * 0.1821}`,
    `L${w * 0.3425},${h * 0.3845}`,
    `L${w * 0.2265},${h * 0.4452}`,
    `L${w * 0.5497},${h * 0.6391}`,
    `L${w * 0.453},${h * 0.683}`,
    `L${w * 0.9972},${h * 0.9983}`,
    `L${w * 0.6796},${h * 0.5919}`,
    `L${w * 0.7624},${h * 0.5514}`,
    `L${w * 0.5138},${h * 0.3153}`,
    `L${w * 0.5939},${h * 0.2816}`,
    'Z',
  ].join(' ');
});

presetShapes.set('bracketPair', (w, h, adjustments) => {
  // OOXML: adj=16667 (max 50000), radius = ss * a / 100000
  const ss = Math.min(w, h);
  const a = Math.min(Math.max(adjRaw(adjustments, 'adj', 16667), 0), 50000);
  const r = (ss * a) / 100000;
  const x2 = w - r;
  const y2 = h - r;
  return [
    // Left bracket: bottom-left arc → vertical → top-left arc
    `M${r},${h}`,
    `A${r},${r} 0 0,1 0,${y2}`,
    `L0,${r}`,
    `A${r},${r} 0 0,1 ${r},0`,
    // Right bracket: top-right arc → vertical → bottom-right arc
    `M${x2},0`,
    `A${r},${r} 0 0,1 ${w},${r}`,
    `L${w},${y2}`,
    `A${r},${r} 0 0,1 ${x2},${h}`,
  ].join(' ');
});

presetShapes.set('bracePair', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 8333);
  const r = Math.min(w, h) * a;
  const cy = h / 2;
  return [
    // Left brace
    `M${r * 2},0`,
    `A${r},${r} 0 0,0 ${r},${r}`,
    `L${r},${cy - r}`,
    `A${r},${r} 0 0,1 0,${cy}`,
    `A${r},${r} 0 0,1 ${r},${cy + r}`,
    `L${r},${h - r}`,
    `A${r},${r} 0 0,0 ${r * 2},${h}`,
    // Right brace
    `M${w - r * 2},0`,
    `A${r},${r} 0 0,1 ${w - r},${r}`,
    `L${w - r},${cy - r}`,
    `A${r},${r} 0 0,0 ${w},${cy}`,
    `A${r},${r} 0 0,0 ${w - r},${cy + r}`,
    `L${w - r},${h - r}`,
    `A${r},${r} 0 0,1 ${w - r * 2},${h}`,
  ].join(' ');
});

presetShapes.set('leftBracket', (w, h, adjustments) => {
  const ss = Math.min(w, h);
  const maxAdj = ss > 0 ? (50000 * h) / ss : 0;
  const a = Math.max(0, Math.min(adjustments?.get('adj') ?? 8333, maxAdj));
  const y1 = (ss * a) / 100000;
  const toDeg = (ooxmlAng: number) => ooxmlAng / 60000;
  const arcFrom = (
    x0: number,
    y0: number,
    rx: number,
    ry: number,
    stAng: number,
    swAng: number,
  ) => {
    const st = (toDeg(stAng) * Math.PI) / 180;
    const sw = (toDeg(swAng) * Math.PI) / 180;
    const cx = x0 - rx * Math.cos(st);
    const cy = y0 - ry * Math.sin(st);
    const x1 = cx + rx * Math.cos(st + sw);
    const y1p = cy + ry * Math.sin(st + sw);
    const large = Math.abs(toDeg(swAng)) > 180 ? 1 : 0;
    const sweep = swAng >= 0 ? 1 : 0;
    return { cmd: `A${rx},${ry} 0 ${large},${sweep} ${x1},${y1p}`, x: x1, y: y1p };
  };

  const a1 = arcFrom(w, h, w, y1, 5400000, 5400000); // cd4, cd4
  const a2 = arcFrom(0, y1, w, y1, 10800000, 5400000); // cd2, cd4
  return [`M${w},${h}`, a1.cmd, `L0,${y1}`, a2.cmd].join(' ');
});

presetShapes.set('rightBracket', (w, h, adjustments) => {
  const ss = Math.min(w, h);
  const maxAdj = ss > 0 ? (50000 * h) / ss : 0;
  const a = Math.max(0, Math.min(adjustments?.get('adj') ?? 8333, maxAdj));
  const y1 = (ss * a) / 100000;
  const y2 = h - y1;
  const toDeg = (ooxmlAng: number) => ooxmlAng / 60000;
  const arcFrom = (
    x0: number,
    y0: number,
    rx: number,
    ry: number,
    stAng: number,
    swAng: number,
  ) => {
    const st = (toDeg(stAng) * Math.PI) / 180;
    const sw = (toDeg(swAng) * Math.PI) / 180;
    const cx = x0 - rx * Math.cos(st);
    const cy = y0 - ry * Math.sin(st);
    const x1 = cx + rx * Math.cos(st + sw);
    const y1p = cy + ry * Math.sin(st + sw);
    const large = Math.abs(toDeg(swAng)) > 180 ? 1 : 0;
    const sweep = swAng >= 0 ? 1 : 0;
    return { cmd: `A${rx},${ry} 0 ${large},${sweep} ${x1},${y1p}`, x: x1, y: y1p };
  };

  const a1 = arcFrom(0, 0, w, y1, 16200000, 5400000); // 3cd4, cd4
  const a2 = arcFrom(w, y2, w, y1, 0, 5400000); // 0, cd4
  return [`M0,0`, a1.cmd, `L${w},${y2}`, a2.cmd].join(' ');
});

/**
 * 把一段圆/椭圆弧采样成折线（degree-by-degree），用 L 命令续接到当前路径。
 * brace（leftBrace/rightBrace）的曲臂半径极扁（rx≫ry，例如 rx≈8、ry≈1.3），
 * 单条 SVG `A` 椭圆弧命令在这种近退化椭圆下渲染会失真/不对称（括号歪斜）。
 * 逐度折线（与 PPTXjs shapeArc 同法）则稳定可靠。stAng/endAng 单位为「度」，
 * 圆心 (cx,cy) 给定，点 = (cx+cos·rx, cy+sin·ry)。
 */
function braceArcPoly(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  stAngDeg: number,
  endAngDeg: number,
): string {
  const pts: string[] = [];
  const step = endAngDeg >= stAngDeg ? 1 : -1;
  for (let a = stAngDeg; step > 0 ? a <= endAngDeg : a >= endAngDeg; a += step) {
    const r = (a * Math.PI) / 180;
    pts.push(`L${(cx + Math.cos(r) * rx).toFixed(4)},${(cy + Math.sin(r) * ry).toFixed(4)}`);
  }
  return pts.join(' ');
}

presetShapes.set('leftBrace', (w, h, adjustments) => {
  const ss = Math.min(w, h);
  const a2 = Math.max(0, Math.min(adjustments?.get('adj2') ?? 50000, 100000));
  const q1 = 100000 - a2;
  const q2 = Math.min(q1, a2);
  const q3 = q2 / 2;
  const maxAdj1 = ss > 0 ? (q3 * h) / ss : 0;
  const a1 = Math.max(0, Math.min(adjustments?.get('adj1') ?? 8333, maxAdj1));
  const y1 = (ss * a1) / 100000;
  const y3 = (h * a2) / 100000;
  const y2 = y3 - y1;
  const y4 = y3 + y1;
  const hc = w / 2;
  return [
    `M${w},${h}`,
    braceArcPoly(w, h - y1, hc, y1, 90, 180),
    `L${hc},${y4}`,
    braceArcPoly(0, y4, hc, y1, 0, -90),
    braceArcPoly(0, y2, hc, y1, 90, 0),
    `L${hc},${y1}`,
    braceArcPoly(w, y1, hc, y1, 180, 270),
  ].join(' ');
});

presetShapes.set('rightBrace', (w, h, adjustments) => {
  const ss = Math.min(w, h);
  const a2 = Math.max(0, Math.min(adjustments?.get('adj2') ?? 50000, 100000));
  const q1 = 100000 - a2;
  const q2 = Math.min(q1, a2);
  const q3 = q2 / 2;
  const maxAdj1 = ss > 0 ? (q3 * h) / ss : 0;
  const a1 = Math.max(0, Math.min(adjustments?.get('adj1') ?? 8333, maxAdj1));
  const y1 = (ss * a1) / 100000;
  const y3 = (h * a2) / 100000;
  const y2 = y3 - y1;
  const y4 = h - y1;
  const hc = w / 2;
  return [
    `M0,0`,
    braceArcPoly(0, y1, hc, y1, 270, 360),
    `L${hc},${y2}`,
    braceArcPoly(w, y2, hc, y1, 180, 90),
    braceArcPoly(w, y3 + y1, hc, y1, 270, 180),
    `L${hc},${y4}`,
    braceArcPoly(0, y4, hc, y1, 0, 90),
  ].join(' ');
});

// ===== Action Buttons =====
// Action buttons are multi-path shapes: background rect + icon with darken fill + icon outline + rect outline.
// OOXML spec uses ss*3/8 as the icon half-size (dx2), with the icon centred at (hc, vc).
// Shapes with multiPathPresets entries below get proper 3D treatment. Remaining shapes
// fall back to the legacy actionButtonIcons overlay (single flat icon path).

presetShapes.set('actionButtonBlank', (w, h) => `M0,0 L${w},0 L${w},${h} L0,${h} Z`);

// Fallback rectangle for action buttons without multiPathPresets entry yet
// actionButtonSound fallback removed — uses multiPathPresets entry below

// Multi-path action button presets are registered after the multiPathPresets Map
// declaration (see below in the multiPathPresets section).

// ---------------------------------------------------------------------------
// Action button icon paths (rendered as a second <path> with contrasting fill)
// ---------------------------------------------------------------------------
const actionButtonIcons = new Map<string, (w: number, h: number) => string>();

// actionButtonHome icon removed — uses multiPathPresets entry below

actionButtonIcons.set('actionButtonForwardNext', (w, h) => {
  // Right-pointing triangle (▶)
  const cx = w / 2,
    cy = h / 2,
    s = Math.min(w, h) * 0.3;
  return `M${cx - s * 0.5},${cy - s} L${cx + s},${cy} L${cx - s * 0.5},${cy + s} Z`;
});

actionButtonIcons.set('actionButtonBackPrevious', (w, h) => {
  // Left-pointing triangle (◀)
  const cx = w / 2,
    cy = h / 2,
    s = Math.min(w, h) * 0.3;
  return `M${cx + s * 0.5},${cy - s} L${cx - s},${cy} L${cx + s * 0.5},${cy + s} Z`;
});

actionButtonIcons.set('actionButtonReturn', (w, h) => {
  // Curved return arrow (↩) — shaft goes right at bottom, curves UP at right end,
  // returns left at top with arrowhead pointing left (standard PowerPoint icon).
  const cx = w / 2,
    cy = h / 2,
    s = Math.min(w, h) * 0.28;
  const thick = s * 0.22; // shaft thickness
  const bottomY = cy + s * 0.4;
  const topY = cy - s * 0.4;
  const leftX = cx - s * 0.6;
  const rightX = cx + s * 0.6;
  const r = (bottomY - topY) / 2; // semicircle radius
  return [
    // Outer edge: bottom-left → right → arc up → left to arrowhead junction
    `M${leftX},${bottomY}`,
    `L${rightX},${bottomY}`,
    `A${r},${r} 0 0,1 ${rightX},${topY}`,
    `L${leftX + s * 0.15},${topY}`,
    // Inner edge: top → right → arc down → bottom-left
    `L${leftX + s * 0.15},${topY + thick}`,
    `L${rightX - thick * 0.3},${topY + thick}`,
    `A${r - thick},${r - thick} 0 0,0 ${rightX - thick * 0.3},${bottomY - thick}`,
    `L${leftX},${bottomY - thick}`,
    `Z`,
    // Arrowhead pointing left at top-left
    `M${leftX - s * 0.3},${topY + thick / 2}`,
    `L${leftX + s * 0.15},${topY - s * 0.2}`,
    `L${leftX + s * 0.15},${topY + thick + s * 0.2}`,
    `Z`,
  ].join(' ');
});

actionButtonIcons.set('actionButtonBeginning', (w, h) => {
  // Skip-to-beginning (|◀)
  const cx = w / 2,
    cy = h / 2,
    s = Math.min(w, h) * 0.28;
  return [
    // Left bar
    `M${cx - s},${cy - s} L${cx - s + s * 0.2},${cy - s} L${cx - s + s * 0.2},${cy + s} L${cx - s},${cy + s} Z`,
    // Left-pointing triangle
    `M${cx + s},${cy - s} L${cx - s + s * 0.35},${cy} L${cx + s},${cy + s} Z`,
  ].join(' ');
});

actionButtonIcons.set('actionButtonEnd', (w, h) => {
  // Skip-to-end (▶|)
  const cx = w / 2,
    cy = h / 2,
    s = Math.min(w, h) * 0.28;
  return [
    // Right bar
    `M${cx + s - s * 0.2},${cy - s} L${cx + s},${cy - s} L${cx + s},${cy + s} L${cx + s - s * 0.2},${cy + s} Z`,
    // Right-pointing triangle
    `M${cx - s},${cy - s} L${cx + s - s * 0.35},${cy} L${cx - s},${cy + s} Z`,
  ].join(' ');
});

// actionButtonHelp icon removed — uses multiPathPresets entry below

actionButtonIcons.set('actionButtonInformation', (w, h) => {
  // Info icon (i)
  const cx = w / 2,
    cy = h / 2,
    s = Math.min(w, h) * 0.28;
  return [
    // Dot
    `M${cx - s * 0.1},${cy - s * 0.65} L${cx + s * 0.1},${cy - s * 0.65} L${cx + s * 0.1},${cy - s * 0.4} L${cx - s * 0.1},${cy - s * 0.4} Z`,
    // Stem
    `M${cx - s * 0.12},${cy - s * 0.2} L${cx + s * 0.12},${cy - s * 0.2} L${cx + s * 0.12},${cy + s * 0.65} L${cx - s * 0.12},${cy + s * 0.65} Z`,
  ].join(' ');
});

actionButtonIcons.set('actionButtonDocument', (w, h) => {
  // Document with folded corner
  const cx = w / 2,
    cy = h / 2,
    s = Math.min(w, h) * 0.28;
  const dx = s * 0.7,
    dy = s,
    fold = s * 0.3;
  return [
    `M${cx - dx},${cy - dy}`,
    `L${cx + dx - fold},${cy - dy} L${cx + dx},${cy - dy + fold}`,
    `L${cx + dx},${cy + dy} L${cx - dx},${cy + dy} Z`,
    `M${cx + dx - fold},${cy - dy} L${cx + dx - fold},${cy - dy + fold} L${cx + dx},${cy - dy + fold}`,
  ].join(' ');
});

// actionButtonSound icon removed — uses multiPathPresets entry below

// actionButtonMovie icon is now rendered via multiPathPresets (see below).

/**
 * Get the SVG path for the icon overlay of an action button.
 * Returns undefined if the shape is not an action button or is actionButtonBlank.
 */
export function getActionButtonIconPath(
  shapeType: string,
  w: number,
  h: number,
): string | undefined {
  const key = shapeType.toLowerCase();
  const generator = actionButtonIcons.get(key) ?? actionButtonIcons.get(shapeType);
  return generator?.(w, h);
}

// ===== Aliases and common alternative names =====

// Some shapes are known by multiple names in different OOXML versions
// flowChartOfflineStorage: registered as multiPathPreset (see below)

// ribbon is implemented as multiPathPreset (see multiPathPresets below)

presetShapes.set('wave', (w, h, adjustments) => {
  // OOXML: adj1=12500 (max 20000), adj2=0 (phase shift, range -10000..10000)
  const a1 = Math.min(Math.max(adjRaw(adjustments, 'adj1', 12500), 0), 20000);
  const a2 = Math.min(Math.max(adjRaw(adjustments, 'adj2', 0), -10000), 10000);
  const y1 = (h * a1) / 100000;
  const dy2 = (y1 * 10) / 3;
  const y2 = y1 - dy2; // control above crest
  const y3 = y1 + dy2; // control below crest
  const y4 = h - y1; // bottom wave y
  const y5 = y4 - dy2;
  const y6 = y4 + dy2;
  // Phase shift
  const of2 = (w * a2) / 50000;
  const dx2 = of2 < 0 ? 0 : of2;
  const dx5 = of2 < 0 ? of2 : 0;
  const x2 = -dx2;
  const x5 = w - dx5;
  const dx3 = (x5 - x2) / 3;
  const x3 = x2 + dx3;
  const x4 = (x3 + x5) / 2;
  const x6 = dx5;
  const x10 = w + dx2;
  const x7 = x6 + (x10 - x6) / 3;
  const x8 = (x7 + x10) / 2;
  return [
    `M${x2},${y1}`,
    `C${x3},${y2} ${x4},${y3} ${x5},${y1}`,
    `L${x10},${y4}`,
    `C${x8},${y6} ${x7},${y5} ${x6},${y4}`,
    'Z',
  ].join(' ');
});

presetShapes.set('doubleWave', (w, h, adjustments) => {
  // OOXML: adj1=6250 (max 12500), adj2=0 (phase shift)
  const a1 = Math.min(Math.max(adjRaw(adjustments, 'adj1', 6250), 0), 12500);
  const a2 = Math.min(Math.max(adjRaw(adjustments, 'adj2', 0), -10000), 10000);
  const y1 = (h * a1) / 100000;
  const dy2 = (y1 * 10) / 3;
  const y2 = y1 - dy2;
  const y3 = y1 + dy2;
  const y4 = h - y1;
  const y5 = y4 - dy2;
  const y6 = y4 + dy2;
  const of2 = (w * a2) / 50000;
  const dx2 = of2 < 0 ? 0 : of2;
  const dx8 = of2 < 0 ? of2 : 0;
  const x2 = -dx2;
  const x8 = w - dx8;
  const dx3 = (x8 - x2) / 6;
  const x3 = x2 + dx3;
  const dx4 = (x8 - x2) / 3;
  const x4 = x2 + dx4;
  const x5 = (x2 + x8) / 2;
  const x6 = x5 + dx3;
  const x7 = (x6 + x8) / 2;
  const x9 = dx8;
  const x15 = w + dx2;
  const dx3b = (x15 - x9) / 6;
  const x10 = x9 + dx3b;
  const x11 = x9 + (x15 - x9) / 3;
  const x12 = (x9 + x15) / 2;
  const x13 = x12 + dx3b;
  const x14 = (x13 + x15) / 2;
  return [
    `M${x2},${y1}`,
    `C${x3},${y2} ${x4},${y3} ${x5},${y1}`,
    `C${x6},${y2} ${x7},${y3} ${x8},${y1}`,
    `L${x15},${y4}`,
    `C${x14},${y6} ${x13},${y5} ${x12},${y4}`,
    `C${x11},${y6} ${x10},${y5} ${x9},${y4}`,
    'Z',
  ].join(' ');
});

// verticalScroll and horizontalScroll are implemented as multi-path presets
// (see multiPathPresets below) for accurate OOXML rendering with darkenLess shadows.

presetShapes.set('irregularSeal1', (w, h) => {
  // OOXML spec: exact coordinates on 21600x21600 grid
  const sx = (x: number) => (w * x) / 21600;
  const sy = (y: number) => (h * y) / 21600;
  return [
    `M${sx(10800)},${sy(5800)}`,
    `L${sx(14522)},0`,
    `L${sx(14155)},${sy(5325)}`,
    `L${sx(18380)},${sy(4457)}`,
    `L${sx(16702)},${sy(7315)}`,
    `L${sx(21097)},${sy(8137)}`,
    `L${sx(17607)},${sy(10475)}`,
    `L${sx(21600)},${sy(13290)}`,
    `L${sx(16837)},${sy(12942)}`,
    `L${sx(18145)},${sy(18095)}`,
    `L${sx(14020)},${sy(14457)}`,
    `L${sx(13247)},${sy(19737)}`,
    `L${sx(10532)},${sy(14935)}`,
    `L${sx(8485)},${sy(21600)}`,
    `L${sx(7715)},${sy(15627)}`,
    `L${sx(4762)},${sy(17617)}`,
    `L${sx(5667)},${sy(13937)}`,
    `L${sx(135)},${sy(14587)}`,
    `L${sx(3722)},${sy(11775)}`,
    `L0,${sy(8615)}`,
    `L${sx(4627)},${sy(7617)}`,
    `L${sx(370)},${sy(2295)}`,
    `L${sx(7312)},${sy(6320)}`,
    `L${sx(8352)},${sy(2295)}`,
    'Z',
  ].join(' ');
});

presetShapes.set('irregularSeal2', (w, h) => {
  // Office-like irregularSeal2 coordinates (21600 design grid).
  return [
    `M${(w * 11462) / 21600},${(h * 4342) / 21600}`,
    `L${(w * 14790) / 21600},0`,
    `L${(w * 14525) / 21600},${(h * 5777) / 21600}`,
    `L${(w * 18007) / 21600},${(h * 3172) / 21600}`,
    `L${(w * 16380) / 21600},${(h * 6532) / 21600}`,
    `L${w},${(h * 6645) / 21600}`,
    `L${(w * 16985) / 21600},${(h * 9402) / 21600}`,
    `L${(w * 18270) / 21600},${(h * 11290) / 21600}`,
    `L${(w * 16380) / 21600},${(h * 12310) / 21600}`,
    `L${(w * 18877) / 21600},${(h * 15632) / 21600}`,
    `L${(w * 14640) / 21600},${(h * 14350) / 21600}`,
    `L${(w * 14942) / 21600},${(h * 17370) / 21600}`,
    `L${(w * 12180) / 21600},${(h * 15935) / 21600}`,
    `L${(w * 11612) / 21600},${(h * 18842) / 21600}`,
    `L${(w * 9872) / 21600},${(h * 17370) / 21600}`,
    `L${(w * 8700) / 21600},${(h * 19712) / 21600}`,
    `L${(w * 7527) / 21600},${(h * 18125) / 21600}`,
    `L${(w * 4917) / 21600},${h}`,
    `L${(w * 4805) / 21600},${(h * 18240) / 21600}`,
    `L${(w * 1285) / 21600},${(h * 17825) / 21600}`,
    `L${(w * 3330) / 21600},${(h * 15370) / 21600}`,
    `L0,${(h * 12877) / 21600}`,
    `L${(w * 3935) / 21600},${(h * 11592) / 21600}`,
    `L${(w * 1172) / 21600},${(h * 8270) / 21600}`,
    `L${(w * 5372) / 21600},${(h * 7817) / 21600}`,
    `L${(w * 4502) / 21600},${(h * 3625) / 21600}`,
    `L${(w * 8550) / 21600},${(h * 6382) / 21600}`,
    `L${(w * 9722) / 21600},${(h * 1887) / 21600}`,
    'Z',
  ].join(' ');
});

presetShapes.set('teardrop', (w, h) => {
  const rx = w / 2;
  const ry = h / 2;
  return [`M${w},${ry}`, `A${rx},${ry} 0 1,1 ${rx},0`, `L${w},0`, `L${w},${ry}`, 'Z'].join(' ');
});

presetShapes.set('pie', (w, h, adjustments) => {
  // OOXML pie: adj1 = start angle, adj2 = end angle (60000ths of a degree). Sweep clockwise from start to end.
  // OOXML angles are "visual" (geometric) — must convert to parametric for ellipses (rx≠ry).
  const adj1Raw = adjustments?.get('adj1') ?? 0;
  const adj2Raw = adjustments?.get('adj2') ?? 16200000; // 270° end default
  const startDeg = (adj1Raw / 60000) % 360;
  const endDeg = (adj2Raw / 60000) % 360;
  let sweepDeg = (((endDeg - startDeg) % 360) + 360) % 360;
  if (sweepDeg === 0 && startDeg !== endDeg) sweepDeg = 360;
  const rx = w / 2;
  const ry = h / 2;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const visualToParam = (deg: number) =>
    Math.atan2(Math.sin(toRad(deg)) / ry, Math.cos(toRad(deg)) / rx);
  const startParam = visualToParam(startDeg);
  const endParam = visualToParam(endDeg);
  const x1 = rx + rx * Math.cos(startParam);
  const y1 = ry + ry * Math.sin(startParam);
  const x2 = rx + rx * Math.cos(endParam);
  const y2 = ry + ry * Math.sin(endParam);
  const largeArc = sweepDeg > 180 ? 1 : 0;
  return [`M${rx},${ry}`, `L${x1},${y1}`, `A${rx},${ry} 0 ${largeArc},1 ${x2},${y2}`, 'Z'].join(
    ' ',
  );
});

presetShapes.set('pieWedge', (w, h) => {
  // OOXML: Quarter-ellipse pie wedge. Center at (w, h), radii = (w, h).
  // Arc from 180° sweeping 90° CW: starts at (0, h), ends at (w, 0).
  // The arc bulges toward the upper-left.
  return [`M0,${h}`, `A${w},${h} 0 0,1 ${w},0`, `L${w},${h}`, 'Z'].join(' ');
});

presetShapes.set('arc', (w, h, adjustments) => {
  // OOXML arc: adj1/adj2 are angles in 60000ths of a degree
  // OOXML angles are "visual" (geometric) — must convert to parametric for ellipses (rx≠ry).
  const adj1Raw = adjustments?.get('adj1') ?? 16200000; // default 270°
  const adj2Raw = adjustments?.get('adj2') ?? 0; // default 0°
  const startDeg = adj1Raw / 60000;
  const endDeg = adj2Raw / 60000;
  const rx = w / 2;
  const ry = h / 2;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const visualToParam = (deg: number) =>
    Math.atan2(Math.sin(toRad(deg)) / ry, Math.cos(toRad(deg)) / rx);
  const startParam = visualToParam(startDeg);
  const endParam = visualToParam(endDeg);
  const x1 = rx + rx * Math.cos(startParam);
  const y1 = ry + ry * Math.sin(startParam);
  const x2 = rx + rx * Math.cos(endParam);
  const y2 = ry + ry * Math.sin(endParam);
  let sweepDeg = (((endDeg - startDeg) % 360) + 360) % 360;
  if (sweepDeg === 0 && startDeg !== endDeg) sweepDeg = 360;
  const largeArc = sweepDeg > 180 ? 1 : 0;
  return `M${x1},${y1} A${rx},${ry} 0 ${largeArc},1 ${x2},${y2}`;
});

presetShapes.set('chord', (w, h, adjustments) => {
  // OOXML chord: arc + chord line. Spec uses ellipse (arcTo wR="wd2" hR="hd2") per presetShapeDefinitions.
  // OOXML angles are "visual" (geometric) angles — the angle of the ray from center to the point.
  // For ellipses (rx≠ry), convert to parametric angle: t = atan2(sin(θ)/ry, cos(θ)/rx)
  const adj1Raw = adjustments?.get('adj1') ?? 2700000; // default 45°
  const adj2Raw = adjustments?.get('adj2') ?? 16200000; // default 270°
  const startDeg = adj1Raw / 60000;
  const endDeg = adj2Raw / 60000;
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const toRad = (d: number) => (d * Math.PI) / 180;
  // Convert OOXML visual angles to parametric angles on the ellipse
  const visualToParam = (deg: number) =>
    Math.atan2(Math.sin(toRad(deg)) / ry, Math.cos(toRad(deg)) / rx);
  const startParam = visualToParam(startDeg);
  const endParam = visualToParam(endDeg);
  const x1 = cx + rx * Math.cos(startParam);
  const y1 = cy + ry * Math.sin(startParam);
  const x2 = cx + rx * Math.cos(endParam);
  const y2 = cy + ry * Math.sin(endParam);
  // Use OOXML visual sweep to determine large-arc-flag
  let sweepDeg = (((endDeg - startDeg) % 360) + 360) % 360;
  if (sweepDeg === 0 && startDeg !== endDeg) sweepDeg = 360;
  // When adj1 == adj2, the chord covers the full ellipse (360° sweep)
  if (sweepDeg === 0) {
    return `M${cx - rx},${cy} A${rx},${ry} 0 1,1 ${cx + rx},${cy} A${rx},${ry} 0 1,1 ${cx - rx},${cy} Z`;
  }
  const largeArc = sweepDeg > 180 ? 1 : 0;
  return `M${x1},${y1} A${rx},${ry} 0 ${largeArc},1 ${x2},${y2} Z`;
});

presetShapes.set('funnel', (w, h) => {
  // OOXML funnel: top rim ellipse arc + tapered sides + bottom spout arc + inset top ellipse.
  // From presetShapeDefinitions.xml (ECMA-376).
  const ss = Math.min(w, h);
  const wd2 = w / 2;
  const hd4 = h / 4;
  const hc = w / 2;
  const b = h;

  const d = ss / 20; // inset margin
  const rw2 = wd2 - d; // inset top-ellipse x-radius
  const rh2 = hd4 - d; // inset top-ellipse y-radius

  // Angle (in radians) where funnel sides are tangent to top ellipse.
  // OOXML: t1 = cos(wd2, 480000), t2 = sin(hd4, 480000) → da = atan2(t1, t2)
  // 480000 = 8° in 60000ths of a degree
  const ang8 = (8 * Math.PI) / 180;
  const t1 = wd2 * Math.cos(ang8);
  const t2 = hd4 * Math.sin(ang8);
  const da = Math.atan2(t2, t1); // radians

  // Angles for the top rim arc (OOXML convention: sweep from stAng1 by swAng1)
  const stAng1 = Math.PI - da; // cd2 - da
  const swAng1 = Math.PI + 2 * da; // cd2 + 2*da

  // Sweep for the bottom spout arc
  const swAng3 = Math.PI - 2 * da; // cd2 - 2*da

  // Bottom spout ellipse radii: 1/4 of top ellipse
  const rw3 = wd2 / 4;
  const rh3 = hd4 / 4;

  // Start point on top ellipse at stAng1 (visual angle → ellipse point)
  // OOXML uses: n = (wR*hR) / mod(cos(hR,ang), sin(wR,ang), 0), then x = hc + cos(n,ang), y = hd4 + sin(n,ang)
  // This is equivalent to the parametric ellipse point at the "visual" angle.
  const ct1 = hd4 * Math.cos(stAng1);
  const st1 = wd2 * Math.sin(stAng1);
  const m1 = Math.sqrt(ct1 * ct1 + st1 * st1);
  const n1 = (wd2 * hd4) / m1;
  const dx1 = n1 * Math.cos(stAng1);
  const dy1 = n1 * Math.sin(stAng1);
  const x1 = hc + dx1;
  const y1 = hd4 + dy1;

  // End point of top arc (at stAng1 + swAng1 = pi + da)
  const endAng1 = stAng1 + swAng1;
  const ct1e = hd4 * Math.cos(endAng1);
  const st1e = wd2 * Math.sin(endAng1);
  const m1e = Math.sqrt(ct1e * ct1e + st1e * st1e);
  const n1e = (wd2 * hd4) / m1e;
  const dx1e = n1e * Math.cos(endAng1);
  const dy1e = n1e * Math.sin(endAng1);
  const x1e = hc + dx1e;
  const y1e = hd4 + dy1e;

  // Point on spout ellipse at angle da
  const vc3 = b - rh3; // vertical center of spout ellipse
  const ct3 = rh3 * Math.cos(da);
  const st3 = rw3 * Math.sin(da);
  const m3 = Math.sqrt(ct3 * ct3 + st3 * st3);
  const n3 = (rw3 * rh3) / m3;
  const dx3 = n3 * Math.cos(da);
  const dy3 = n3 * Math.sin(da);
  const x3 = hc + dx3;
  const y2 = vc3 + dy3;

  // End point of spout arc (at da + swAng3)
  const endAng3 = da + swAng3;
  const ct3e = rh3 * Math.cos(endAng3);
  const st3e = rw3 * Math.sin(endAng3);
  const m3e = Math.sqrt(ct3e * ct3e + st3e * st3e);
  const n3e = (rw3 * rh3) / m3e;
  const dx3e = n3e * Math.cos(endAng3);
  const dy3e = n3e * Math.sin(endAng3);
  const x3e = hc + dx3e;
  const y2e = vc3 + dy3e;

  // Determine arc flags
  const swDeg1 = (swAng1 * 180) / Math.PI;
  const largeArc1 = Math.abs(swDeg1) > 180 ? 1 : 0;
  const sweep1 = swAng1 > 0 ? 1 : 0;

  const swDeg3 = (swAng3 * 180) / Math.PI;
  const largeArc3 = Math.abs(swDeg3) > 180 ? 1 : 0;
  const sweep3 = swAng3 > 0 ? 1 : 0;

  // Sub-path 1: Funnel body (top arc → line to spout → spout arc → close)
  const body = [
    `M${x1},${y1}`,
    `A${wd2},${hd4} 0 ${largeArc1},${sweep1} ${x1e},${y1e}`,
    `L${x3},${y2}`,
    `A${rw3},${rh3} 0 ${largeArc3},${sweep3} ${x3e},${y2e}`,
    'Z',
  ].join(' ');

  // Sub-path 2: Inset top ellipse (full ellipse, counter-clockwise for even-odd hole)
  const x2 = wd2 - rw2; // leftmost point of inset ellipse
  const x2r = wd2 + rw2; // rightmost point
  const inset = [
    `M${x2},${hd4}`,
    `A${rw2},${rh2} 0 1,0 ${x2r},${hd4}`,
    `A${rw2},${rh2} 0 1,0 ${x2},${hd4}`,
    'Z',
  ].join(' ');

  return `${body} ${inset}`;
});

// ===== Fallback =====

/**
 * Get the SVG path for a preset shape, falling back to a simple rectangle
 * if the shape type is not implemented.
 */
// ---------------------------------------------------------------------------
// Preset shape overlays — additional paths for 3D-like shapes (lighter top face, etc.)
// ---------------------------------------------------------------------------

export interface PresetOverlay {
  /** SVG path d-attribute for the overlay */
  path: string;
  /** Fill modifier: 'lighten' brightens the base fill */
  fillModifier: 'lighten';
}

export type PresetOverlayGenerator = (
  w: number,
  h: number,
  adjustments?: Map<string, number>,
) => PresetOverlay[];

const presetOverlays: Map<string, PresetOverlayGenerator> = new Map();

presetOverlays.set('can', (w, h) => {
  const ry = h * 0.1;
  const rx = w / 2;
  return [
    {
      path: [`M0,${ry}`, `A${rx},${ry} 0 0,1 ${w},${ry}`, `A${rx},${ry} 0 0,1 0,${ry}`, 'Z'].join(
        ' ',
      ),
      fillModifier: 'lighten',
    },
  ];
});

/**
 * Get overlay paths for a preset shape (3D top faces, etc.).
 * Returns empty array if the shape has no overlays.
 */
export function getPresetOverlays(
  shapeType: string,
  w: number,
  h: number,
  adjustments?: Map<string, number>,
): PresetOverlay[] {
  const key = shapeType.toLowerCase();
  const gen = presetOverlays.get(key) ?? presetOverlays.get(shapeType);
  return gen ? gen(w, h, adjustments) : [];
}

// ---------------------------------------------------------------------------
// Multi-path preset shapes — complex shapes with multiple SVG paths
// Each path has its own fill modifier and stroke behavior, matching OOXML spec.
// ---------------------------------------------------------------------------

/** A single sub-path within a multi-path preset shape. */
export interface PresetSubPath {
  /** SVG path d-attribute string */
  d: string;
  /**
   * Fill behavior:
   * - 'norm': use the shape's normal fill
   * - 'darken': darken the base fill (multiply with ~60% gray)
   * - 'darkenLess': slightly darken (multiply with ~80% gray)
   * - 'lighten': lighten the base fill
   * - 'lightenLess': slightly lighten
   * - 'none': no fill (stroke-only detail lines)
   */
  fill: 'norm' | 'darken' | 'darkenLess' | 'lighten' | 'lightenLess' | 'none';
  /** Whether this path should have a stroke (default true) */
  stroke: boolean;
  /** Optional stroke width multiplier for detail lines that should render lighter than the outline. */
  strokeWidthScale?: number;
  /** Restrict visibility of this detail path to a stroke band around the main outline path. */
  maskToMainOutline?: boolean;
  /** Optional scale for the outline-band mask stroke width. */
  maskStrokeScale?: number;
  /** Restrict visibility of this detail path to the band between the main outline and an inset-scaled outline. */
  maskToMainOutlineBandScale?: number;
}

type MultiPathPresetGenerator = (
  w: number,
  h: number,
  adjustments?: Map<string, number>,
) => PresetSubPath[];

const multiPathPresets: Map<string, MultiPathPresetGenerator> = new Map();

// ===== Action Button multi-path presets (OOXML spec-accurate) =====
// Common helper: OOXML action button guide values
function _abGuides(w: number, h: number) {
  const ss = Math.min(w, h);
  const hc = w / 2,
    vc = h / 2;
  const dx2 = (ss * 3) / 8; // icon half-extent
  return {
    ss,
    hc,
    vc,
    dx2,
    g9: vc - dx2,
    g10: vc + dx2,
    g11: hc - dx2,
    g12: hc + dx2,
    g13: (ss * 3) / 4,
  };
}
const _rect = (w: number, h: number) => `M0,0 L${w},0 L${w},${h} L0,${h} Z`;

// actionButtonForwardNext (VBA 0130): right-pointing triangle ▶
multiPathPresets.set('actionButtonForwardNext', (w, h) => {
  const { g9, g10, g11, g12, vc } = _abGuides(w, h);
  const tri = `M${g12},${vc} L${g11},${g9} L${g11},${g10} Z`;
  return [
    { d: `${_rect(w, h)} ${tri}`, fill: 'norm', stroke: false },
    { d: tri, fill: 'darken', stroke: false },
    { d: tri, fill: 'none', stroke: true },
    { d: _rect(w, h), fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('actionButtonForward', (w, h) => {
  const forwardNext = multiPathPresets.get('actionButtonForwardNext');
  return forwardNext ? forwardNext(w, h) : [];
});

// actionButtonBackPrevious (VBA 0129): left-pointing triangle ◀
multiPathPresets.set('actionButtonBackPrevious', (w, h) => {
  const { g9, g10, g11, g12, vc } = _abGuides(w, h);
  const tri = `M${g11},${vc} L${g12},${g9} L${g12},${g10} Z`;
  return [
    { d: `${_rect(w, h)} ${tri}`, fill: 'norm', stroke: false },
    { d: tri, fill: 'darken', stroke: false },
    { d: tri, fill: 'none', stroke: true },
    { d: _rect(w, h), fill: 'none', stroke: true },
  ];
});

// actionButtonBeginning (VBA 0131): |◀ skip-to-start
multiPathPresets.set('actionButtonBeginning', (w, h) => {
  const { g9, g10, g11, g12, g13, vc } = _abGuides(w, h);
  const g14 = g13 / 8,
    g15 = g13 / 4;
  const g16 = g11 + g14,
    g17 = g11 + g15;
  const tri = `M${g17},${vc} L${g12},${g9} L${g12},${g10} Z`;
  const bar = `M${g16},${g9} L${g11},${g9} L${g11},${g10} L${g16},${g10} Z`;
  const icon = `${tri} ${bar}`;
  return [
    { d: `${_rect(w, h)} ${icon}`, fill: 'norm', stroke: false },
    { d: icon, fill: 'darken', stroke: false },
    { d: icon, fill: 'none', stroke: true },
    { d: _rect(w, h), fill: 'none', stroke: true },
  ];
});

// actionButtonEnd (VBA 0132): ▶| skip-to-end
multiPathPresets.set('actionButtonEnd', (w, h) => {
  const { g9, g10, g11, g12, g13, vc } = _abGuides(w, h);
  const g14 = (g13 * 3) / 4,
    g15 = (g13 * 7) / 8;
  const g16 = g11 + g14,
    g17 = g11 + g15;
  const tri = `M${g16},${vc} L${g11},${g9} L${g11},${g10} Z`;
  const bar = `M${g17},${g9} L${g12},${g9} L${g12},${g10} L${g17},${g10} Z`;
  const icon = `${tri} ${bar}`;
  return [
    { d: `${_rect(w, h)} ${icon}`, fill: 'norm', stroke: false },
    { d: icon, fill: 'darken', stroke: false },
    { d: icon, fill: 'none', stroke: true },
    { d: _rect(w, h), fill: 'none', stroke: true },
  ];
});

// actionButtonReturn (VBA 0133): curved return arrow ↩
// OOXML spec: 4 paths – bg+icon cutout (norm), icon fill (darken), icon outline (stroke), rect outline (stroke)
// Fill paths use inner arcs curving inward; outline path traces the full shape with reversed arc winding.
multiPathPresets.set('actionButtonReturn', (w, h) => {
  const { g9, g10, g11, g12, g13, hc, vc: _vcR } = _abGuides(w, h);
  const g14 = (g13 * 7) / 8;
  const g15 = (g13 * 3) / 4;
  const g16 = (g13 * 5) / 8;
  const g17 = (g13 * 3) / 8; // outer arc radius
  const g18 = g13 / 4;
  const g27 = g13 / 8; // inner arc radius
  const g19 = g9 + g15;
  const g20 = g9 + g16;
  const g21 = g9 + g18;
  const g22 = g11 + g14;
  const g23 = g11 + g15;
  const g24 = g11 + g16;
  const g25 = g11 + g17;
  const g26 = g11 + g18;

  // Fill icon path (paths 0 & 1 in OOXML spec — identical geometry)
  // Arc 1: from (g24, g20), wR=g27 hR=g27 stAng=0° swAng=90°
  //   center = (g24-g27, g20), endpoint = (g24-g27, g20+g27) = (g24-g27, g19)
  // Arc 2: from (g25, g19), wR=g27 hR=g27 stAng=90° swAng=90°
  //   center = (g25, g19-g27), endpoint = (g25-g27, g19-g27) = (g26, g20)
  // Arc 3: from (g11, g20), wR=g17 hR=g17 stAng=180° swAng=-90°
  //   center = (g11+g17, g20) = (g25, g20), endpoint = (g25, g20+g17) = (g25, g10)
  // Arc 4: from (hc, g10), wR=g17 hR=g17 stAng=90° swAng=-90°
  //   center = (hc, g10-g17), endpoint = (hc+g17, g10-g17)
  const fillIcon = [
    `M${g12},${g21}`,
    `L${g23},${g9}`,
    `L${hc},${g21}`,
    `L${g24},${g21}`,
    `L${g24},${g20}`,
    `A${g27},${g27} 0 0,1 ${g24 - g27},${g19}`, // arc 1: inner bottom-right corner
    `L${g25},${g19}`, // across inner bottom
    `A${g27},${g27} 0 0,1 ${g26},${g20}`, // arc 2: inner bottom-left corner
    `L${g26},${g21}`,
    `L${g11},${g21}`,
    `L${g11},${g20}`,
    `A${g17},${g17} 0 0,0 ${g25},${g10}`, // arc 3: outer bottom-left curve
    `L${hc},${g10}`, // across outer bottom
    `A${g17},${g17} 0 0,0 ${hc + g17},${g10 - g17}`, // arc 4: outer bottom-right curve
    `L${g22},${g21}`,
    `Z`,
  ].join(' ');

  // Outline path (path 2 in OOXML spec — traces shape with different arc winding)
  // Starts from right outer edge, traces clockwise: outer right → outer bottom → outer left → inner left → inner bottom → inner right → arrow
  // Arc A: from (g22, g20), wR=g17 hR=g17 stAng=0° swAng=90°
  //   center = (g22-g17, g20) = (g22-g17, g20), endpoint = (g22-g17, g20+g17)
  //   g22-g17 = g11+g14-g17 = g11 + g13*7/8 - g13*3/8 = g11 + g13/2 = g25 + g13/8 = hc? No.
  //   Actually: g22 = g11+g14, g14 = g13*7/8, g17 = g13*3/8
  //   g22 - g17 = g11 + g13*7/8 - g13*3/8 = g11 + g13*4/8 = g11 + g13/2 = hc (since hc = g11 + dx2 = g11 + g13/2)
  //   Hmm wait, dx2 = ss*3/8 and g13 = ss*3/4. So g13/2 = ss*3/8 = dx2. So hc = g11 + dx2 = g11 + g13/2. Yes!
  //   endpoint = (hc, g20+g17) = (hc, g10)? g20+g17 = (g9+g16)+g17 = g9+g13*5/8+g13*3/8 = g9+g13 = g9+ss*3/4
  //   g10 = vc+dx2. g9+g13 = (vc-dx2) + 2*dx2 = vc+dx2 = g10. Yes! endpoint = (hc, g10) ✓ but wait...
  //   Actually stAng=0° means start angle is 0°. center = (g22 - g17*cos(0), g20 - g17*sin(0)) = (g22-g17, g20).
  //   endAng = 0+90 = 90°. endX = center.x + g17*cos(90°) = g22-g17. endY = center.y + g17*sin(90°) = g20+g17.
  //   So endpoint = (g22-g17, g20+g17). Let's verify: g22-g17 = g11+g14-g17 = g11+g13*(7/8-3/8) = g11+g13/2 = g25+g13/8
  //   Hmm, g25 = g11+g17 = g11+g13*3/8. g11+g13/2 = g11+g13*4/8. That's not g25, it's g25 + g13/8.
  //   Actually let me just compute: g11+g13/2. g13/2 is not one of the named guides.
  //   OK, the spec says after this arc: lnTo (g25, g10). So endpoint.x must be something, then line to g25.
  //   endpoint.x = g22-g17 = g11+g14-g17 = g11+g13*7/8-g13*3/8 = g11+g13*4/8 = g11+g13/2.
  //   Then lnTo (g25, g10) where g25 = g11+g13*3/8.
  //   endpointY = g20+g17 = g10. So endpoint = (g11+g13/2, g10).
  //   Line from there to (g25, g10) is horizontal. Makes sense.
  // Arc B: from (g25, g10), wR=g17 hR=g17 stAng=90° swAng=90°
  //   center = (g25, g10-g17), endAng=180°
  //   endX = g25+g17*cos(180°) = g25-g17 = g11+g17-g17 = g11
  //   endY = (g10-g17)+g17*sin(180°) = g10-g17 = g20
  //   endpoint = (g11, g20). Then lnTo (g11, g21).
  // Arc C: from (g26, g20), wR=g27 hR=g27 stAng=180° swAng=-90°
  //   center = (g26+g27, g20) = (g26+g27, g20). g26+g27 = g11+g18+g13/8 = g11+g13/4+g13/8 = g11+g13*3/8 = g25
  //   endAng = 180-90 = 90°. endX = g25+g27*cos(90°) = g25. endY = g20+g27*sin(90°) = g20+g27 = g19.
  //   endpoint = (g25, g19). Hmm, but spec says lnTo(hc, g19) after this arc.
  //   Wait: lnTo before spec says `<lnTo><pt x="hc" y="g19"/></lnTo>`. So endpoint is (g25, g19), then line to (hc, g19).
  //   Hmm actually spec says: `<lnTo><pt x="hc" y="g19" /></lnTo>`.
  //   Wait no: `L(hc, g19)` in the spec.
  // Arc D: from (hc, g19), wR=g27 hR=g27 stAng=90° swAng=-90°
  //   center = (hc, g19-g27), endAng = 0°.
  //   endX = hc+g27*cos(0°) = hc+g27. g19-g27 = g20. endY = g20+g27*sin(0°) = g20.
  //   endpoint = (hc+g27, g20). Hmm, but g24 = g11+g16 = g11+g13*5/8.
  //   hc+g27 = g11+g13/2+g13/8 = g11+g13*5/8 = g24. So endpoint = (g24, g20).
  //   Then lnTo (g24, g21). Then lnTo (hc, g21). Then lnTo (g23, g9). Close.

  const outline = [
    `M${g12},${g21}`,
    `L${g22},${g21}`,
    `L${g22},${g20}`,
    `A${g17},${g17} 0 0,1 ${g11 + g13 / 2},${g10}`, // arc A: outer bottom-right (0°→90°)
    `L${g25},${g10}`, // across outer bottom
    `A${g17},${g17} 0 0,1 ${g11},${g20}`, // arc B: outer bottom-left (90°→180°)
    `L${g11},${g21}`,
    `L${g26},${g21}`,
    `L${g26},${g20}`,
    `A${g27},${g27} 0 0,0 ${g25},${g19}`, // arc C: inner bottom-left (180°→90°, CCW)
    `L${hc},${g19}`, // across inner bottom
    `A${g27},${g27} 0 0,0 ${g24},${g20}`, // arc D: inner bottom-right (90°→0°, CCW)
    `L${g24},${g21}`,
    `L${hc},${g21}`,
    `L${g23},${g9}`,
    `Z`,
  ].join(' ');

  return [
    { d: `${_rect(w, h)} ${fillIcon}`, fill: 'norm', stroke: false },
    { d: fillIcon, fill: 'darken', stroke: false },
    { d: outline, fill: 'none', stroke: true },
    { d: _rect(w, h), fill: 'none', stroke: true },
  ];
});

// actionButtonSound (VBA 0135): speaker icon with 3 sound wave lines
// OOXML spec: 4 paths – bg+speaker cutout (norm), speaker fill (darken), speaker outline+waves (stroke), rect outline (stroke)
multiPathPresets.set('actionButtonSound', (w, h) => {
  const { g9, g10, g11, g12, g13, hc: _hcS, vc } = _abGuides(w, h);
  // Guide calculations from OOXML presetShapeDefinitions.xml
  const g14 = g13 / 8;
  const g15 = (g13 * 5) / 16;
  const g16 = (g13 * 5) / 8;
  const g17 = (g13 * 11) / 16;
  const g18 = (g13 * 3) / 4;
  const g19 = (g13 * 7) / 8;

  // Absolute positions
  const g20 = g9 + g14;
  const g21 = g9 + g15;
  const g22 = g9 + g17;
  const g23 = g9 + g19;
  const g24 = g11 + g15;
  const g25 = g11 + g16;
  const g26 = g11 + g18;

  // Speaker shape (pentagon-like)
  const speaker = `M${g11},${g21} L${g11},${g22} L${g24},${g22} L${g25},${g10} L${g25},${g9} L${g24},${g21} Z`;

  // Outline path: speaker outline (different winding) + 3 sound wave lines
  const speakerOutline = `M${g11},${g21} L${g24},${g21} L${g25},${g9} L${g25},${g10} L${g24},${g22} L${g11},${g22} Z`;

  const waveLine1 = `M${g26},${g21} L${g12},${g20}`; // top-right diagonal
  const waveLine2 = `M${g26},${vc} L${g12},${vc}`; // middle horizontal
  const waveLine3 = `M${g26},${g22} L${g12},${g23}`; // bottom-right diagonal

  const outlineWithWaves = `${speakerOutline} ${waveLine1} ${waveLine2} ${waveLine3}`;

  return [
    { d: `${_rect(w, h)} ${speaker}`, fill: 'norm', stroke: false },
    { d: speaker, fill: 'darken', stroke: false },
    { d: outlineWithWaves, fill: 'none', stroke: true },
    { d: _rect(w, h), fill: 'none', stroke: true },
  ];
});

// actionButtonInformation (VBA 0128): circle with "i" inside
multiPathPresets.set('actionButtonInformation', (w, h) => {
  const { g9, g10, g11, g13, hc, vc: _vcI, dx2 } = _abGuides(w, h);
  const g14 = g13 / 32;
  const g17v = (g13 * 5) / 16;
  const g18v = (g13 * 3) / 8;
  const g19v = (g13 * 13) / 32;
  const g20v = (g13 * 19) / 32;
  const g22v = (g13 * 11) / 16;
  const g23v = (g13 * 13) / 16;
  const g24v = (g13 * 7) / 8;
  const g38 = (g13 * 3) / 32;
  const y25 = g9 + g14;
  const y28 = g9 + g17v;
  const y29 = g9 + g18v;
  const y30 = g9 + g23v;
  const y31 = g9 + g24v;
  const x32 = g11 + g17v;
  const x34 = g11 + g19v;
  const x35 = g11 + g20v;
  const x37 = g11 + g22v;
  const circle = `M${hc},${g9} A${dx2},${dx2} 0 1,1 ${hc},${g10} A${dx2},${dx2} 0 1,1 ${hc},${g9} Z`;
  const dot = `M${hc},${y25} A${g38},${g38} 0 1,1 ${hc},${y25 + g38 * 2} A${g38},${g38} 0 1,1 ${hc},${y25} Z`;
  const iBody = `M${x32},${y28} L${x37},${y28} L${x37},${y29} L${x35},${y29} L${x35},${y30} L${x37},${y30} L${x37},${y31} L${x32},${y31} L${x32},${y30} L${x34},${y30} L${x34},${y29} L${x32},${y29} Z`;
  const iconInner = `${dot} ${iBody}`;
  return [
    { d: `${_rect(w, h)} ${circle}`, fill: 'norm', stroke: false },
    { d: `${circle} ${iconInner}`, fill: 'darken', stroke: false },
    { d: iconInner, fill: 'lighten', stroke: false },
    { d: `${circle} ${iconInner}`, fill: 'none', stroke: true },
    { d: _rect(w, h), fill: 'none', stroke: true },
  ];
});

// actionButtonHome (VBA 0126): house icon with chimney and door
// OOXML spec: 5 paths – bg+house cutout (norm), walls+chimney (darkenLess), roof+door (darken),
// icon outline (stroke), rect outline (stroke)
multiPathPresets.set('actionButtonHome', (w, h) => {
  const { g9, g10, g11, g12, g13, hc, vc } = _abGuides(w, h);
  // Guide calculations from OOXML presetShapeDefinitions.xml
  const g14 = g13 / 16;
  const g15 = g13 / 8;
  const g16 = (g13 * 3) / 16;
  const g17 = (g13 * 5) / 16;
  const g18 = (g13 * 7) / 16;
  const g19 = (g13 * 9) / 16;
  const g20 = (g13 * 11) / 16;
  const g21 = (g13 * 3) / 4;
  const g22 = (g13 * 13) / 16;
  const g23 = (g13 * 7) / 8;

  // Absolute positions
  const g24 = g9 + g14;
  const g25 = g9 + g16;
  const g26 = g9 + g17;
  const g27 = g9 + g21;
  const g28 = g11 + g15;
  const g29 = g11 + g18;
  const g30 = g11 + g19;
  const g31 = g11 + g20;
  const g32 = g11 + g22;
  const g33 = g11 + g23;

  // Path 0: background rect + full house outline cutout (norm, no stroke)
  // House outline: roof triangle → right side → chimney → left side → base
  const houseOutline =
    `M${hc},${g9} ` +
    `L${g11},${vc} L${g28},${vc} L${g28},${g10} L${g33},${g10} L${g33},${vc} L${g12},${vc} ` +
    `L${g32},${g26} L${g32},${g24} L${g31},${g24} L${g31},${g25} Z`;

  // Path 1: walls + chimney (darkenLess, no stroke)
  // Sub-path 1: chimney bar
  const chimney = `M${g32},${g26} L${g32},${g24} L${g31},${g24} L${g31},${g25} Z`;
  // Sub-path 2: house body (walls) with door cutout
  const walls = `M${g28},${vc} L${g28},${g10} L${g29},${g10} L${g29},${g27} L${g30},${g27} L${g30},${g10} L${g33},${g10} L${g33},${vc} Z`;

  // Path 2: roof triangle + door (darken, no stroke)
  const roof = `M${hc},${g9} L${g11},${vc} L${g12},${vc} Z`;
  const door = `M${g29},${g27} L${g30},${g27} L${g30},${g10} L${g29},${g10} Z`;

  // Path 3: icon outline with all detail lines (none fill, stroke)
  const iconOutline =
    `M${hc},${g9} ` +
    `L${g31},${g25} L${g31},${g24} L${g32},${g24} L${g32},${g26} L${g12},${vc} ` +
    `L${g33},${vc} L${g33},${g10} L${g28},${g10} L${g28},${vc} L${g11},${vc} Z ` +
    // Chimney diagonal line
    `M${g31},${g25} L${g32},${g26} ` +
    // Horizontal eave line
    `M${g33},${vc} L${g28},${vc} ` +
    // Door outline
    `M${g29},${g10} L${g29},${g27} L${g30},${g27} L${g30},${g10}`;

  return [
    { d: `${_rect(w, h)} ${houseOutline}`, fill: 'norm', stroke: false },
    { d: `${chimney} ${walls}`, fill: 'darkenLess', stroke: false },
    { d: `${roof} ${door}`, fill: 'darken', stroke: false },
    { d: iconOutline, fill: 'none', stroke: true },
    { d: _rect(w, h), fill: 'none', stroke: true },
  ];
});

// actionButtonHelp (VBA 0127): question mark "?" inside rectangle
// OOXML spec: 4 paths – bg+icon cutout (norm), icon fill (darken), icon outline (stroke), rect outline (stroke)
multiPathPresets.set('actionButtonHelp', (w, h) => {
  const { g9, g11, g13, hc, vc: _vcH } = _abGuides(w, h);
  // Guide calculations from OOXML presetShapeDefinitions.xml
  const g14 = g13 / 7;
  const g15 = (g13 * 3) / 14;
  const g16 = (g13 * 2) / 7;
  const g19 = (g13 * 3) / 7;
  const g20 = (g13 * 4) / 7;
  const g21 = (g13 * 17) / 28;
  const g23 = (g13 * 21) / 28;
  const g24 = (g13 * 11) / 14;
  const g41 = g13 / 14;
  const g42 = (g13 * 3) / 28;

  // Absolute positions
  const g27 = g9 + g16;
  const g29 = g9 + g21;
  const g30 = g9 + g23;
  const g31 = g9 + g24;
  const g33 = g11 + g15;
  const g36 = g11 + g19;
  const g37 = g11 + g20;

  // Helper: OOXML arcTo → SVG arc segment
  // Computes endpoint from center (derived from current point + start angle) and returns SVG A command
  const arcSeg = (
    curX: number,
    curY: number,
    wR: number,
    hR: number,
    stDeg: number,
    swDeg: number,
  ) => {
    const stRad = (stDeg * Math.PI) / 180;
    const endRad = ((stDeg + swDeg) * Math.PI) / 180;
    const cx = curX - wR * Math.cos(stRad);
    const cy = curY - hR * Math.sin(stRad);
    const endX = cx + wR * Math.cos(endRad);
    const endY = cy + hR * Math.sin(endRad);
    const largeArc = Math.abs(swDeg) > 180 ? 1 : 0;
    const sweep = swDeg > 0 ? 1 : 0;
    return { endX, endY, svg: `A${wR},${hR} 0 ${largeArc},${sweep} ${endX},${endY}` };
  };

  // Build question mark path following OOXML arcTo sequence exactly
  // Start at (g33, g27)
  let cx = g33,
    cy = g27;

  // Arc 1: wR=g16 hR=g16 stAng=180° swAng=180° (top semicircle, clockwise)
  const a1 = arcSeg(cx, cy, g16, g16, 180, 180);
  cx = a1.endX;
  cy = a1.endY;

  // Arc 2: wR=g14 hR=g15 stAng=0° swAng=90° (curve down right)
  const a2 = arcSeg(cx, cy, g14, g15, 0, 90);
  cx = a2.endX;
  cy = a2.endY;

  // Arc 3: wR=g41 hR=g42 stAng=270° swAng=-90° (small reverse curve)
  const a3 = arcSeg(cx, cy, g41, g42, 270, -90);
  // After arc 3, lines to stem
  // lnTo (g37, g30), (g36, g30), (g36, g29)
  // then more arcs back up

  // Arc 4: wR=g14 hR=g15 stAng=180° swAng=90° (inner curve going up)
  const a4 = arcSeg(g36, g29, g14, g15, 180, 90);

  // Arc 5: wR=g41 hR=g42 stAng=90° swAng=-90° (small inner reverse curve)
  const a5 = arcSeg(a4.endX, a4.endY, g41, g42, 90, -90);

  // Arc 6: wR=g14 hR=g14 stAng=0° swAng=-180° (inner top semicircle, counter-clockwise)
  const a6 = arcSeg(a5.endX, a5.endY, g14, g14, 0, -180);

  // Bottom dot circle at (hc, g31) with radius g42
  const dot = `M${hc},${g31} A${g42},${g42} 0 1,1 ${hc},${g31 + g42 * 2} A${g42},${g42} 0 1,1 ${hc},${g31} Z`;

  // Question mark path (outer shape with arcs + stem + inner cutout arcs)
  const qMark =
    `M${g33},${g27} ` +
    `${a1.svg} ` +
    `${a2.svg} ` +
    `${a3.svg} ` +
    `L${g37},${g30} L${g36},${g30} L${g36},${g29} ` +
    `${a4.svg} ` +
    `${a5.svg} ` +
    `${a6.svg} Z`;

  const icon = `${qMark} ${dot}`;

  return [
    { d: `${_rect(w, h)} ${icon}`, fill: 'norm', stroke: false }, // Background with icon cutout
    { d: icon, fill: 'darken', stroke: false }, // Darkened icon fill
    { d: icon, fill: 'none', stroke: true }, // Icon outline
    { d: _rect(w, h), fill: 'none', stroke: true }, // Rect outline
  ];
});

// actionButtonDocument (VBA 0134): document with folded corner
multiPathPresets.set('actionButtonDocument', (w, h) => {
  const ss = Math.min(w, h);
  const hc = w / 2,
    vc = h / 2;
  const dx2 = (ss * 3) / 8;
  const dx1 = (ss * 9) / 32;
  const g9 = vc - dx2,
    g10 = vc + dx2;
  const g11 = hc - dx1,
    g12 = hc + dx1;
  const g13 = (ss * 3) / 16;
  const g14 = g12 - g13;
  const g15 = g9 + g13;
  const doc = `M${g11},${g9} L${g14},${g9} L${g12},${g15} L${g12},${g10} L${g11},${g10} Z`;
  const fold = `M${g14},${g9} L${g14},${g15} L${g12},${g15} Z`;
  const outline = `${doc} M${g12},${g15} L${g14},${g15} L${g14},${g9}`;
  return [
    { d: `${_rect(w, h)} ${doc}`, fill: 'norm', stroke: false },
    { d: doc, fill: 'darkenLess', stroke: false },
    { d: fold, fill: 'darken', stroke: false },
    { d: outline, fill: 'none', stroke: true },
    { d: _rect(w, h), fill: 'none', stroke: true },
  ];
});

// actionButtonMovie (VBA 0136): film strip / camera icon
multiPathPresets.set('actionButtonMovie', (w, h) => {
  const { g9, g11, g12, g13 } = _abGuides(w, h);
  // Guide values from OOXML presetShapeDefinitions.xml (fractions of g13 = ss*3/4)
  const g14 = (g13 * 1455) / 21600;
  const g15 = (g13 * 1905) / 21600;
  const g16 = (g13 * 2325) / 21600;
  const g17 = (g13 * 16155) / 21600;
  const g18 = (g13 * 17010) / 21600;
  const g19 = (g13 * 19335) / 21600;
  const g20 = (g13 * 19725) / 21600;
  const g21 = (g13 * 20595) / 21600;
  const g22 = (g13 * 5280) / 21600;
  const g23 = (g13 * 5730) / 21600;
  const g24 = (g13 * 6630) / 21600;
  const g25 = (g13 * 7492) / 21600;
  const g26 = (g13 * 9067) / 21600;
  const g27 = (g13 * 9555) / 21600;
  const g28 = (g13 * 13342) / 21600;
  const g29 = (g13 * 14580) / 21600;
  const g30 = (g13 * 15592) / 21600;
  // Composite guides: x = g11 + gN, y = g9 + gN
  const x31 = g11 + g14;
  const x32 = g11 + g15;
  const x33 = g11 + g16;
  const x34 = g11 + g17;
  const x35 = g11 + g18;
  const x36 = g11 + g19;
  const x37 = g11 + g20;
  const x38 = g11 + g21;
  const y39 = g9 + g22;
  const y40 = g9 + g23;
  const y41 = g9 + g24;
  const y42 = g9 + g25;
  const y43 = g9 + g26;
  const y44 = g9 + g27;
  const y45 = g9 + g28;
  const y46 = g9 + g29;
  const y47 = g9 + g30;
  const icon = [
    `M${g11},${y39}`,
    `L${g11},${y44}`,
    `L${x31},${y44}`,
    `L${x32},${y43}`,
    `L${x33},${y43}`,
    `L${x33},${y47}`,
    `L${x35},${y47}`,
    `L${x35},${y45}`,
    `L${x36},${y45}`,
    `L${x38},${y46}`,
    `L${g12},${y46}`,
    `L${g12},${y41}`,
    `L${x38},${y41}`,
    `L${x37},${y42}`,
    `L${x35},${y42}`,
    `L${x35},${y41}`,
    `L${x34},${y40}`,
    `L${x32},${y40}`,
    `L${x31},${y39}`,
    `Z`,
  ].join(' ');
  return [
    { d: `${_rect(w, h)} ${icon}`, fill: 'norm', stroke: false },
    { d: icon, fill: 'darken', stroke: false },
    { d: icon, fill: 'none', stroke: true },
    { d: _rect(w, h), fill: 'none', stroke: true },
  ];
});

// flowChartOfflineStorage (VBA 0139): inverted triangle with horizontal base line
multiPathPresets.set('flowChartOfflineStorage', (w, h) => {
  const tri = `M0,0 L${w},0 L${w / 2},${h} Z`;
  const lineY = (h * 4) / 5;
  const line = `M${(w * 2) / 5},${lineY} L${(w * 3) / 5},${lineY}`;
  return [
    { d: tri, fill: 'norm', stroke: false },
    { d: line, fill: 'none', stroke: true },
    { d: tri, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('cube', (w, h, adjustments) => {
  const a = Math.min(Math.max(adj(adjustments, 'adj', 25000), 0), 0.45);
  const depth = Math.min(w, h) * a;
  const front = [
    `M0,${depth}`,
    `L${w - depth},${depth}`,
    `L${w - depth},${h}`,
    `L0,${h}`,
    'Z',
  ].join(' ');
  const top = [`M0,${depth}`, `L${depth},0`, `L${w},0`, `L${w - depth},${depth}`, 'Z'].join(' ');
  const right = [
    `M${w - depth},${depth}`,
    `L${w},0`,
    `L${w},${h - depth}`,
    `L${w - depth},${h}`,
    'Z',
  ].join(' ');
  return [
    { d: front, fill: 'norm', stroke: true },
    { d: top, fill: 'lightenLess', stroke: true },
    { d: right, fill: 'darkenLess', stroke: true },
  ];
});

multiPathPresets.set('bevel', (w, h, adjustments) => {
  // OOXML bevel: picture-frame shape with 4 beveled faces + center rect.
  // adj = bevel thickness (default 12500 = 12.5% of min(w,h))
  const a = Math.min(Math.max(adj(adjustments, 'adj', 12500), 0), 0.45);
  const t = Math.min(w, h) * a;
  const inner = `M${t},${t} L${w - t},${t} L${w - t},${h - t} L${t},${h - t} Z`;
  const top = `M0,0 L${w},0 L${w - t},${t} L${t},${t} Z`;
  const bottom = `M0,${h} L${t},${h - t} L${w - t},${h - t} L${w},${h} Z`;
  const left = `M0,0 L${t},${t} L${t},${h - t} L0,${h} Z`;
  const right = `M${w},0 L${w},${h} L${w - t},${h - t} L${w - t},${t} Z`;
  return [
    { d: inner, fill: 'norm', stroke: true },
    { d: top, fill: 'lightenLess', stroke: true },
    { d: right, fill: 'darkenLess', stroke: true },
    { d: bottom, fill: 'darken', stroke: true },
    { d: left, fill: 'lighten', stroke: true },
  ];
});

multiPathPresets.set('leftRightRibbon', (w, h, adjustments) => {
  // OOXML leftRightRibbon: 3-path shape (body + center fold shadow + stroke outline).
  // adj1=50000 (band height), adj2=50000 (notch width), adj3=16667 (wave amplitude).
  const ss = Math.min(w, h);
  const wd2 = w / 2;
  const wd32 = w / 32;
  const hc = w / 2;
  const vc = h / 2;

  const a3 = Math.min(Math.max((adjustments?.get('adj3') ?? 16667) / 100000, 0), 0.33333);
  const maxAdj1 = 1 - a3;
  const a1 = Math.min(Math.max((adjustments?.get('adj1') ?? 50000) / 100000, 0), maxAdj1);
  const w1 = wd2 - wd32;
  const maxAdj2 = w1 / ss;
  const a2 = Math.min(Math.max((adjustments?.get('adj2') ?? 50000) / 100000, 0), maxAdj2);

  const x1 = ss * a2;
  const x4 = w - x1;
  const dy1 = (h * a1) / 2;
  const dy2 = (-h * a3) / 2;

  const ly1 = vc + dy2 - dy1;
  const ry4 = vc + dy1 - dy2;
  const ly2 = ly1 + dy1;
  const ry3 = h - ly2;
  const ly4 = ly2 * 2;
  const ry1 = h - ly4;
  const ly3 = ly4 - ly1;
  const ry2 = h - ly3;

  const hR = (a3 * ss) / 4;
  const x2 = hc - wd32;
  const x3 = hc + wd32;
  const y1 = ly1 + hR;
  const y2 = ry2 - hR;

  // Helper: compute OOXML arcTo → SVG arc segment
  const arcTo = (
    curX: number,
    curY: number,
    wR: number,
    hRad: number,
    stDeg: number,
    swDeg: number,
  ) => {
    const stRad = (stDeg * Math.PI) / 180;
    const endRad = ((stDeg + swDeg) * Math.PI) / 180;
    const cx = curX - wR * Math.cos(stRad);
    const cy = curY - hRad * Math.sin(stRad);
    const endX = cx + wR * Math.cos(endRad);
    const endY = cy + hRad * Math.sin(endRad);
    const largeArc = Math.abs(swDeg) > 180 ? 1 : 0;
    const sweep = swDeg > 0 ? 1 : 0;
    return { endX, endY, svg: `A${wR},${hRad} 0 ${largeArc},${sweep} ${endX},${endY}` };
  };

  // Path 1: Main body (fill, no stroke)
  const cx1 = hc,
    cy1 = ly1; // after lnTo (hc, ly1)
  const arc1a = arcTo(cx1, cy1, wd32, hR, 270, 180);
  const arc1b = arcTo(arc1a.endX, arc1a.endY, wd32, hR, 270, -180);
  const cx1c = hc,
    cy1c = ry4; // after lnTo (hc, ry4)
  const arc1c = arcTo(cx1c, cy1c, wd32, hR, 90, 90);

  const body = [
    `M0,${ly2}`,
    `L${x1},0`,
    `L${x1},${ly1}`,
    `L${hc},${ly1}`,
    arc1a.svg,
    arc1b.svg,
    `L${x4},${ry2}`,
    `L${x4},${ry1}`,
    `L${w},${ry3}`,
    `L${x4},${h}`,
    `L${x4},${ry4}`,
    `L${hc},${ry4}`,
    arc1c.svg,
    `L${x2},${ly3}`,
    `L${x1},${ly3}`,
    `L${x1},${ly4}`,
    'Z',
  ].join(' ');

  // Path 2: Center fold shadow (darkenLess, no stroke)
  const arc2a = arcTo(x3, y1, wd32, hR, 0, 90);
  const arc2b = arcTo(arc2a.endX, arc2a.endY, wd32, hR, 270, -180);

  const shadow = [`M${x3},${y1}`, arc2a.svg, arc2b.svg, `L${x3},${ry2}`, 'Z'].join(' ');

  // Path 3: Stroke outline (no fill) — same as body + interior fold lines
  const outline = [body, `M${x3},${y1} L${x3},${ry2}`, `M${x2},${y2} L${x2},${ly3}`].join(' ');

  return [
    { d: body, fill: 'norm', stroke: false },
    { d: shadow, fill: 'darkenLess', stroke: false },
    { d: outline, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('ellipseRibbon', (w, h, adjustments) => {
  // OOXML ellipseRibbon: ribbon with parabolic curved bottom edge
  // 3 paths: body (fill=norm), darkenLess shadow folds, outline (fill=none)
  const adj1 = adjustments?.get('adj1') ?? 25000;
  const adj2 = adjustments?.get('adj2') ?? 50000;
  const adj3 = adjustments?.get('adj3') ?? 12500;

  const a1 = Math.max(0, Math.min(adj1, 100000));
  const a2 = Math.max(25000, Math.min(adj2, 75000));
  const q10 = 100000 - a1;
  const q11 = q10 / 2;
  const q12 = a1 - q11;
  const minAdj3 = Math.max(0, q12);
  const a3 = Math.max(minAdj3, Math.min(adj3, a1));

  const dx2 = (w * a2) / 200000;
  const x2 = w / 2 - dx2;
  const x3 = x2 + w / 8;
  const x4 = w - x3;
  const x5 = w - x2;
  const x6 = w - w / 8;

  const dy1 = (h * a3) / 100000;
  const f1 = w > 0 ? (4 * dy1) / w : 0;
  // Parabola: p(x) = f1 * x * (1 - x/w)
  const parab = (x: number) => f1 * (x - (x * x) / w);

  const y1 = parab(x3);
  const cx1 = x3 / 2;
  const cy1 = f1 * cx1; // Bezier control (approximation)
  const cx2 = w - cx1;

  // q1 redefined: total fold height
  const q1 = (h * a1) / 100000;
  const dy3 = q1 - dy1;

  const q5 = parab(x2);
  const y3 = q5 + dy3;

  const q6 = dy1 + dy3 - y3;
  const q7 = q6 + dy1;
  const cy3 = q7 + dy3;

  const rh = h - q1;

  const q8 = (dy1 * 14) / 16;
  const y2 = (q8 + rh) / 2;

  const y5 = q5 + rh;
  const y6 = y3 + rh;

  const cx4 = x2 / 2;
  const cy4 = f1 * cx4 + rh;
  const cx5 = w - cx4;

  const cy6 = cy3 + rh;

  const y7 = y1 + dy3;
  const cy7 = q1 + q1 - y7;

  const hc = w / 2;
  const wd8 = w / 8;

  // Path 1: body fill (stroke=false)
  const body = [
    `M0,0`,
    `Q${cx1},${cy1} ${x3},${y1}`,
    `L${x2},${y3}`,
    `Q${hc},${cy3} ${x5},${y3}`,
    `L${x4},${y1}`,
    `Q${cx2},${cy1} ${w},0`,
    `L${x6},${y2}`,
    `L${w},${rh}`,
    `Q${cx5},${cy4} ${x5},${y5}`,
    `L${x5},${y6}`,
    `Q${hc},${cy6} ${x2},${y6}`,
    `L${x2},${y5}`,
    `Q${cx4},${cy4} 0,${rh}`,
    `L${wd8},${y2}`,
    `Z`,
  ].join(' ');

  // Path 2: darkenLess shadow folds (stroke=false)
  const shadow = [
    `M${x3},${y7}`,
    `L${x3},${y1}`,
    `L${x2},${y3}`,
    `Q${hc},${cy3} ${x5},${y3}`,
    `L${x4},${y1}`,
    `L${x4},${y7}`,
    `Q${hc},${cy7} ${x3},${y7}`,
    `Z`,
  ].join(' ');

  // Path 3: outline (fill=none)
  const outline = [
    `M0,0`,
    `Q${cx1},${cy1} ${x3},${y1}`,
    `L${x2},${y3}`,
    `Q${hc},${cy3} ${x5},${y3}`,
    `L${x4},${y1}`,
    `Q${cx2},${cy1} ${w},0`,
    `L${x6},${y2}`,
    `L${w},${rh}`,
    `Q${cx5},${cy4} ${x5},${y5}`,
    `L${x5},${y6}`,
    `Q${hc},${cy6} ${x2},${y6}`,
    `L${x2},${y5}`,
    `Q${cx4},${cy4} 0,${rh}`,
    `L${wd8},${y2}`,
    `Z`,
    `M${x2},${y5} L${x2},${y3}`,
    `M${x5},${y3} L${x5},${y5}`,
    `M${x3},${y1} L${x3},${y7}`,
    `M${x4},${y7} L${x4},${y1}`,
  ].join(' ');

  return [
    { d: body, fill: 'norm', stroke: false },
    { d: shadow, fill: 'darkenLess', stroke: false },
    { d: outline, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('ellipseRibbon2', (w, h, adjustments) => {
  // OOXML ellipseRibbon2: inverted ribbon with parabolic curved top edge
  // 3 paths: body (fill=norm), darkenLess shadow folds, outline (fill=none)
  // All y-values computed as b - value (measured from bottom)
  const adj1 = adjustments?.get('adj1') ?? 25000;
  const adj2 = adjustments?.get('adj2') ?? 50000;
  const adj3 = adjustments?.get('adj3') ?? 12500;

  const a1 = Math.max(0, Math.min(adj1, 100000));
  const a2 = Math.max(25000, Math.min(adj2, 75000));
  const q10 = 100000 - a1;
  const q11 = q10 / 2;
  const q12 = a1 - q11;
  const minAdj3 = Math.max(0, q12);
  const a3 = Math.max(minAdj3, Math.min(adj3, a1));

  const b = h;
  const dx2 = (w * a2) / 200000;
  const x2 = w / 2 - dx2;
  const x3 = x2 + w / 8;
  const x4 = w - x3;
  const x5 = w - x2;
  const x6 = w - w / 8;

  const dy1 = (h * a3) / 100000;
  const f1 = w > 0 ? (4 * dy1) / w : 0;

  // u1 = parabola at x3
  const u1 = f1 * (x3 - (x3 * x3) / w);
  const y1 = b - u1;

  const cx1 = x3 / 2;
  const cu1 = f1 * cx1;
  const cy1 = b - cu1;
  const cx2 = w - cx1;

  // q1 redefined: total fold height
  const q1 = (h * a1) / 100000;
  const dy3 = q1 - dy1;

  const q5 = f1 * (x2 - (x2 * x2) / w);
  const u3 = q5 + dy3;
  const y3 = b - u3;

  const q6 = dy1 + dy3 - u3;
  const q7 = q6 + dy1;
  const cu3 = q7 + dy3;
  const cy3 = b - cu3;

  const rh = b - q1;

  const q8 = (dy1 * 14) / 16;
  const u2 = (q8 + rh) / 2;
  const y2 = b - u2;

  const u5 = q5 + rh;
  const y5 = b - u5;

  const u6 = u3 + rh;
  const y6 = b - u6;

  const cx4 = x2 / 2;
  const cu4 = f1 * cx4 + rh;
  const cy4 = b - cu4;
  const cx5 = w - cx4;

  const cu6 = cu3 + rh;
  const cy6 = b - cu6;

  const u7 = u1 + dy3;
  const y7 = b - u7;
  const cu7 = q1 + q1 - u7;
  const cy7 = b - cu7;

  const hc = w / 2;
  const wd8 = w / 8;

  // Path 1: body fill (stroke=false)
  const body = [
    `M0,${b}`,
    `Q${cx1},${cy1} ${x3},${y1}`,
    `L${x2},${y3}`,
    `Q${hc},${cy3} ${x5},${y3}`,
    `L${x4},${y1}`,
    `Q${cx2},${cy1} ${w},${b}`,
    `L${x6},${y2}`,
    `L${w},${q1}`,
    `Q${cx5},${cy4} ${x5},${y5}`,
    `L${x5},${y6}`,
    `Q${hc},${cy6} ${x2},${y6}`,
    `L${x2},${y5}`,
    `Q${cx4},${cy4} 0,${q1}`,
    `L${wd8},${y2}`,
    `Z`,
  ].join(' ');

  // Path 2: darkenLess shadow folds (stroke=false)
  const shadow = [
    `M${x3},${y7}`,
    `L${x3},${y1}`,
    `L${x2},${y3}`,
    `Q${hc},${cy3} ${x5},${y3}`,
    `L${x4},${y1}`,
    `L${x4},${y7}`,
    `Q${hc},${cy7} ${x3},${y7}`,
    `Z`,
  ].join(' ');

  // Path 3: outline (fill=none)
  const outline = [
    `M0,${b}`,
    `L${wd8},${y2}`,
    `L0,${q1}`,
    `Q${cx4},${cy4} ${x2},${y5}`,
    `L${x2},${y6}`,
    `Q${hc},${cy6} ${x5},${y6}`,
    `L${x5},${y5}`,
    `Q${cx5},${cy4} ${w},${q1}`,
    `L${x6},${y2}`,
    `L${w},${b}`,
    `Q${cx2},${cy1} ${x4},${y1}`,
    `L${x5},${y3}`,
    `Q${hc},${cy3} ${x2},${y3}`,
    `L${x3},${y1}`,
    `Q${cx1},${cy1} 0,${b}`,
    `Z`,
    `M${x2},${y3} L${x2},${y5}`,
    `M${x5},${y5} L${x5},${y3}`,
    `M${x3},${y7} L${x3},${y1}`,
    `M${x4},${y1} L${x4},${y7}`,
  ].join(' ');

  return [
    { d: body, fill: 'norm', stroke: false },
    { d: shadow, fill: 'darkenLess', stroke: false },
    { d: outline, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('smileyFace', (w, h, adjustments) => {
  // OOXML smileyFace: 4 paths — face(norm), eyes(darkenLess), smile(none), outline(none+stroke)
  const wd2 = w / 2;
  const hd2 = h / 2;
  const hc = w / 2;
  const vc = h / 2;

  // Adjustment: smile amplitude (default 4653, range -4653..4653)
  const rawAdj = adjustments?.get('adj') ?? 4653;
  const a = Math.max(-4653, Math.min(rawAdj, 4653));

  // Eye positions (OOXML exact)
  const x2 = (w * 6215) / 21600;
  const x3 = (w * 13135) / 21600;
  const y1 = (h * 7570) / 21600;
  const wR = (w * 1125) / 21600;
  const hR = (h * 1125) / 21600;

  // Smile curve positions (OOXML exact)
  const x1 = (w * 4969) / 21699;
  const x4 = (w * 16640) / 21600;
  const y3 = (h * 16515) / 21600;
  const dy2 = (h * a) / 100000;
  const y2 = y3 - dy2;
  const y4 = y3 + dy2;
  const dy3 = (h * a) / 50000;
  const y5 = y4 + dy3;

  // Path 1: face ellipse (fill=norm, stroke=false) — two half-arcs for full circle
  const face = `M${w},${vc} A${wd2},${hd2} 0 1,1 0,${vc} A${wd2},${hd2} 0 1,1 ${w},${vc} Z`;

  // Path 2: eyes (fill=darkenLess) — two small ellipses at OOXML positions (two half-arcs each)
  const leftEye = `M${(x2 + wR).toFixed(2)},${y1.toFixed(2)} A${wR.toFixed(2)},${hR.toFixed(2)} 0 1,1 ${(x2 - wR).toFixed(2)},${y1.toFixed(2)} A${wR.toFixed(2)},${hR.toFixed(2)} 0 1,1 ${(x2 + wR).toFixed(2)},${y1.toFixed(2)} Z`;
  const rightEye = `M${(x3 + wR).toFixed(2)},${y1.toFixed(2)} A${wR.toFixed(2)},${hR.toFixed(2)} 0 1,1 ${(x3 - wR).toFixed(2)},${y1.toFixed(2)} A${wR.toFixed(2)},${hR.toFixed(2)} 0 1,1 ${(x3 + wR).toFixed(2)},${y1.toFixed(2)} Z`;

  // Path 3: smile (fill=none) — quadratic Bezier (OOXML quadBezTo)
  const smile = `M${x1.toFixed(2)},${y2.toFixed(2)} Q${hc.toFixed(2)},${y5.toFixed(2)} ${x4.toFixed(2)},${y2.toFixed(2)}`;

  // Path 4: face outline (fill=none, stroke=true) — same as path 1
  const outline = `M${w},${vc} A${wd2},${hd2} 0 1,1 0,${vc} A${wd2},${hd2} 0 1,1 ${w},${vc} Z`;

  return [
    { d: face, fill: 'norm', stroke: false },
    { d: `${leftEye} ${rightEye}`, fill: 'darkenLess', stroke: false },
    { d: smile, fill: 'none', stroke: true },
    { d: outline, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('foldedCorner', (w, h, adjustments) => {
  const a = adj(adjustments, 'adj', 16667);
  const fold = Math.min(w, h) * a * 0.7;
  const body = `M0,0 L${w},0 L${w},${h - fold} L${w - fold},${h} L0,${h} Z`;
  const foldFace = `M${w - fold},${h} L${w - fold},${h - fold} L${w},${h - fold} Z`;
  const crease = `M${w - fold},${h} L${w - fold},${h - fold}`;
  return [
    { d: body, fill: 'norm', stroke: true },
    { d: foldFace, fill: 'darkenLess', stroke: false },
    { d: crease, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('can', (w, h, adjustments) => {
  // OOXML: 3 paths — body (norm), top face (lighten), outline (stroke-only)
  const ss = Math.min(w, h);
  const maxAdj = (50000 * h) / ss;
  const a = Math.min(Math.max(adjustments?.get('adj') ?? 25000, 0), maxAdj);
  const y1 = (ss * a) / 200000;
  const y3 = h - y1;
  const wd2 = w / 2;
  const arcSeg = (
    curX: number,
    curY: number,
    wR: number,
    hR: number,
    stDeg: number,
    swDeg: number,
  ) => {
    const stRad = (stDeg * Math.PI) / 180;
    const endRad = ((stDeg + swDeg) * Math.PI) / 180;
    const cx = curX - wR * Math.cos(stRad);
    const cy = curY - hR * Math.sin(stRad);
    const endX = cx + wR * Math.cos(endRad);
    const endY = cy + hR * Math.sin(endRad);
    const largeArc = Math.abs(swDeg) > 180 ? 1 : 0;
    const sweep = swDeg > 0 ? 1 : 0;
    return { endX, endY, svg: `A${wR},${hR} 0 ${largeArc},${sweep} ${endX},${endY}` };
  };
  // Path 1: Body (stroke:false, fill:norm)
  const a1 = arcSeg(0, y1, wd2, y1, 180, -180);
  const a2 = arcSeg(w, y3, wd2, y1, 0, 180);
  const body = `M0,${y1} ${a1.svg} L${w},${y3} ${a2.svg} Z`;
  // Path 2: Top face (stroke:false, fill:lighten)
  const a3 = arcSeg(0, y1, wd2, y1, 180, 180);
  const a4 = arcSeg(a3.endX, a3.endY, wd2, y1, 0, 180);
  const topFace = `M0,${y1} ${a3.svg} ${a4.svg} Z`;
  // Path 3: Outline (fill:none, stroke:true)
  const a5 = arcSeg(w, y1, wd2, y1, 0, 180);
  const a6 = arcSeg(a5.endX, a5.endY, wd2, y1, 180, 180);
  const a7 = arcSeg(w, y3, wd2, y1, 0, 180);
  const outline = `M${w},${y1} ${a5.svg} ${a6.svg} L${w},${y3} ${a7.svg} L0,${y1}`;
  return [
    { d: body, fill: 'norm', stroke: false },
    { d: topFace, fill: 'lighten', stroke: false },
    { d: outline, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('curvedrightarrow', (w, h, adjustments) =>
  buildCurvedArrowMultiPath('curvedRightArrow', w, h, adjustments),
);

multiPathPresets.set('curvedleftarrow', (w, h, adjustments) =>
  buildCurvedArrowMultiPath('curvedLeftArrow', w, h, adjustments),
);

multiPathPresets.set('curveduparrow', (w, h, adjustments) =>
  buildCurvedVerticalArrowMultiPath('curvedUpArrow', w, h, adjustments),
);

multiPathPresets.set('curveddownarrow', (w, h, adjustments) =>
  buildCurvedVerticalArrowMultiPath('curvedDownArrow', w, h, adjustments),
);

multiPathPresets.set('bordercallout1', (w, h, adjustments) => {
  // OOXML: filled+stroked rectangle body + separate leader line (stroke-only).
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 112500)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -38333)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: true },
    { d: `M${x1},${y1} L${x2},${y2}`, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('accentcallout1', (w, h, adjustments) => {
  // OOXML: filled rect + accent bar at x1 + 1-segment callout line
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 112500)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -38333)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: false },
    { d: `M${x1},0 L${x1},${h}`, fill: 'none', stroke: true },
    { d: `M${x1},${y1} L${x2},${y2}`, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('accentcallout2', (w, h, adjustments) => {
  // OOXML: filled rect + accent bar at x1 + 2-segment callout line
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 18750)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -16667)) / 100000;
  const y3 = (h * (adjustments?.get('adj5') ?? 112500)) / 100000;
  const x3 = (w * (adjustments?.get('adj6') ?? -46667)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: false },
    { d: `M${x1},0 L${x1},${h}`, fill: 'none', stroke: true },
    { d: `M${x1},${y1} L${x2},${y2} L${x3},${y3}`, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('accentcallout3', (w, h, adjustments) => {
  // OOXML: filled rect + accent bar at x1 + 3-segment callout line
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 18750)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -16667)) / 100000;
  const y3 = (h * (adjustments?.get('adj5') ?? 100000)) / 100000;
  const x3 = (w * (adjustments?.get('adj6') ?? -16667)) / 100000;
  const y4 = (h * (adjustments?.get('adj7') ?? 112963)) / 100000;
  const x4 = (w * (adjustments?.get('adj8') ?? -8333)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: false },
    { d: `M${x1},0 L${x1},${h}`, fill: 'none', stroke: true },
    { d: `M${x1},${y1} L${x2},${y2} L${x3},${y3} L${x4},${y4}`, fill: 'none', stroke: true },
  ];
});

// --- callout1/2/3: filled rect (no stroke) + callout line segments ---
multiPathPresets.set('callout1', (w, h, adjustments) => {
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 112500)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -38333)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: false },
    { d: `M${x1},${y1} L${x2},${y2}`, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('callout2', (w, h, adjustments) => {
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 18750)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -16667)) / 100000;
  const y3 = (h * (adjustments?.get('adj5') ?? 112500)) / 100000;
  const x3 = (w * (adjustments?.get('adj6') ?? -46667)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: false },
    { d: `M${x1},${y1} L${x2},${y2} L${x3},${y3}`, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('callout3', (w, h, adjustments) => {
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 18750)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -16667)) / 100000;
  const y3 = (h * (adjustments?.get('adj5') ?? 100000)) / 100000;
  const x3 = (w * (adjustments?.get('adj6') ?? -16667)) / 100000;
  const y4 = (h * (adjustments?.get('adj7') ?? 112963)) / 100000;
  const x4 = (w * (adjustments?.get('adj8') ?? -8333)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: false },
    { d: `M${x1},${y1} L${x2},${y2} L${x3},${y3} L${x4},${y4}`, fill: 'none', stroke: true },
  ];
});

// --- borderCallout2/3: filled+stroked rect + callout line segments ---
multiPathPresets.set('bordercallout2', (w, h, adjustments) => {
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 18750)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -16667)) / 100000;
  const y3 = (h * (adjustments?.get('adj5') ?? 112500)) / 100000;
  const x3 = (w * (adjustments?.get('adj6') ?? -46667)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: true },
    { d: `M${x1},${y1} L${x2},${y2} L${x3},${y3}`, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('bordercallout3', (w, h, adjustments) => {
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 18750)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -16667)) / 100000;
  const y3 = (h * (adjustments?.get('adj5') ?? 100000)) / 100000;
  const x3 = (w * (adjustments?.get('adj6') ?? -16667)) / 100000;
  const y4 = (h * (adjustments?.get('adj7') ?? 112963)) / 100000;
  const x4 = (w * (adjustments?.get('adj8') ?? -8333)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: true },
    { d: `M${x1},${y1} L${x2},${y2} L${x3},${y3} L${x4},${y4}`, fill: 'none', stroke: true },
  ];
});

// --- accentBorderCallout1/2/3: filled+stroked rect + accent bar + callout line ---
multiPathPresets.set('accentbordercallout1', (w, h, adjustments) => {
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 112500)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -38333)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: true },
    { d: `M${x1},0 L${x1},${h}`, fill: 'none', stroke: true },
    { d: `M${x1},${y1} L${x2},${y2}`, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('accentbordercallout2', (w, h, adjustments) => {
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 18750)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -16667)) / 100000;
  const y3 = (h * (adjustments?.get('adj5') ?? 112500)) / 100000;
  const x3 = (w * (adjustments?.get('adj6') ?? -46667)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: true },
    { d: `M${x1},0 L${x1},${h}`, fill: 'none', stroke: true },
    { d: `M${x1},${y1} L${x2},${y2} L${x3},${y3}`, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('accentbordercallout3', (w, h, adjustments) => {
  const y1 = (h * (adjustments?.get('adj1') ?? 18750)) / 100000;
  const x1 = (w * (adjustments?.get('adj2') ?? -8333)) / 100000;
  const y2 = (h * (adjustments?.get('adj3') ?? 18750)) / 100000;
  const x2 = (w * (adjustments?.get('adj4') ?? -16667)) / 100000;
  const y3 = (h * (adjustments?.get('adj5') ?? 100000)) / 100000;
  const x3 = (w * (adjustments?.get('adj6') ?? -16667)) / 100000;
  const y4 = (h * (adjustments?.get('adj7') ?? 112963)) / 100000;
  const x4 = (w * (adjustments?.get('adj8') ?? -8333)) / 100000;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: true },
    { d: `M${x1},0 L${x1},${h}`, fill: 'none', stroke: true },
    { d: `M${x1},${y1} L${x2},${y2} L${x3},${y3} L${x4},${y4}`, fill: 'none', stroke: true },
  ];
});

// Chart placeholders: frame + guide lines.
// PowerPoint uses these as pre-chart placeholders (chartX / chartPlus / chartStar).
multiPathPresets.set('chartx', (w, h) => {
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: false },
    { d: `M0,0 L${w},${h} M${w},0 L0,${h}`, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('chartplus', (w, h) => {
  const cx = w / 2;
  const cy = h / 2;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: false },
    { d: `M${cx},0 L${cx},${h} M0,${cy} L${w},${cy}`, fill: 'none', stroke: true },
  ];
});

multiPathPresets.set('chartstar', (w, h) => {
  // OOXML: 3 guide paths — 2 diagonals + 1 vertical (no horizontal center line)
  const cx = w / 2;
  return [
    { d: `M0,0 L${w},0 L${w},${h} L0,${h} Z`, fill: 'norm', stroke: false },
    {
      d: `M0,0 L${w},${h} M${w},0 L0,${h} M${cx},0 L${cx},${h}`,
      fill: 'none',
      stroke: true,
    },
  ];
});

/**
 * Helper: compute OOXML arcTo endpoint and SVG arc command from current position.
 * OOXML arcTo: center = curPos - radius*dir(stAng), endpoint = center + radius*dir(stAng+swAng)
 * Returns { svgArc, endX, endY }
 */
function ooArcTo(
  curX: number,
  curY: number,
  wR: number,
  hR: number,
  stAngDeg: number,
  swAngDeg: number,
): { svg: string; x: number; y: number } {
  const stRad = (stAngDeg * Math.PI) / 180;
  const cx = curX - wR * Math.cos(stRad);
  const cy = curY - hR * Math.sin(stRad);
  const endRad = ((stAngDeg + swAngDeg) * Math.PI) / 180;
  const ex = cx + wR * Math.cos(endRad);
  const ey = cy + hR * Math.sin(endRad);
  const absSweep = Math.abs(swAngDeg);
  const largeArc = absSweep > 180 ? 1 : 0;
  const sweepFlag = swAngDeg >= 0 ? 1 : 0;
  return { svg: `A${wR},${hR} 0 ${largeArc},${sweepFlag} ${ex},${ey}`, x: ex, y: ey };
}

// --- ribbon (OOXML spec: 3 paths with arcTo, adj1=16667, adj2=50000) ---
// Ribbon with tails at top, front panel at bottom. Three paths: body, darkenLess folds, outline.
multiPathPresets.set('ribbon', (w, h, adjustments) => {
  const adj1Raw = adjustments?.get('adj1') ?? 16667;
  const adj2Raw = adjustments?.get('adj2') ?? 50000;
  const a1 = Math.min(Math.max(adj1Raw, 0), 33333);
  const a2 = Math.min(Math.max(adj2Raw, 25000), 75000);

  const hc = w / 2;
  const wd8 = w / 8;
  const wd32 = w / 32;
  const x10 = w - wd8;
  const dx2 = (w * a2) / 200000;
  const x2 = hc - dx2;
  const x9 = hc + dx2;
  const x3 = x2 + wd32;
  const x8 = x9 - wd32;
  const x5 = x2 + wd8;
  const x6 = x9 - wd8;
  const x4 = x5 - wd32;
  const x7 = x6 + wd32;
  const y1 = (h * a1) / 200000;
  const y2 = (h * a1) / 100000;
  const y4 = h - y2;
  const y3 = y4 / 2;
  const hR = (h * a1) / 400000;
  const y5 = h - hR;
  const y6 = y2 - hR;

  let cx: number, cy: number, arc;

  // Path 1: body fill (stroke=false)
  const p1: string[] = [];
  cx = 0;
  cy = 0;
  p1.push(`M${0},${0}`);
  p1.push(`L${x4},${0}`);
  cx = x4;
  cy = 0;
  arc = ooArcTo(cx, cy, wd32, hR, 270, 180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x3},${y1}`);
  cx = x3;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 270, -180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x8},${y2}`);
  cx = x8;
  cy = y2;
  arc = ooArcTo(cx, cy, wd32, hR, 90, -180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x7},${y1}`);
  cx = x7;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 90, 180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${w},${0}`);
  p1.push(`L${x10},${y3}`);
  p1.push(`L${w},${y4}`);
  p1.push(`L${x9},${y4}`);
  p1.push(`L${x9},${y5}`);
  cx = x9;
  cy = y5;
  arc = ooArcTo(cx, cy, wd32, hR, 0, 90);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x3},${h}`);
  cx = x3;
  cy = h;
  arc = ooArcTo(cx, cy, wd32, hR, 90, 90);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x2},${y4}`);
  p1.push(`L${0},${y4}`);
  p1.push(`L${wd8},${y3}`);
  p1.push('Z');

  // Path 2: darkenLess folds (stroke=false)
  const p2: string[] = [];
  // Left fold
  cx = x5;
  cy = hR;
  p2.push(`M${cx},${cy}`);
  arc = ooArcTo(cx, cy, wd32, hR, 0, 90);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p2.push(`L${x3},${y1}`);
  cx = x3;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 270, -180);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p2.push(`L${x5},${y2}`);
  p2.push('Z');
  // Right fold
  cx = x6;
  cy = hR;
  p2.push(`M${cx},${cy}`);
  arc = ooArcTo(cx, cy, wd32, hR, 180, -90);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p2.push(`L${x8},${y1}`);
  cx = x8;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 270, 180);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p2.push(`L${x6},${y2}`);
  p2.push('Z');

  // Path 3: outline (fill=none, includes fold lines)
  const p3: string[] = [];
  cx = 0;
  cy = 0;
  p3.push(`M${0},${0}`);
  p3.push(`L${x4},${0}`);
  cx = x4;
  cy = 0;
  arc = ooArcTo(cx, cy, wd32, hR, 270, 180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x3},${y1}`);
  cx = x3;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 270, -180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x8},${y2}`);
  cx = x8;
  cy = y2;
  arc = ooArcTo(cx, cy, wd32, hR, 90, -180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x7},${y1}`);
  cx = x7;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 90, 180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${w},${0}`);
  p3.push(`L${x10},${y3}`);
  p3.push(`L${w},${y4}`);
  p3.push(`L${x9},${y4}`);
  p3.push(`L${x9},${y5}`);
  cx = x9;
  cy = y5;
  arc = ooArcTo(cx, cy, wd32, hR, 0, 90);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x3},${h}`);
  cx = x3;
  cy = h;
  arc = ooArcTo(cx, cy, wd32, hR, 90, 90);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x2},${y4}`);
  p3.push(`L${0},${y4}`);
  p3.push(`L${wd8},${y3}`);
  p3.push('Z');
  // Fold lines
  p3.push(`M${x5},${hR} L${x5},${y2}`);
  p3.push(`M${x6},${y2} L${x6},${hR}`);
  p3.push(`M${x2},${y4} L${x2},${y6}`);
  p3.push(`M${x9},${y6} L${x9},${y4}`);

  return [
    { d: p1.join(' '), fill: 'norm', stroke: false },
    { d: p2.join(' '), fill: 'darkenLess', stroke: false },
    { d: p3.join(' '), fill: 'none', stroke: true },
  ];
});

// --- ribbon2 (OOXML spec: 3 paths, inverted ribbon with tails at bottom) ---
multiPathPresets.set('ribbon2', (w, h, adjustments) => {
  const adj1Raw = adjustments?.get('adj1') ?? 16667;
  const adj2Raw = adjustments?.get('adj2') ?? 50000;
  const a1 = Math.min(Math.max(adj1Raw, 0), 33333);
  const a2 = Math.min(Math.max(adj2Raw, 25000), 75000);

  const hc = w / 2;
  const wd8 = w / 8;
  const wd32 = w / 32;
  const x10 = w - wd8;
  const dx2 = (w * a2) / 200000;
  const x2 = hc - dx2;
  const x9 = hc + dx2;
  const x3 = x2 + wd32;
  const x8 = x9 - wd32;
  const x5 = x2 + wd8;
  const x6 = x9 - wd8;
  const x4 = x5 - wd32;
  const x7 = x6 + wd32;
  const dy1 = (h * a1) / 200000;
  const y1 = h - dy1;
  const dy2 = (h * a1) / 100000;
  const y2 = h - dy2;
  const y4 = dy2;
  const y3 = (y4 + h) / 2;
  const hR = (h * a1) / 400000;
  const y6 = h - hR;
  const y7 = y1 - hR;

  let cx: number, cy: number, arc;

  // Path 1: body fill (stroke=false)
  const p1: string[] = [];
  p1.push(`M${0},${h}`);
  p1.push(`L${x4},${h}`);
  cx = x4;
  cy = h;
  arc = ooArcTo(cx, cy, wd32, hR, 90, -180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x3},${y1}`);
  cx = x3;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 90, 180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x8},${y2}`);
  cx = x8;
  cy = y2;
  arc = ooArcTo(cx, cy, wd32, hR, 270, 180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x7},${y1}`);
  cx = x7;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 270, -180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${w},${h}`);
  p1.push(`L${x10},${y3}`);
  p1.push(`L${w},${y4}`);
  p1.push(`L${x9},${y4}`);
  p1.push(`L${x9},${hR}`);
  cx = x9;
  cy = hR;
  arc = ooArcTo(cx, cy, wd32, hR, 0, -90);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x3},${0}`);
  cx = x3;
  cy = 0;
  arc = ooArcTo(cx, cy, wd32, hR, 270, -90);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x2},${y4}`);
  p1.push(`L${0},${y4}`);
  p1.push(`L${wd8},${y3}`);
  p1.push('Z');

  // Path 2: darkenLess folds (stroke=false)
  const p2: string[] = [];
  // Left fold
  cx = x5;
  cy = y6;
  p2.push(`M${cx},${cy}`);
  arc = ooArcTo(cx, cy, wd32, hR, 0, -90);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p2.push(`L${x3},${y1}`);
  cx = x3;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 90, 180);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p2.push(`L${x5},${y2}`);
  p2.push('Z');
  // Right fold
  cx = x6;
  cy = y6;
  p2.push(`M${cx},${cy}`);
  arc = ooArcTo(cx, cy, wd32, hR, 180, 90);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p2.push(`L${x8},${y1}`);
  cx = x8;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 90, -180);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p2.push(`L${x6},${y2}`);
  p2.push('Z');

  // Path 3: outline (fill=none)
  const p3: string[] = [];
  p3.push(`M${0},${h}`);
  p3.push(`L${wd8},${y3}`);
  p3.push(`L${0},${y4}`);
  p3.push(`L${x2},${y4}`);
  p3.push(`L${x2},${hR}`);
  cx = x2;
  cy = hR;
  arc = ooArcTo(cx, cy, wd32, hR, 180, 90);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x8},${0}`);
  cx = x8;
  cy = 0;
  arc = ooArcTo(cx, cy, wd32, hR, 270, 90);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x9},${y4}`);
  p3.push(`L${w},${y4}`);
  p3.push(`L${x10},${y3}`);
  p3.push(`L${w},${h}`);
  p3.push(`L${x7},${h}`);
  cx = x7;
  cy = h;
  arc = ooArcTo(cx, cy, wd32, hR, 90, 180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x8},${y1}`);
  cx = x8;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 90, -180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x3},${y2}`);
  cx = x3;
  cy = y2;
  arc = ooArcTo(cx, cy, wd32, hR, 270, -180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x4},${y1}`);
  cx = x4;
  cy = y1;
  arc = ooArcTo(cx, cy, wd32, hR, 270, 180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push('Z');
  // Fold lines
  p3.push(`M${x5},${y2} L${x5},${y6}`);
  p3.push(`M${x6},${y6} L${x6},${y2}`);
  p3.push(`M${x2},${y7} L${x2},${y4}`);
  p3.push(`M${x9},${y4} L${x9},${y7}`);

  return [
    { d: p1.join(' '), fill: 'norm', stroke: false },
    { d: p2.join(' '), fill: 'darkenLess', stroke: false },
    { d: p3.join(' '), fill: 'none', stroke: true },
  ];
});

// --- horizontalScroll (OOXML spec: 3 paths with arcTo) ---
multiPathPresets.set('horizontalscroll', (w, h, adjustments) => {
  const adjVal = adjustments?.get('adj') ?? 12500;
  const a = Math.min(Math.max(adjVal, 0), 25000);
  const ss = Math.min(w, h);
  const ch = (ss * a) / 100000;
  const ch2 = ch / 2;
  const ch4 = ch / 4;

  const y3 = ch + ch2;
  const y4 = ch + ch;
  const y6 = h - ch;
  const y7 = h - ch2;
  const y5 = y6 - ch2;
  const x3 = w - ch;
  const x4 = w - ch2;

  // Path 1: main fill (stroke=false)
  const p1: string[] = [];
  let cx: number, cy: number;
  // moveTo (r, ch2) = (w, ch2)
  cx = w;
  cy = ch2;
  p1.push(`M${cx},${cy}`);
  // arcTo wR=ch2 hR=ch2 stAng=0 swAng=cd4(90°)
  let arc = ooArcTo(cx, cy, ch2, ch2, 0, 90);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  // lnTo (x4, ch2) — but after the arc we should be at (x4, 0)… wait
  // Actually: arcTo from (w, ch2) with stAng=0 swAng=90° → center=(w-ch2, ch2), end=(w-ch2, 0)=x4,0
  // Then lnTo (x4, ch2)... hmm, this goes from top-right curl area
  // Let me re-read: lnTo pt x="x4" y="ch2"... that doesn't match. Wait, the lnTo goes DOWN.
  // After arc: we're at (x4, 0). lnTo (x4, ch2):
  p1.push(`L${x4},${ch2}`);
  // arcTo wR=ch4 hR=ch4 stAng=0 swAng=cd2(180°)
  arc = ooArcTo(x4, ch2, ch4, ch4, 0, 180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  // lnTo (x3, ch)
  p1.push(`L${x3},${ch}`);
  // lnTo (ch2, ch)
  p1.push(`L${ch2},${ch}`);
  // arcTo wR=ch2 hR=ch2 stAng=3cd4(270°) swAng=-5400000(-90°)
  cx = ch2;
  cy = ch;
  arc = ooArcTo(cx, cy, ch2, ch2, 270, -90);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  // lnTo (0, y7)
  p1.push(`L${0},${y7}`);
  // arcTo wR=ch2 hR=ch2 stAng=cd2(180°) swAng=-10800000(-180°)
  cx = 0;
  cy = y7;
  arc = ooArcTo(cx, cy, ch2, ch2, 180, -180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  // lnTo (ch, y6)
  p1.push(`L${ch},${y6}`);
  // lnTo (x4, y6)
  p1.push(`L${x4},${y6}`);
  // arcTo wR=ch2 hR=ch2 stAng=cd4(90°) swAng=-5400000(-90°)
  cx = x4;
  cy = y6;
  arc = ooArcTo(cx, cy, ch2, ch2, 90, -90);
  p1.push(arc.svg);
  p1.push('Z');

  // Sub-path 2 in Path 1: left bottom curl circle
  cx = ch2;
  cy = y4;
  p1.push(`M${cx},${cy}`);
  // arcTo wR=ch2 hR=ch2 stAng=cd4(90°) swAng=-5400000(-90°)
  arc = ooArcTo(cx, cy, ch2, ch2, 90, -90);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  // arcTo wR=ch4 hR=ch4 stAng=0 swAng=-10800000(-180°)
  arc = ooArcTo(cx, cy, ch4, ch4, 0, -180);
  p1.push(arc.svg);
  p1.push('Z');

  // Path 2: darkenLess fill (stroke=false) — shadow areas
  const p2: string[] = [];
  // Sub-path 1: same as path1 sub-path2 (left bottom curl)
  cx = ch2;
  cy = y4;
  p2.push(`M${cx},${cy}`);
  arc = ooArcTo(cx, cy, ch2, ch2, 90, -90);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  arc = ooArcTo(cx, cy, ch4, ch4, 0, -180);
  p2.push(arc.svg);
  p2.push('Z');
  // Sub-path 2: right top curl
  cx = x4;
  cy = ch;
  p2.push(`M${cx},${cy}`);
  // arcTo wR=ch2 hR=ch2 stAng=cd4(90°) swAng=-16200000(-270°)
  arc = ooArcTo(cx, cy, ch2, ch2, 90, -270);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  // arcTo wR=ch4 hR=ch4 stAng=cd2(180°) swAng=-10800000(-180°)
  arc = ooArcTo(cx, cy, ch4, ch4, 180, -180);
  p2.push(arc.svg);
  p2.push('Z');

  // Path 3: stroke-only detail lines (fill=none)
  const p3: string[] = [];
  // Sub-path 1: left side detail
  cx = 0;
  cy = y3;
  p3.push(`M${cx},${cy}`);
  arc = ooArcTo(cx, cy, ch2, ch2, 180, 90);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x3},${ch}`);
  p3.push(`L${x3},${ch2}`);
  cx = x3;
  cy = ch2;
  arc = ooArcTo(cx, cy, ch2, ch2, 180, 180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${w},${y5}`);
  cx = w;
  cy = y5;
  arc = ooArcTo(cx, cy, ch2, ch2, 0, 90);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${ch},${y6}`);
  p3.push(`L${ch},${y7}`);
  cx = ch;
  cy = y7;
  arc = ooArcTo(cx, cy, ch2, ch2, 0, 180);
  p3.push(arc.svg);
  p3.push('Z');

  // Sub-path 2: top-right connector
  p3.push(`M${x3},${ch}`);
  p3.push(`L${x4},${ch}`);
  cx = x4;
  cy = ch;
  arc = ooArcTo(cx, cy, ch2, ch2, 90, -90);
  p3.push(arc.svg);

  // Sub-path 3: right curl inner detail
  p3.push(`M${x4},${ch}`);
  p3.push(`L${x4},${ch2}`);
  cx = x4;
  cy = ch2;
  arc = ooArcTo(cx, cy, ch4, ch4, 0, 180);
  p3.push(arc.svg);

  // Sub-path 4: left curl inner detail
  p3.push(`M${ch2},${y4}`);
  p3.push(`L${ch2},${y3}`);
  cx = ch2;
  cy = y3;
  arc = ooArcTo(cx, cy, ch4, ch4, 180, 180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  arc = ooArcTo(cx, cy, ch2, ch2, 0, 180);
  p3.push(arc.svg);

  // Sub-path 5: vertical divider
  p3.push(`M${ch},${y3}`);
  p3.push(`L${ch},${y6}`);

  return [
    { d: p1.join(' '), fill: 'norm', stroke: false },
    { d: p2.join(' '), fill: 'darkenLess', stroke: false },
    { d: p3.join(' '), fill: 'none', stroke: true },
  ];
});

// --- verticalScroll (OOXML spec: 3 paths with arcTo) ---
multiPathPresets.set('verticalscroll', (w, h, adjustments) => {
  const adjVal = adjustments?.get('adj') ?? 12500;
  const a = Math.min(Math.max(adjVal, 0), 25000);
  const ss = Math.min(w, h);
  const ch = (ss * a) / 100000;
  const ch2 = ch / 2;
  const ch4 = ch / 4;

  const x3 = ch + ch2;
  const x4 = ch + ch;
  const x6 = w - ch;
  const x7 = w - ch2;
  const _x5 = x6 - ch2;
  const y3 = h - ch;
  const y4 = h - ch2;

  // Path 1: main fill (stroke=false)
  const p1: string[] = [];
  let cx: number, cy: number;
  cx = ch2;
  cy = h;
  p1.push(`M${cx},${cy}`);
  let arc = ooArcTo(cx, cy, ch2, ch2, 90, -90);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${ch2},${y4}`);
  cx = ch2;
  cy = y4;
  arc = ooArcTo(cx, cy, ch4, ch4, 90, -180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${ch},${y3}`);
  p1.push(`L${ch},${ch2}`);
  cx = ch;
  cy = ch2;
  arc = ooArcTo(cx, cy, ch2, ch2, 180, 90);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x7},${0}`);
  cx = x7;
  cy = 0;
  arc = ooArcTo(cx, cy, ch2, ch2, 270, 180);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p1.push(`L${x6},${ch}`);
  p1.push(`L${x6},${y4}`);
  cx = x6;
  cy = y4;
  arc = ooArcTo(cx, cy, ch2, ch2, 0, 90);
  p1.push(arc.svg);
  p1.push('Z');

  // Sub-path 2: top-right curl circle
  cx = x4;
  cy = ch2;
  p1.push(`M${cx},${cy}`);
  arc = ooArcTo(cx, cy, ch2, ch2, 0, 90);
  p1.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  arc = ooArcTo(cx, cy, ch4, ch4, 90, 180);
  p1.push(arc.svg);
  p1.push('Z');

  // Path 2: darkenLess fill (stroke=false)
  const p2: string[] = [];
  cx = x4;
  cy = ch2;
  p2.push(`M${cx},${cy}`);
  arc = ooArcTo(cx, cy, ch2, ch2, 0, 90);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  arc = ooArcTo(cx, cy, ch4, ch4, 90, 180);
  p2.push(arc.svg);
  p2.push('Z');

  cx = ch;
  cy = y4;
  p2.push(`M${cx},${cy}`);
  arc = ooArcTo(cx, cy, ch2, ch2, 0, 270);
  p2.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  arc = ooArcTo(cx, cy, ch4, ch4, 270, 180);
  p2.push(arc.svg);
  p2.push('Z');

  // Path 3: stroke-only detail lines (fill=none)
  const p3: string[] = [];
  cx = ch;
  cy = y3;
  p3.push(`M${cx},${cy}`);
  p3.push(`L${ch},${ch2}`);
  cx = ch;
  cy = ch2;
  arc = ooArcTo(cx, cy, ch2, ch2, 180, 90);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x7},${0}`);
  cx = x7;
  cy = 0;
  arc = ooArcTo(cx, cy, ch2, ch2, 270, 180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x6},${ch}`);
  p3.push(`L${x6},${y4}`);
  cx = x6;
  cy = y4;
  arc = ooArcTo(cx, cy, ch2, ch2, 0, 90);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${ch2},${h}`);
  cx = ch2;
  cy = h;
  arc = ooArcTo(cx, cy, ch2, ch2, 90, 180);
  p3.push(arc.svg);
  p3.push('Z');

  // top curl
  p3.push(`M${x3},${0}`);
  cx = x3;
  cy = 0;
  arc = ooArcTo(cx, cy, ch2, ch2, 270, 180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  arc = ooArcTo(cx, cy, ch4, ch4, 90, 180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${x4},${ch2}`);

  // horizontal divider
  p3.push(`M${x6},${ch}`);
  p3.push(`L${x3},${ch}`);

  // bottom-left curl detail
  p3.push(`M${ch2},${y3}`);
  cx = ch2;
  cy = y3;
  arc = ooArcTo(cx, cy, ch4, ch4, 270, 180);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${ch},${y4}`);

  // bottom curl
  p3.push(`M${ch2},${h}`);
  cx = ch2;
  cy = h;
  arc = ooArcTo(cx, cy, ch2, ch2, 90, -90);
  p3.push(arc.svg);
  cx = arc.x;
  cy = arc.y;
  p3.push(`L${ch},${y3}`);

  return [
    { d: p1.join(' '), fill: 'norm', stroke: false },
    { d: p2.join(' '), fill: 'darkenLess', stroke: false },
    { d: p3.join(' '), fill: 'none', stroke: true },
  ];
});

/**
 * Get multi-path preset sub-paths for a shape type.
 * Returns null if the shape is not a multi-path preset (use getPresetShapePath instead).
 */
export function getMultiPathPreset(
  shapeType: string,
  w: number,
  h: number,
  adjustments?: Map<string, number>,
): PresetSubPath[] | null {
  const key = shapeType.toLowerCase();
  const gen = multiPathPresets.get(key) ?? multiPathPresets.get(shapeType);
  return gen ? gen(w, h, adjustments) : null;
}

export function getPresetShapePath(
  shapeType: string,
  w: number,
  h: number,
  adjustments?: Map<string, number>,
): string {
  // <a:prstGeom prst="textNoShape"> means text-only shape without geometry.
  if (shapeType === 'textNoShape' || shapeType.toLowerCase() === 'textnoshape') return '';
  // OOXML preset names are often camelCase; normalize to lowercase for lookup
  const key = shapeType.toLowerCase();
  const generator = presetShapes.get(key) ?? presetShapes.get(shapeType);
  if (generator) {
    return generator(w, h, adjustments);
  }
  // Fallback: simple rectangle
  console.warn(`Unknown preset shape: "${shapeType}", falling back to rectangle`);
  return `M0,0 L${w},0 L${w},${h} L0,${h} Z`;
}
