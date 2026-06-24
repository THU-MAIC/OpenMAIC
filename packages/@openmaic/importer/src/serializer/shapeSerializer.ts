/**
 * Shape serializer — mirrors `pptx-renderer-main/src/renderer/ShapeRenderer.renderShape` control flow
 * and naming, but emits pptxtojson `Shape` / `Text` objects (`adapter/types.ts`) instead of DOM.
 */

import type { ShapeNodeData, LineEndInfo, TextBody } from '../model/nodes/ShapeNode';
import type { PlaceholderInfo } from '../model/nodes/BaseNode';
import type { RenderContext } from './RenderContext';
import {
  resolveFill,
  resolveLineStyle,
  resolveGradientStroke,
  resolveGradientFill,
  resolveColorToCss,
  resolveColor,
  resolveThemeFillReference,
  type GradientFillData,
} from './StyleResolver';
import { renderTextBody, findPlaceholderNode, type RenderTextBodyOptions } from './textSerializer';
import { renderCustomGeometry } from '../shapes/customGeometry';
import { getPresetShapePath, getMultiPathPreset, type PresetSubPath } from '../shapes/presets';
import { emuToPt } from '../parser/units';
import { hexToRgb, rgbToHex } from '../utils/color';
import { SafeXmlNode } from '../parser/XmlParser';
import { resolveRelTarget } from '../parser/RelParser';
import { resolveMediaToUrl } from '../utils/mediaWebConvert';
import { isAllowedExternalUrl } from '../utils/urlSafety';
import { lineStyleToBorder, type BorderResult } from './borderMapper';
import type { AutoFit, Fill, GradientFill, ImageFill, Shadow, Shape, Text } from '../adapter/types';

// ---------------------------------------------------------------------------
// Units (shape positions/sizes are in px in node; JSON uses pt)
// ---------------------------------------------------------------------------

const PX_TO_PT = 0.75;

function pxToPt(px: number): number {
  return Number((px * PX_TO_PT).toFixed(4));
}

// ---------------------------------------------------------------------------
// Shape blipFill (image fill) — resolve to base64 for JSON (renderer uses blob URL)
// ---------------------------------------------------------------------------

/** Resolve blip opacity from alphaModFix / alphaMod / alphaOff modifiers. */
function resolveBlipOpacity(blip: SafeXmlNode): number {
  let alpha = 1;
  const alphaModFix = blip.child('alphaModFix');
  if (alphaModFix.exists()) {
    alpha *= (alphaModFix.numAttr('amt') ?? 100000) / 100000;
  }
  const alphaMod = blip.child('alphaMod');
  if (alphaMod.exists()) {
    alpha *= (alphaMod.numAttr('val') ?? 100000) / 100000;
  }
  const alphaOff = blip.child('alphaOff');
  if (alphaOff.exists()) {
    alpha += (alphaOff.numAttr('val') ?? 0) / 100000;
  }
  return Math.max(0, Math.min(1, alpha));
}

/** Resolve shape blipFill to embedded image data + opacity for JSON. */
async function resolveShapeBlipFill(
  blipFill: SafeXmlNode,
  ctx: RenderContext,
): Promise<{ url: string; opacity: number } | null> {
  const blip = blipFill.child('blip');
  const embedId = blip.attr('embed') ?? blip.attr('r:embed');
  if (!embedId) return null;
  const rel = ctx.slide.rels.get(embedId);
  if (!rel) return null;
  const basePath = ctx.slide.slidePath.replace(/\/[^/]+$/, '');
  const mediaPath = resolveRelTarget(basePath, rel.target);
  const data = ctx.presentation.media.get(mediaPath);
  if (!data) return null;
  const url = await resolveMediaToUrl(mediaPath, data, ctx.mediaMode, ctx.mediaUrlCache);
  if (!url) return null;
  const opacity = resolveBlipOpacity(blip);
  return { url, opacity };
}

// ---------------------------------------------------------------------------
// Gradient stop color picker
// ---------------------------------------------------------------------------

/**
 * Pick the best visible color from gradient stops.
 * Skips fully transparent and white colors; falls back to last stop or black.
 */
function pickVisibleGradientStop(stops: Array<{ position: number; color: string }>): string {
  for (const s of stops) {
    const c = s.color.toLowerCase();
    if (c === 'transparent' || c === 'rgba(0,0,0,0)' || c === 'rgba(0, 0, 0, 0)') continue;
    // Skip colors with 0 alpha (e.g. #rrggbbaa where aa = '00', rgba(...,0))
    const rgbaMatch = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
    if (rgbaMatch) {
      const a = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
      if (a < 0.3) continue;
      const r = parseInt(rgbaMatch[1]),
        g = parseInt(rgbaMatch[2]),
        b = parseInt(rgbaMatch[3]);
      if (r > 250 && g > 250 && b > 250) continue;
      return c;
    }
    // Hex: #rgb, #rrggbb, #rrggbbaa
    if (c.startsWith('#')) {
      if (c.length === 9) {
        const aa = parseInt(c.slice(7, 9), 16);
        if (aa < 77) continue; // ~30% alpha
      }
      const hex = c.length === 4 ? c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c.slice(1, 7);
      if (hex === 'ffffff' || hex === 'fff') continue;
      return c;
    }
    return c;
  }
  return stops[stops.length - 1]?.color || '#000000';
}

// ---------------------------------------------------------------------------
// Line End Marker (Arrowhead) → SVG path helpers
// ---------------------------------------------------------------------------

interface Vec2 {
  x: number;
  y: number;
}

/** Size multiplier: sm=0.5, med=1, lg=1.5 */
function sizeMultiplier(s?: string): number {
  if (s === 'sm') return 0.5;
  if (s === 'lg') return 1.5;
  return 1;
}

/**
 * Build a filled-triangle arrowhead path at `tip` pointing in `dir`.
 * Returns SVG sub-path string (M...L...L...Z).
 */
function triangleArrowPath(
  tip: Vec2,
  dir: Vec2,
  strokeW: number,
  w?: string,
  len?: string,
): string {
  const baseW = strokeW * 3;
  const halfW = (baseW * sizeMultiplier(w)) / 2;
  const length = baseW * sizeMultiplier(len);
  const mag = Math.sqrt(dir.x * dir.x + dir.y * dir.y);
  if (mag < 1e-9) return '';
  const ux = dir.x / mag,
    uy = dir.y / mag;
  const px = -uy,
    py = ux;
  const base = { x: tip.x - ux * length, y: tip.y - uy * length };
  const p1 = { x: base.x + px * halfW, y: base.y + py * halfW };
  const p2 = { x: base.x - px * halfW, y: base.y - py * halfW };
  return `M${tip.x},${tip.y}L${p1.x},${p1.y}L${p2.x},${p2.y}Z`;
}

/**
 * Build an open-arrow (two lines, no fill) path at `tip`.
 */
function openArrowPath(tip: Vec2, dir: Vec2, strokeW: number, w?: string, len?: string): string {
  const baseW = strokeW * 3;
  const halfW = (baseW * sizeMultiplier(w)) / 2;
  const length = baseW * sizeMultiplier(len);
  const mag = Math.sqrt(dir.x * dir.x + dir.y * dir.y);
  if (mag < 1e-9) return '';
  const ux = dir.x / mag,
    uy = dir.y / mag;
  const px = -uy,
    py = ux;
  const base = { x: tip.x - ux * length, y: tip.y - uy * length };
  const p1 = { x: base.x + px * halfW, y: base.y + py * halfW };
  const p2 = { x: base.x - px * halfW, y: base.y - py * halfW };
  return `M${p1.x},${p1.y}L${tip.x},${tip.y}L${p2.x},${p2.y}`;
}

/**
 * Build a diamond arrowhead at `tip`.
 */
function diamondArrowPath(tip: Vec2, dir: Vec2, strokeW: number, w?: string, len?: string): string {
  const baseW = strokeW * 3;
  const halfW = (baseW * sizeMultiplier(w)) / 2;
  const length = baseW * sizeMultiplier(len);
  const mag = Math.sqrt(dir.x * dir.x + dir.y * dir.y);
  if (mag < 1e-9) return '';
  const ux = dir.x / mag,
    uy = dir.y / mag;
  const px = -uy,
    py = ux;
  const mid = { x: tip.x - ux * (length / 2), y: tip.y - uy * (length / 2) };
  const back = { x: tip.x - ux * length, y: tip.y - uy * length };
  return `M${tip.x},${tip.y}L${mid.x + px * halfW},${mid.y + py * halfW}L${back.x},${back.y}L${mid.x - px * halfW},${mid.y - py * halfW}Z`;
}

/**
 * Build an oval arrowhead at `tip`.
 */
function ovalArrowPath(tip: Vec2, dir: Vec2, strokeW: number, w?: string, len?: string): string {
  const baseW = strokeW * 3;
  const rw = (baseW * sizeMultiplier(w)) / 2;
  const rl = (baseW * sizeMultiplier(len)) / 2;
  const mag = Math.sqrt(dir.x * dir.x + dir.y * dir.y);
  if (mag < 1e-9) return '';
  const ux = dir.x / mag,
    uy = dir.y / mag;
  const cx = tip.x - ux * rl,
    cy = tip.y - uy * rl;
  return `M${cx + rw},${cy}A${rw},${rl} 0 1,1 ${cx - rw},${cy}A${rw},${rl} 0 1,1 ${cx + rw},${cy}Z`;
}

function buildArrowPath(
  type: string,
  tip: Vec2,
  dir: Vec2,
  strokeW: number,
  w?: string,
  len?: string,
): string {
  switch (type) {
    case 'triangle':
      return triangleArrowPath(tip, dir, strokeW, w, len);
    case 'arrow':
      return openArrowPath(tip, dir, strokeW, w, len);
    case 'stealth':
      return triangleArrowPath(tip, dir, strokeW, w, len);
    case 'diamond':
      return diamondArrowPath(tip, dir, strokeW, w, len);
    case 'oval':
      return ovalArrowPath(tip, dir, strokeW, w, len);
    default:
      return triangleArrowPath(tip, dir, strokeW, w, len);
  }
}

/**
 * Parse a simple SVG path to extract its start and end points + directions.
 * Handles M...L (lines) and M...A (arcs).
 */
function extractPathEndpoints(d: string): {
  start: Vec2;
  end: Vec2;
  startDir: Vec2;
  endDir: Vec2;
} | null {
  const nums = d.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!nums || nums.length < 4) return null;

  const cmds = d.match(/[MLAQCSTHVZ]/gi) || [];
  const allNums = nums.map(Number);

  const startX = allNums[0],
    startY = allNums[1];

  if (/A/i.test(d)) {
    // Arc: M sx,sy A rx,ry rotation largeArc sweep ex,ey
    const aIdx = d.search(/A/i);
    const afterA = d.slice(aIdx + 1);
    const aNums = afterA.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
    if (!aNums || aNums.length < 7) return null;
    const rx = Number(aNums[0]),
      ry = Number(aNums[1]);
    const sweep = Number(aNums[4]);
    const ex = Number(aNums[5]),
      ey = Number(aNums[6]);
    // For circle (rx≈ry), tangent ⊥ radius.  For ellipse, approximate.
    const cx = (startX + ex) / 2,
      cy = (startY + ey) / 2;
    // Better: compute actual center from arc parameters
    const arcCenter = computeArcCenter(startX, startY, ex, ey, rx, ry, 0, Number(aNums[3]), sweep);
    const acx = arcCenter?.cx ?? cx,
      acy = arcCenter?.cy ?? cy;

    // startDir points BACKWARD (opposite travel) — consistent with line convention.
    // endDir points FORWARD (travel direction).
    const rsx = startX - acx,
      rsy = startY - acy;
    const startDir = sweep ? { x: rsy, y: -rsx } : { x: -rsy, y: rsx };
    const rex = ex - acx,
      rey = ey - acy;
    const endDir = sweep ? { x: -rey, y: rex } : { x: rey, y: -rex };

    return { start: { x: startX, y: startY }, end: { x: ex, y: ey }, startDir, endDir };
  }

  // Simple line: M sx,sy L ex,ey (possibly with more L points)
  const ex = allNums[allNums.length - 2],
    ey = allNums[allNums.length - 1];
  const dir = { x: ex - startX, y: ey - startY };
  return {
    start: { x: startX, y: startY },
    end: { x: ex, y: ey },
    startDir: { x: -dir.x, y: -dir.y },
    endDir: dir,
  };
}

/**
 * Compute the center of an SVG arc given endpoints and radii.
 * Simplified: works well for circular arcs and reasonable ellipses.
 */
function computeArcCenter(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rx: number,
  ry: number,
  _rotation: number,
  largeArc: number,
  sweep: number,
): { cx: number; cy: number } | null {
  // Normalize to unit circle space
  const dx = (x1 - x2) / 2,
    dy = (y1 - y2) / 2;
  const mx = (x1 + x2) / 2,
    my = (y1 + y2) / 2;
  const dxn = dx / rx,
    dyn = dy / ry;
  const dsq = dxn * dxn + dyn * dyn;
  if (dsq >= 1) return null;
  const s = Math.sqrt(Math.max(0, (1 - dsq) / dsq));
  const sign = largeArc === sweep ? -1 : 1;
  const cxn = sign * s * (dy / ry);
  const cyn = -sign * s * (dx / rx);
  return { cx: mx + cxn * rx, cy: my + cyn * ry };
}

/**
 * Append arrowhead geometry to an existing SVG path string.
 * Mutates nothing; returns the new path with arrow sub-paths appended.
 */
function appendArrowsToPath(
  pathD: string,
  headEnd: LineEndInfo | undefined,
  tailEnd: LineEndInfo | undefined,
  strokeWidthPx: number,
): string {
  if (!pathD || (!headEnd && !tailEnd)) return pathD;
  const ep = extractPathEndpoints(pathD);
  if (!ep) return pathD;

  // group 内子元素的 a:off/ext 用 group local 坐标（非 EMU），但 BaseNode 当 EMU
  // 处理后 size 极小（亚像素级），customGeometry 输出的 path 也是亚像素量级。
  // 而 strokeWidthPx 来自 a:ln/@w，是绝对 px 量级。两者单位不匹配时，箭头基底
  // (length = strokeW * 3) 远大于 path 跨度，groupSerializer 后续 scaleSvgPath
  // 又把含箭头的 path 整体放大 group 缩放比 (常见 1000+ 倍)，结果箭头端点会被
  // 放大到几千 pt 远离画布。
  //
  // 防御：当 baseArrowLen 与 path 跨度严重不匹配时（典型 sub-pixel 子元素），
  // 把 arrow 长度限制到 path 跨度的 ~15%。比例选择基于实测：FP-tree 类
  // 场景中 path 末端通常落在目标节点 box 中心（被 box 部分遮挡），箭头
  // 太小 (<10%) 会整段藏进 box 看不见；太大 (>30%) 又显得突兀。15% 经
  // 用户视觉验证最接近 PowerPoint / WPS 原生渲染。正常 px 量级的 path
  // 不会触发此分支 (baseArrowLen=3 远小于 pathSpan*0.15 当 pathSpan>20)。
  const pathSpan = Math.max(Math.abs(ep.end.x - ep.start.x), Math.abs(ep.end.y - ep.start.y));
  const baseArrowLen = strokeWidthPx * 3;
  let effectiveStrokeWidth = strokeWidthPx;
  if (pathSpan > 0 && baseArrowLen > pathSpan * 0.15) {
    effectiveStrokeWidth = (pathSpan * 0.15) / 3;
  }

  const parts = [pathD];
  if (headEnd) {
    const arrow = buildArrowPath(
      headEnd.type,
      ep.start,
      ep.startDir,
      effectiveStrokeWidth,
      headEnd.w ?? undefined,
      headEnd.len ?? undefined,
    );
    if (arrow) parts.push(' ' + arrow);
  }
  if (tailEnd) {
    const arrow = buildArrowPath(
      tailEnd.type,
      ep.end,
      ep.endDir,
      effectiveStrokeWidth,
      tailEnd.w ?? undefined,
      tailEnd.len ?? undefined,
    );
    if (arrow) parts.push(' ' + arrow);
  }
  return parts.join('');
}

/** True if the text body has at least one non-empty run (avoids covering shapes with empty placeholder text). */
function hasVisibleText(textBody: TextBody): boolean {
  for (const p of textBody.paragraphs) {
    for (const r of p.runs) {
      if (r.text != null && r.text.trim().length > 0) return true;
    }
  }
  return false;
}

function svgDashArrayForKind(dashKind: string, strokeWidth: number): string | null {
  const w = Math.max(strokeWidth, 1);
  switch (dashKind) {
    case 'dot':
    case 'sysDot':
      return `${w},${w * 2}`;
    case 'dash':
    case 'sysDash':
      return `${w * 4},${w * 2}`;
    case 'lgDash':
      return `${w * 8},${w * 3}`;
    case 'dashDot':
    case 'sysDashDot':
      return `${w * 4},${w * 2},${w},${w * 2}`;
    case 'lgDashDot':
      return `${w * 8},${w * 3},${w},${w * 3}`;
    case 'lgDashDotDot':
    case 'sysDashDotDot':
      return `${w * 8},${w * 3},${w},${w * 2},${w},${w * 2}`;
    default:
      return null;
  }
}

function parseCssColorToRgba(
  color: string,
): { r: number; g: number; b: number; a?: number } | null {
  if (!color) return null;
  const hex = color.trim();
  if (hex.startsWith('#')) {
    return hexToRgb(hex);
  }
  const m = hex.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const parts = m[1].split(',').map((s) => Number.parseFloat(s.trim()));
  if (parts.length < 3 || parts.some((v) => Number.isNaN(v))) return null;
  const result: { r: number; g: number; b: number; a?: number } = {
    r: Math.max(0, Math.min(255, parts[0])),
    g: Math.max(0, Math.min(255, parts[1])),
    b: Math.max(0, Math.min(255, parts[2])),
  };
  if (parts.length >= 4 && parts[3] < 1) {
    result.a = parts[3];
  }
  return result;
}

/** Read headEnd/tailEnd from an OOXML a:ln node (e.g. theme line style). */
function getLineEndsFromLn(ln: SafeXmlNode): { headEnd?: LineEndInfo; tailEnd?: LineEndInfo } {
  const out: { headEnd?: LineEndInfo; tailEnd?: LineEndInfo } = {};
  const he = ln.child('headEnd');
  if (he.exists()) {
    const t = he.attr('type');
    if (t && t !== 'none') out.headEnd = { type: t, w: he.attr('w'), len: he.attr('len') };
  }
  const te = ln.child('tailEnd');
  if (te.exists()) {
    const t = te.attr('type');
    if (t && t !== 'none') out.tailEnd = { type: t, w: te.attr('w'), len: te.attr('len') };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fill → adapter/types.Fill (no fillMapper — aligned with StyleResolver + ShapeRenderer)
// ---------------------------------------------------------------------------

function ensureHex(color: string): string {
  const s = color.trim();
  if (s.startsWith('#')) return s;
  return `#${s}`;
}

/** Convert structured gradient data to pptxtojson `GradientFill.value` (same mapping as former fillMapper). */
function gradientFillDataToValue(data: GradientFillData): GradientFill['value'] {
  const path: GradientFill['value']['path'] =
    data.type === 'linear'
      ? 'line'
      : data.pathType === 'rect'
        ? 'rect'
        : data.pathType === 'circle' || data.pathType === 'shape'
          ? (data.pathType as 'circle' | 'shape')
          : 'circle';
  const rot = data.type === 'linear' ? data.angle : 0;
  const colors = data.stops.map((s) => ({
    pos: `${s.position.toFixed(1)}%`,
    color: cssColorToFillHex(s.color),
  }));
  return { path, rot, colors };
}

function cssColorToFillHex(css: string): string {
  const s = css.trim();
  if (s === 'transparent' || s === 'none') return 'transparent';
  if (s.startsWith('#')) {
    if (s.length === 4) {
      const r = s[1];
      const g = s[2];
      const b = s[3];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    return s;
  }
  const rgba = parseCssColorToRgba(s);
  if (rgba) {
    const hex = rgbToHex(rgba.r, rgba.g, rgba.b);
    if (rgba.a !== undefined) {
      const alphaHex = Math.round(rgba.a * 255)
        .toString(16)
        .padStart(2, '0');
      return `${hex}${alphaHex}`;
    }
    return hex;
  }
  return '#000000';
}

function patternFillToFill(pattFill: SafeXmlNode, ctx: RenderContext): Fill {
  const preset = pattFill.attr('prst') ?? 'solid';
  let foregroundColor = '#000000';
  let backgroundColor = '#ffffff';
  const fgClr = pattFill.child('fgClr');
  if (fgClr.exists()) {
    const { color } = resolveColor(fgClr, ctx);
    foregroundColor = ensureHex(color);
  }
  const bgClr = pattFill.child('bgClr');
  if (bgClr.exists()) {
    const { color } = resolveColor(bgClr, ctx);
    backgroundColor = ensureHex(color);
  }
  return {
    type: 'pattern',
    value: { type: preset, foregroundColor, backgroundColor },
  };
}

/**
 * Build `Fill` after the same fillCss / gradientFillData / line-like rules as ShapeRenderer.
 */
async function fillToJson(
  spPr: SafeXmlNode,
  ctx: RenderContext,
  fillCss: string,
  gradientFillData: GradientFillData | null,
  isLineLike: boolean,
): Promise<Fill> {
  if (isLineLike) {
    return { type: 'color', value: 'transparent' };
  }

  const blipFill = spPr.child('blipFill');
  if (blipFill.exists()) {
    const blipResult = await resolveShapeBlipFill(blipFill, ctx);
    if (blipResult) {
      const imageFill: ImageFill = {
        type: 'image',
        value: { picBase64: blipResult.url, opacity: blipResult.opacity },
      };
      return imageFill;
    }
  }

  if (gradientFillData && gradientFillData.stops.length > 0) {
    return { type: 'gradient', value: gradientFillDataToValue(gradientFillData) };
  }

  if (fillCss && fillCss !== 'transparent' && fillCss !== 'none') {
    if (!fillCss.includes('gradient')) {
      return { type: 'color', value: cssColorToFillHex(fillCss) };
    }
    const again = resolveGradientFill(spPr, ctx);
    if (again && again.stops.length > 0) {
      return { type: 'gradient', value: gradientFillDataToValue(again) };
    }
  }

  const pattFill = spPr.child('pattFill');
  if (pattFill.exists()) {
    return patternFillToFill(pattFill, ctx);
  }

  const solidFill = spPr.child('solidFill');
  if (solidFill.exists()) {
    const { color } = resolveColor(solidFill, ctx);
    return { type: 'color', value: ensureHex(color) };
  }

  const grpFill = spPr.child('grpFill');
  if (grpFill.exists()) {
    // PowerPoint composites grpFill children with the group; painting the parent
    // fill on each child (e.g. master logo dot row) draws duplicate visible shapes.
    return { type: 'color', value: 'transparent' };
  }

  const noFill = spPr.child('noFill');
  if (noFill.exists()) {
    return { type: 'color', value: 'transparent' };
  }

  return { type: 'color', value: 'transparent' };
}

// ---------------------------------------------------------------------------
// Shadow + link (mirror ShapeRenderer tail sections)
// ---------------------------------------------------------------------------

function resolveShapeShadow(
  node: ShapeNodeData,
  spPr: SafeXmlNode,
  ctx: RenderContext,
): Shadow | undefined {
  let effectiveEffectLst = spPr.child('effectLst');
  if (!effectiveEffectLst.exists()) {
    const effectRef = node.source.child('style').child('effectRef');
    const idx = effectRef.numAttr('idx') ?? 0;
    if (idx > 0 && (ctx.theme.effectStyles?.length ?? 0) >= idx) {
      const themeEffect = ctx.theme.effectStyles[idx - 1];
      if (themeEffect.exists()) {
        const lst = themeEffect.child('effectLst');
        if (lst.exists()) effectiveEffectLst = lst;
      }
    }
  }

  if (!effectiveEffectLst.exists()) return undefined;

  let shdNode = effectiveEffectLst.child('outerShdw');
  let isInner = false;
  if (!shdNode.exists()) {
    shdNode = effectiveEffectLst.child('innerShdw');
    if (shdNode.exists()) isInner = true;
  }
  if (!shdNode.exists()) return undefined;

  const dir = shdNode.numAttr('dir') ?? 0;
  const dist = shdNode.numAttr('dist') ?? 0;
  const blurRad = shdNode.numAttr('blurRad') ?? 0;
  const dirDeg = dir / 60000;
  const distPt = emuToPt(dist);
  const blurPt = emuToPt(blurRad);
  const h = isInner ? 0 : distPt * Math.cos((dirDeg * Math.PI) / 180);
  const v = isInner ? 0 : distPt * Math.sin((dirDeg * Math.PI) / 180);

  let color = 'rgba(0,0,0,0.4)';
  const { color: shdColor, alpha: shdAlpha } = resolveColor(shdNode, ctx);
  if (shdColor) {
    const hex = shdColor.startsWith('#') ? shdColor : `#${shdColor}`;
    const { r: sr, g: sg, b: sb } = hexToRgb(hex);
    color = `rgba(${sr},${sg},${sb},${shdAlpha.toFixed(3)})`;
  }

  return { h, v, blur: blurPt, color, ...(isInner ? { inset: true } : {}) } as Shadow;
}

function resolveShapeLink(node: ShapeNodeData, ctx: RenderContext): string | undefined {
  const h = node.hlinkClick;
  if (!h) return undefined;
  const { action, rId } = h;
  if (action === 'ppaction://hlinksldjump' && rId) {
    const rel = ctx.slide.rels.get(rId);
    if (rel) {
      const match = rel.target.match(/slide(\d+)\.xml/i);
      if (match) return `#slide-${match[1]}`;
    }
  } else if (rId) {
    const rel = ctx.slide.rels.get(rId);
    if (rel && rel.targetMode === 'External' && isAllowedExternalUrl(rel.target)) {
      return rel.target;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Text / bodyPr helpers (align with ShapeRenderer text overlay)
// ---------------------------------------------------------------------------

function getVAlignFromBodyPr(
  bodyPr: SafeXmlNode | undefined,
  fallbackBp: SafeXmlNode | undefined,
): string {
  const anchor =
    (bodyPr ? bodyPr.attr('anchor') : null) || (fallbackBp ? fallbackBp.attr('anchor') : null);
  if (anchor === 'ctr' || anchor === 'mid' || anchor === 'middle') return 'mid';
  if (anchor === 'b' || anchor === 'bottom') return 'down';
  return 'up';
}

function getIsVertical(
  bodyPr: SafeXmlNode | undefined,
  fallbackBp: SafeXmlNode | undefined,
): boolean {
  const vert =
    (bodyPr ? bodyPr.attr('vert') : null) || (fallbackBp ? fallbackBp.attr('vert') : null);
  return vert === 'eaVert' || vert === 'vert' || vert === 'wordArtVert' || vert === 'vert270';
}

function computeAutoFit(textBody: TextBody | undefined): AutoFit | undefined {
  if (!textBody?.bodyProperties) return undefined;
  const bp = textBody.bodyProperties;
  if (bp.child('spAutoFit').exists()) {
    return { type: 'shape' };
  }
  const norm = bp.child('normAutofit');
  if (norm.exists()) {
    const fs = norm.numAttr('fontScale');
    if (fs !== undefined) {
      return { type: 'text', fontScale: fs / 1000 };
    }
    return { type: 'text' };
  }
  return undefined;
}

/**
 * Resolve fill from layout or master placeholder when the slide shape has no explicit fill.
 * Checks if the shape's spPr explicitly declares <a:noFill/> — if so, returns null (transparent).
 * Otherwise falls back to layout placeholder spPr, then master placeholder spPr.
 */
function resolveInheritedPlaceholderFill(
  placeholder: PlaceholderInfo,
  slideSpPr: SafeXmlNode,
  ctx: RenderContext,
): { fillCss: string; gradientFillData: GradientFillData | null } | null {
  // If shape explicitly opted out of fill, respect it
  if (slideSpPr.child('noFill').exists()) return null;

  // Try layout placeholder first, then master placeholder
  const sources: SafeXmlNode[] = [];
  const layoutPh = findPlaceholderNode(
    ctx.layout.placeholders.map((e) => e.node),
    placeholder,
  );
  if (layoutPh) sources.push(layoutPh);
  const masterPh = findPlaceholderNode(ctx.master.placeholders, placeholder);
  if (masterPh) sources.push(masterPh);

  for (const phNode of sources) {
    const phSpPr = phNode.child('spPr');
    if (!phSpPr.exists()) continue;

    // Check solidFill
    const solidFill = phSpPr.child('solidFill');
    if (solidFill.exists()) {
      const colorChild = solidFill.child('srgbClr').exists()
        ? solidFill.child('srgbClr')
        : solidFill.child('schemeClr').exists()
          ? solidFill.child('schemeClr')
          : solidFill.child('scrgbClr').exists()
            ? solidFill.child('scrgbClr')
            : solidFill.child('sysClr').exists()
              ? solidFill.child('sysClr')
              : undefined;
      if (colorChild?.exists()) {
        return { fillCss: resolveColorToCss(colorChild, ctx), gradientFillData: null };
      }
    }

    // Check gradFill
    const gradFill = phSpPr.child('gradFill');
    if (gradFill.exists()) {
      const css = resolveFill(phSpPr, ctx);
      const gradData = resolveGradientFill(phSpPr, ctx);
      if (css || gradData) return { fillCss: css, gradientFillData: gradData };
    }

    // Check blipFill (image fill)
    const blipFill = phSpPr.child('blipFill');
    if (blipFill.exists()) {
      const css = resolveFill(phSpPr, ctx);
      if (css) return { fillCss: css, gradientFillData: null };
    }

    // Check pattFill (pattern fill)
    const pattFill = phSpPr.child('pattFill');
    if (pattFill.exists()) {
      const css = resolveFill(phSpPr, ctx);
      if (css) return { fillCss: css, gradientFillData: null };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shape Rendering → JSON (same structure as ShapeRenderer.renderShape)
// ---------------------------------------------------------------------------

/**
 * Serialize a shape node to pptxtojson `Shape` or `Text`.
 * Control flow and identifiers follow `renderShape` in `ShapeRenderer.ts`; output is JSON, not DOM.
 */
export async function renderShape(
  node: ShapeNodeData,
  ctx: RenderContext,
  _order: number,
): Promise<Shape | Text> {
  const order = node.xmlOrder;
  const left = pxToPt(node.position.x);
  const top = pxToPt(node.position.y);

  const presetKey = node.presetGeometry?.toLowerCase() ?? '';
  const outlineOnlyPresets = new Set([
    'arc',
    'leftbracket',
    'rightbracket',
    'leftbrace',
    'rightbrace',
    'bracketpair',
    'bracepair',
  ]);
  const presetIsLine =
    !!presetKey &&
    (presetKey === 'line' ||
      presetKey === 'lineinv' ||
      presetKey.includes('connector') ||
      outlineOnlyPresets.has(presetKey));
  const isConnectorShape = node.source.localName === 'cxnSp';
  // Treat sub-pixel extents as flat — some PPTX shapes use cx=1 EMU (≈0.0001px)
  // for nearly perfect vertical/horizontal lines, which still need a visible viewBox.
  const flatExtent = (node.size.w >= 1 && node.size.h < 1) || (node.size.w < 1 && node.size.h >= 1);
  const isLineLike = presetIsLine || isConnectorShape || flatExtent;
  // 判定线段方向：水平 ('h')、垂直 ('v') 或对角线 (null)。
  // 仅对 line-like preset 生效；用于决定哪一轴需要 bump。
  let lineOrient: 'h' | 'v' | null = null;
  if (isLineLike) {
    if (node.size.h === 0 || (node.size.w >= 1 && node.size.h < 1)) lineOrient = 'h';
    else if (node.size.w === 0 || (node.size.h >= 1 && node.size.w < 1)) lineOrient = 'v';
  }

  // 仅 bump 与线段方向"垂直"的那一轴，保证 SVG viewBox 非退化、stroke 可见；
  // 沿线段方向的轴不 bump，避免在 group 内被 ws/hs 放大后 bbox 异常巨大
  // （下游按 bbox 对角线渲染 line 的渲染器会把横线画成对角斜线）。
  // 当两轴都 < 1 时（对角连接符在极小子坐标系中），不做 bump——
  // group 缩放会将其放大到正确尺寸；bump 反而会被放大几百倍。
  const bothSubPixel = node.size.w < 1 && node.size.h < 1;
  const minH =
    isLineLike && node.size.h < 1 && !bothSubPixel && lineOrient !== 'v' ? 1 : node.size.h;
  const minW =
    isLineLike && node.size.w < 1 && !bothSubPixel && lineOrient !== 'h' ? 1 : node.size.w;
  const width = pxToPt(minW);
  const height = pxToPt(minH);

  // 给 preset 传 0 以保留水平/垂直方向语义，否则 bump 后的非零 h/w 会让
  // line preset 误走对角线分支。
  let pathW = width;
  let pathH = height;
  if (lineOrient === 'h') pathH = 0;
  else if (lineOrient === 'v') pathW = 0;

  const styleNode = node.source.child('style');
  const lnRef = styleNode.exists() ? styleNode.child('lnRef') : undefined;
  const fillRef = styleNode.exists() ? styleNode.child('fillRef') : undefined;

  // ---- Generate SVG path ----
  let pathD = '';
  let multiPaths: PresetSubPath[] | null = null;
  if (node.presetGeometry) {
    let effectivePreset = node.presetGeometry;
    if (isConnectorShape && effectivePreset === 'line') {
      effectivePreset = 'straightConnector1';
    }
    multiPaths = getMultiPathPreset(effectivePreset, pathW, pathH, node.adjustments);
    if (multiPaths) {
      pathD = multiPaths[0]?.d ?? '';
    } else {
      pathD = getPresetShapePath(effectivePreset, pathW, pathH, node.adjustments);
    }
  } else if (node.customGeometry) {
    const extNode = node.source.child('spPr').child('xfrm').child('ext');
    const sourceExtentEmu = {
      w: extNode.numAttr('cx') ?? 0,
      h: extNode.numAttr('cy') ?? 0,
    };
    pathD = renderCustomGeometry(node.customGeometry, pathW, pathH, sourceExtentEmu);
  }
  if (
    !pathD &&
    isLineLike &&
    (node.line?.exists() ||
      (lnRef?.exists() &&
        (lnRef.numAttr('idx') ?? 0) > 0 &&
        (ctx.theme.lineStyles?.length ?? 0) >= (lnRef.numAttr('idx') ?? 0)))
  ) {
    pathD = getPresetShapePath(
      isConnectorShape ? 'straightConnector1' : 'line',
      pathW,
      pathH,
      undefined,
    );
  }

  // ---- Resolve fill and line styles ----
  const spPr = node.source.child('spPr');
  let fillCss = '';
  let gradientFillData = node.fill ? resolveGradientFill(spPr, ctx) : null;
  if (node.fill && node.fill.exists()) {
    if (node.fill.localName === 'solidFill') {
      const colorChild = node.fill.child('srgbClr').exists()
        ? node.fill.child('srgbClr')
        : node.fill.child('schemeClr').exists()
          ? node.fill.child('schemeClr')
          : node.fill.child('scrgbClr').exists()
            ? node.fill.child('scrgbClr')
            : node.fill.child('sysClr').exists()
              ? node.fill.child('sysClr')
              : undefined;
      if (colorChild?.exists()) fillCss = resolveColorToCss(colorChild, ctx);
    }
    if (!fillCss) fillCss = resolveFill(spPr, ctx);
  }
  if (!fillCss) {
    const solidFill = spPr.child('solidFill');
    if (solidFill.exists()) {
      const colorChild = solidFill.child('srgbClr').exists()
        ? solidFill.child('srgbClr')
        : solidFill.child('schemeClr').exists()
          ? solidFill.child('schemeClr')
          : solidFill.child('scrgbClr').exists()
            ? solidFill.child('scrgbClr')
            : solidFill.child('sysClr').exists()
              ? solidFill.child('sysClr')
              : undefined;
      if (colorChild?.exists()) fillCss = resolveColorToCss(colorChild, ctx);
    }
  }
  // grpFill without a parent group context must stay unfilled — do not fall back to
  // fillRef (master logo dots use grpFill + ln/noFill; fillRef would draw hollow rings).
  const hasGrpFill = spPr.child('grpFill').exists();
  if (!fillCss && fillRef && fillRef.exists() && !hasGrpFill) {
    const resolvedThemeFill = resolveThemeFillReference(fillRef, ctx);
    fillCss = resolvedThemeFill.fillCss;
    if (!gradientFillData) gradientFillData = resolvedThemeFill.gradientFillData;
  }
  // Placeholder fill inheritance: when the slide shape has no explicit fill,
  // inherit fill from the matching layout placeholder, then master placeholder.
  if (!fillCss && !gradientFillData && node.placeholder) {
    const phFill = resolveInheritedPlaceholderFill(node.placeholder, spPr, ctx);
    if (phFill) {
      fillCss = phFill.fillCss;
      gradientFillData = phFill.gradientFillData;
    }
  }
  if (isLineLike) {
    fillCss = '';
    gradientFillData = null;
  }
  if (hasGrpFill) {
    fillCss = '';
    gradientFillData = null;
  }

  let strokeColor = 'none';
  let strokeWidth = 0;
  let strokeDash = '';
  let strokeDashKind = 'solid';
  let gradientStroke: ReturnType<typeof resolveGradientStroke> = null;

  const lineIsNoFill = node.line && node.line.child('noFill').exists();
  const hasExplicitLine = node.line && !lineIsNoFill;
  const lnRefAvailable =
    lnRef?.exists() &&
    (lnRef.numAttr('idx') ?? 0) > 0 &&
    (ctx.theme.lineStyles?.length ?? 0) >= (lnRef.numAttr('idx') ?? 0);
  // Spec-correct PowerPoint behavior: an explicit <a:ln><a:noFill/></a:ln>
  // is authoritative — the author said "no line", so the <p:style><a:lnRef>
  // theme fallback must NOT re-introduce a border. WPS used to fall back to
  // lnRef here, which is wrong for PowerPoint-authored masters (e.g. the
  // 5-dot decorations in this deck's master have <a:ln><a:noFill/></a:ln>
  // but inherit a green lnRef — PowerPoint hides them, WPS-style logic
  // would draw a green hollow ring).
  const noFillSuppressed = lineIsNoFill;
  const themeLineFromLnRef =
    !hasExplicitLine && !lineIsNoFill && lnRefAvailable
      ? ctx.theme.lineStyles![(lnRef!.numAttr('idx') ?? 1) - 1]
      : undefined;
  let effectiveLine = hasExplicitLine ? node.line! : themeLineFromLnRef;
  if (noFillSuppressed) effectiveLine = undefined;

  if (effectiveLine?.exists()) {
    gradientStroke = resolveGradientStroke(effectiveLine, ctx);
    if (!gradientStroke) {
      const lineStyle = resolveLineStyle(effectiveLine, ctx, lnRef);
      strokeColor = lineStyle.color;
      strokeWidth = lineStyle.width;
      strokeDash = lineStyle.dash;
      strokeDashKind = lineStyle.dashKind;
    }

    // Line cap / join: ShapeRenderer maps a:ln@cap and a:ln/* to SVG stroke-linecap / stroke-linejoin.
    // pptxtojson border fields omit cap/join (see adapter/types Border).
  }
  if (noFillSuppressed) {
    strokeColor = 'none';
    strokeWidth = 0;
    gradientStroke = null;
  }

  const isCircularArrow = node.presetGeometry?.toLowerCase() === 'circulararrow';
  if (isCircularArrow) {
    strokeColor = 'none';
    strokeWidth = 0;
    gradientStroke = null;
    if (!fillCss) {
      const solid = spPr.child('solidFill');
      if (solid.exists()) {
        const color = solid.child('srgbClr').exists()
          ? solid.child('srgbClr')
          : solid.child('schemeClr').exists()
            ? solid.child('schemeClr')
            : solid.child('scrgbClr').exists()
              ? solid.child('scrgbClr')
              : solid.child('sysClr').exists()
                ? solid.child('sysClr')
                : undefined;
        if (color?.exists()) fillCss = resolveColorToCss(color, ctx);
      }
    }
  }

  let effectiveHeadEnd = node.headEnd;
  let effectiveTailEnd = node.tailEnd;
  if ((!effectiveHeadEnd || !effectiveTailEnd) && effectiveLine?.exists()) {
    const fromLn = getLineEndsFromLn(effectiveLine);
    if (!effectiveHeadEnd && fromLn.headEnd) effectiveHeadEnd = fromLn.headEnd;
    if (!effectiveTailEnd && fromLn.tailEnd) effectiveTailEnd = fromLn.tailEnd;
  }

  let effectiveStrokeWidth = gradientStroke ? gradientStroke.width : strokeWidth;
  if (isLineLike && (effectiveHeadEnd || effectiveTailEnd) && effectiveStrokeWidth <= 0) {
    effectiveStrokeWidth = 1;
  }

  const mainPathStrokeSuppressed = multiPaths && multiPaths[0]?.stroke === false;

  // ---- Border JSON (stroke → pptxtojson border fields) ----
  let borderResult: BorderResult;
  if (isCircularArrow || noFillSuppressed || !effectiveLine?.exists()) {
    borderResult = {
      border: { borderColor: '#000000', borderWidth: 0, borderType: 'solid' },
      borderStrokeDasharray: '0',
    };
  } else if (!mainPathStrokeSuppressed && gradientStroke && gradientStroke.stops.length > 0) {
    const bestStop = pickVisibleGradientStop(gradientStroke.stops);
    borderResult = {
      border: {
        borderColor: cssColorToFillHex(bestStop),
        borderWidth: pxToPt(Math.max(gradientStroke.width, 1)),
        borderType: 'solid',
      },
      borderStrokeDasharray: '0',
    };
  } else if (
    !mainPathStrokeSuppressed &&
    effectiveStrokeWidth > 0 &&
    strokeColor !== 'transparent'
  ) {
    const lnNode = effectiveLine!;
    const br = lineStyleToBorder(lnNode, ctx, lnRef);
    const widthPx = effectiveStrokeWidth;
    const svgDashArray = svgDashArrayForKind(strokeDashKind, widthPx);
    let dashStr = br.borderStrokeDasharray || '';
    if (svgDashArray) {
      const parts = svgDashArray.split(',').map((x) => pxToPt(Number.parseFloat(x.trim())));
      dashStr = parts.map((x) => x.toFixed(2)).join(',');
    } else if (strokeDash === 'dashed') {
      dashStr = `${pxToPt(widthPx * 4).toFixed(2)},${pxToPt(widthPx * 2).toFixed(2)}`;
    } else if (strokeDash === 'dotted') {
      dashStr = `${pxToPt(widthPx).toFixed(2)},${pxToPt(widthPx * 2).toFixed(2)}`;
    }
    borderResult = {
      border: {
        ...br.border,
        borderWidth: pxToPt(widthPx),
      },
      borderStrokeDasharray: dashStr,
    };
  } else {
    borderResult = {
      border: { borderColor: '#000000', borderWidth: 0, borderType: 'solid' },
      borderStrokeDasharray: '0',
    };
  }

  const fillJson = await fillToJson(spPr, ctx, fillCss, gradientFillData, isLineLike);

  const shadowJson = resolveShapeShadow(node, spPr, ctx);
  const linkStr = resolveShapeLink(node, ctx);

  const placeholder = node.placeholder;
  const content = node.textBody
    ? renderTextBody(node.textBody, placeholder, ctx, textBodyRenderOptions(node, ctx))
    : '';
  const hasContent = node.textBody ? hasVisibleText(node.textBody) : false;

  const bodyPr = node.textBody?.bodyProperties;
  const fallbackBp = node.textBody?.layoutBodyProperties;
  const vAlign = getVAlignFromBodyPr(bodyPr, fallbackBp);
  const isVertical = getIsVertical(bodyPr, fallbackBp);
  const autoFit = computeAutoFit(node.textBody);

  const shapType =
    isConnectorShape && node.presetGeometry === 'line'
      ? 'straightConnector1'
      : node.presetGeometry || (node.customGeometry ? 'custom' : 'rect');

  // Integrate arrowhead geometry directly into the SVG path string.
  if (pathD && (effectiveHeadEnd || effectiveTailEnd)) {
    const arrowStrokePt = pxToPt(effectiveStrokeWidth) || 1;
    pathD = appendArrowsToPath(pathD, effectiveHeadEnd, effectiveTailEnd, arrowStrokePt);
  }

  const pathOut: string | undefined = pathD || undefined;

  // PPTist expects keypoints normalized by /50000 (OOXML raw value / 50000).
  let keypoints: Record<string, number> | undefined;
  if (node.adjustments.size > 0) {
    keypoints = {};
    for (const [k, v] of node.adjustments) {
      keypoints[k] = v / 50000;
    }
  }

  const baseCommon = {
    left,
    top,
    width,
    height,
    name: node.name || '',
    order,
    borderColor: borderResult.border.borderColor,
    borderWidth: borderResult.border.borderWidth,
    borderType: borderResult.border.borderType,
    borderStrokeDasharray: borderResult.borderStrokeDasharray || '0',
    fill: fillJson,
    isFlipV: node.flipV,
    isFlipH: node.flipH,
    rotate: node.rotation,
    content: content || '',
    ...(shadowJson ? { shadow: shadowJson } : {}),
    ...(linkStr ? { link: linkStr } : {}),
    ...(autoFit ? { autoFit } : {}),
  };

  // --- Shape vs Text type detection ---
  // Mirrors src1/pptxtojson.js logic:
  // 1. cNvSpPr@txBox="1" → text box → output as "text"
  // 2. Placeholder body/title/ctrTitle/subTitle → output as "text"
  // 3. Custom geometry (non-diagram) → shape
  // 4. Preset geometry != 'rect', or type is 'obj'/undefined → shape
  // 5. No visible text but has fill/border → shape
  // 6. Fallthrough → text
  const isTxBox = node.source.child('nvSpPr').child('cNvSpPr').attr('txBox') === '1';
  const isPlaceholderText =
    placeholder?.type === 'body' ||
    placeholder?.type === 'title' ||
    placeholder?.type === 'ctrTitle' ||
    placeholder?.type === 'subTitle';
  const hasCustomGeom = !!node.customGeometry;
  const hasPresetGeom = !!node.presetGeometry;
  const isNonRectPreset = hasPresetGeom && shapType !== 'rect';
  const noPlaceholderType = !placeholder?.type;
  const hasFillOrBorder = !!fillCss || borderResult.border.borderWidth > 0;

  let outputAsText = false;
  if (isPlaceholderText) {
    outputAsText = true;
  } else if (isTxBox) {
    // 普通 txBox（rect 几何）按 text 输出；但若作者把 txBox 改成 roundRect /
    // ellipse 等非 rect 几何用作徽章/胶囊（典型例子：本 deck 的圆形数字编号
    // roundRect@adj=50%），需要保留 preset path，按 shape 输出，否则会渲染成
    // 直角矩形。
    if (isNonRectPreset || hasCustomGeom) {
      outputAsText = false;
    } else {
      outputAsText = true;
    }
  } else if (hasCustomGeom) {
    outputAsText = false;
  } else if (isNonRectPreset || noPlaceholderType) {
    if (hasPresetGeom && !hasContent && hasFillOrBorder) {
      outputAsText = false;
    } else if (hasPresetGeom && isNonRectPreset) {
      outputAsText = false;
    } else if (!hasPresetGeom && !hasContent) {
      outputAsText = false;
    } else if (hasPresetGeom && hasFillOrBorder) {
      // 带文字+填充的非占位符 rect 是色块 banner，按 shape 输出
      // 以保留原始 width × height（与 src1 行为一致）。
      outputAsText = false;
    } else {
      outputAsText = true;
    }
  } else {
    outputAsText = true;
  }

  if (outputAsText) {
    const textEl: Text = {
      ...baseCommon,
      type: 'text',
      isVertical,
      vAlign,
    };
    return textEl;
  }

  const shapeEl: Shape = {
    ...baseCommon,
    type: 'shape',
    shapType,
    vAlign,
    path: pathOut,
    ...(keypoints && { keypoints }),
  };
  return shapeEl;
}

function textBodyRenderOptions(
  node: ShapeNodeData,
  ctx: RenderContext,
): RenderTextBodyOptions | undefined {
  // Frame width is always useful (clamps the leading tab-fold indent for narrow
  // boxes), independent of whether the shape carries a style/fontRef.
  const frameWidthPx = node.size.w > 0 ? node.size.w : undefined;
  const shapeStyle = node.source.child('style');
  const fontRef = shapeStyle.exists() ? shapeStyle.child('fontRef') : undefined;
  const fontRefColor =
    fontRef && fontRef.exists() && fontRef.allChildren().length > 0
      ? resolveColorToCss(fontRef, ctx)
      : undefined;

  if (frameWidthPx === undefined && fontRefColor === undefined) return undefined;
  return { frameWidthPx, fontRefColor };
}

/** @deprecated Use `renderShape` — same name as `ShapeRenderer` for diff-friendly comparison. */
export async function shapeToElement(
  node: ShapeNodeData,
  ctx: RenderContext,
  order: number,
): Promise<Shape | Text> {
  return renderShape(node, ctx, order);
}
