/**
 * Serializes GroupNodeData to pptxtojson Group element.
 * Recursively serializes children via nodeToElement; flattens nested groups into elements.
 *
 * Child positions are output relative to the group (consistent with pptxtojson).
 * Applies chOff/chExt coordinate space transformation and scaling.
 */

import type { GroupNodeData } from '../model/nodes/GroupNode';
import type { SlideNode } from '../model/Slide';
import { parseChildNode } from '../model/Slide';
import type { RenderContext } from './RenderContext';
import type { PptxFiles } from '../parser/ZipParser';
import type { Group, Element, BaseElement } from '../adapter/types';
import { SafeXmlNode } from '../parser/XmlParser';

function isGroup(e: Element): e is Group {
  return (e as Group).type === 'group';
}

function isShape(e: Element): e is import('../adapter/types').Shape {
  return (e as import('../adapter/types').Shape).type === 'shape';
}

const PX_TO_PT = 0.75;

function pxToPt(px: number): number {
  return Number((px * PX_TO_PT).toFixed(4));
}

function toFixed(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * 解析 SVG path 中的所有 (x,y) 坐标，判定该 path 是水平直线、垂直直线还是其它。
 * 仅用于识别 line / straightConnector1 这类单段线段。
 */
function detectLineOrientation(d: string): 'horizontal' | 'vertical' | 'diagonal' {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return 'diagonal';
  const xs: number[] = [];
  const ys: number[] = [];
  let cmd = '';
  let argIdx = 0;
  for (const t of tokens) {
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      argIdx = 0;
      continue;
    }
    const v = parseFloat(t);
    const upper = cmd.toUpperCase();
    if (upper === 'M' || upper === 'L' || upper === 'T') {
      if (argIdx % 2 === 0) xs.push(v);
      else ys.push(v);
    } else if (upper === 'H') {
      xs.push(v);
    } else if (upper === 'V') {
      ys.push(v);
    } else {
      // 复杂命令直接判为对角线
      return 'diagonal';
    }
    argIdx++;
  }
  if (xs.length < 2 || ys.length < 2) return 'diagonal';
  const xRange = Math.max(...xs) - Math.min(...xs);
  const yRange = Math.max(...ys) - Math.min(...ys);
  const eps = 1e-3;
  if (yRange < eps && xRange > eps) return 'horizontal';
  if (xRange < eps && yRange > eps) return 'vertical';
  return 'diagonal';
}

/**
 * Scale all coordinate values in an SVG path string by (sx, sy).
 * Handles M, L, C, Q, S, T, A, H, V, Z and their lowercase (relative) variants.
 */
function scaleSvgPath(d: string, sx: number, sy: number): string {
  if (sx === 1 && sy === 1) return d;
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return d;
  const out: string[] = [];
  let cmd = '';
  let argIdx = 0;
  for (const tok of tokens) {
    if (/^[A-Za-z]$/.test(tok)) {
      cmd = tok;
      argIdx = 0;
      out.push(tok);
      continue;
    }
    const v = parseFloat(tok);
    const upper = cmd.toUpperCase();
    let scaled: number;
    if (upper === 'H') {
      scaled = v * sx;
    } else if (upper === 'V') {
      scaled = v * sy;
    } else if (upper === 'A') {
      // A rx ry x-rotation large-arc-flag sweep-flag x y
      const ai = argIdx % 7;
      if (ai === 0) scaled = v * sx;
      else if (ai === 1) scaled = v * sy;
      else if (ai >= 2 && ai <= 4) scaled = v;
      else if (ai === 5) scaled = v * sx;
      else scaled = v * sy;
    } else {
      // M, L, C, Q, S, T: alternating x, y
      scaled = argIdx % 2 === 0 ? v * sx : v * sy;
    }
    out.push(String(toFixed(scaled)));
    argIdx++;
  }
  // Reconstruct: command letter directly followed by its coordinates
  let result = '';
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (/^[A-Za-z]$/.test(t)) {
      result += t;
    } else {
      if (i > 0 && !/^[A-Za-z]$/.test(out[i - 1])) result += ',';
      result += t;
    }
  }
  return result;
}

const FILL_TAGS = ['solidFill', 'gradFill', 'blipFill', 'pattFill'] as const;

function findGroupFillNode(grpSpPr: SafeXmlNode): SafeXmlNode | undefined {
  for (const tag of FILL_TAGS) {
    const n = grpSpPr.child(tag);
    if (n.exists()) return grpSpPr;
  }
  return undefined;
}

export type NodeToElement = (
  node: SlideNode,
  ctx: RenderContext,
  order: number,
  files?: PptxFiles,
) => Promise<Element>;

type ChildEl = BaseElement & {
  left: number;
  top: number;
  width: number;
  height: number;
  rotate?: number;
  isFlipH?: boolean;
  isFlipV?: boolean;
  shapType?: string;
  path?: string;
};

type BakedTransform = {
  left: number;
  top: number;
  rotate: number;
  isFlipH: boolean;
  isFlipV: boolean;
};

/**
 * 在 group 局部坐标系内，把 group 的 flip/rotation 烘焙到子元素的 transform，
 * 让输出不再依赖 group 包裹层的变换。无变换时返回 null。
 *
 * flipH+flipV 同时出现等价于绕中心旋转 180°，这里直接折算为 +180° 旋转而不是
 * 给子元素加 isFlipH+isFlipV，避免渲染器把 text 字形也镜像（PowerPoint/WPS
 * 对 text 的 flip 不影响字形朝向）。
 */
function bakeGroupTransform(
  child: ChildEl,
  gW: number,
  gH: number,
  gFlipH: boolean,
  gFlipV: boolean,
  gRot: number,
): BakedTransform | null {
  if (!gFlipH && !gFlipV && gRot === 0) return null;
  let cLeft = child.left;
  let cTop = child.top;
  const cW = child.width;
  const cH = child.height;
  let cRot = child.rotate ?? 0;
  let cFlipH = child.isFlipH ?? false;
  let cFlipV = child.isFlipV ?? false;
  if (gFlipH && gFlipV) {
    cLeft = gW - cLeft - cW;
    cTop = gH - cTop - cH;
    cRot += 180;
  } else if (gFlipH) {
    cLeft = gW - cLeft - cW;
    cRot = -cRot;
    cFlipH = !cFlipH;
  } else if (gFlipV) {
    cTop = gH - cTop - cH;
    cRot = -cRot;
    cFlipV = !cFlipV;
  }
  if (gRot !== 0) {
    const dx = cLeft + cW / 2 - gW / 2;
    const dy = cTop + cH / 2 - gH / 2;
    const θ = (gRot * Math.PI) / 180;
    cLeft = dx * Math.cos(θ) - dy * Math.sin(θ) + gW / 2 - cW / 2;
    cTop = dx * Math.sin(θ) + dy * Math.cos(θ) + gH / 2 - cH / 2;
    cRot += gRot;
  }
  cRot = ((cRot % 360) + 360) % 360;
  return { left: cLeft, top: cTop, rotate: cRot, isFlipH: cFlipH, isFlipV: cFlipV };
}

/**
 * 计算 group 缩放该 child 时实际使用的 (sw, sh)。
 *
 * 普通元素直接用 group 的 (ws, hs)。但对于 line / straightConnector1 这类
 * 单段线段：源 XML 常以 cy=0 或 cx=0 表示水平/垂直线，shapeSerializer 为了
 * SVG viewBox 可见会把对应轴 bump 到 1px(=0.75pt)。若再被 group 整体缩放，
 * 这条 1px 厚度就会被放大成几百 pt，导致下游渲染器（按 bbox 对角线绘制 line）
 * 把横线画成对角斜线。这里只缩放线段的方向轴，垂直轴保留原 stroke 厚度。
 */
function sizeScaleForChild(c: ChildEl, ws: number, hs: number): { sw: number; sh: number } {
  if (c.type !== 'shape') return { sw: ws, sh: hs };
  if (c.shapType !== 'line' && c.shapType !== 'straightConnector1') return { sw: ws, sh: hs };
  if (!c.path) return { sw: ws, sh: hs };
  const orient = detectLineOrientation(c.path);
  if (orient === 'horizontal') return { sw: ws, sh: 1 };
  if (orient === 'vertical') return { sw: 1, sh: hs };
  return { sw: ws, sh: hs };
}

/** 把 baked transform 的 rotate/flip 字段写到 scaled 对象上（仅当 child 本身有该字段）。 */
function assignBakedRotFlip(scaled: ChildEl, child: ChildEl, baked: BakedTransform): void {
  if ('rotate' in child) scaled.rotate = toFixed(baked.rotate);
  if ('isFlipH' in child) scaled.isFlipH = baked.isFlipH;
  if ('isFlipV' in child) scaled.isFlipV = baked.isFlipV;
}

export async function groupToElement(
  node: GroupNodeData,
  ctx: RenderContext,
  _order: number,
  files: PptxFiles | undefined,
  nodeToElement: NodeToElement,
): Promise<Group> {
  const order = node.xmlOrder;
  const left = pxToPt(node.position.x);
  const top = pxToPt(node.position.y);
  const width = pxToPt(node.size.w);
  const height = pxToPt(node.size.h);

  const chOffX = pxToPt(node.childOffset.x);
  const chOffY = pxToPt(node.childOffset.y);
  const chExtW = pxToPt(node.childExtent.w);
  const chExtH = pxToPt(node.childExtent.h);

  const ws = chExtW > 0 ? width / chExtW : 1;
  const hs = chExtH > 0 ? height / chExtH : 1;

  const rels = ctx.slide.rels;
  const slidePath = ctx.slide.slidePath;
  const diagramDrawings = files?.diagramDrawings;
  const elements: BaseElement[] = [];
  let idx = 0;

  const grpSpPr = node.source.child('grpSpPr');
  const groupFillSource = findGroupFillNode(grpSpPr);
  const childCtx: RenderContext = groupFillSource
    ? { ...ctx, groupFillNode: groupFillSource }
    : ctx;

  for (const childXml of node.children) {
    const childNode = parseChildNode(childXml, rels, slidePath, diagramDrawings);
    if (childNode) {
      const el = await nodeToElement(childNode, childCtx, idx, files);
      if (isGroup(el)) {
        const innerGroup = el;
        const gLeft = toFixed((innerGroup.left - chOffX) * ws);
        const gTop = toFixed((innerGroup.top - chOffY) * hs);
        for (const child of innerGroup.elements) {
          const c = child as ChildEl;
          // 先把内层 group 的 flip/rotation 烘焙到子元素的局部坐标系，再按外层
          // group 的 ws/hs 缩放并平移。
          const baked = bakeGroupTransform(
            c,
            innerGroup.width,
            innerGroup.height,
            !!innerGroup.isFlipH,
            !!innerGroup.isFlipV,
            innerGroup.rotate || 0,
          );
          const localLeft = baked ? baked.left : c.left;
          const localTop = baked ? baked.top : c.top;
          const sxsy = sizeScaleForChild(c, ws, hs);
          const scaled: ChildEl = {
            ...c,
            left: toFixed(gLeft + localLeft * ws),
            top: toFixed(gTop + localTop * hs),
            width: toFixed(c.width * sxsy.sw),
            height: toFixed(c.height * sxsy.sh),
          };
          if (baked) assignBakedRotFlip(scaled, c, baked);
          const cPath = (c as { path?: string }).path;
          if (isShape(c) && cPath) {
            scaled.path = scaleSvgPath(cPath, sxsy.sw, sxsy.sh);
          }
          elements.push(scaled as BaseElement);
        }
      } else {
        const be = el as BaseElement & { left: number; top: number; width: number; height: number };
        const sxsy = sizeScaleForChild(be as ChildEl, ws, hs);
        const scaled: ChildEl = {
          ...be,
          left: toFixed((be.left - chOffX) * ws),
          top: toFixed((be.top - chOffY) * hs),
          width: toFixed(be.width * sxsy.sw),
          height: toFixed(be.height * sxsy.sh),
        };
        const elPath = (el as { path?: string }).path;
        if (isShape(el) && elPath) {
          scaled.path = scaleSvgPath(elPath, sxsy.sw, sxsy.sh);
        }
        elements.push(scaled as BaseElement);
      }
      idx++;
    }
  }

  // 把当前 group 自身的 flip/rotation 烘焙到子元素，让输出的 group 始终是
  // 中性的（无 flip、无 rotation），下游渲染器无需再组合 group 级变换。
  for (const el2 of elements) {
    const c = el2 as ChildEl;
    const baked = bakeGroupTransform(
      c,
      width,
      height,
      !!node.flipH,
      !!node.flipV,
      node.rotation || 0,
    );
    if (!baked) continue;
    c.left = toFixed(baked.left);
    c.top = toFixed(baked.top);
    assignBakedRotFlip(c, c, baked);
  }

  return {
    type: 'group',
    left,
    top,
    width,
    height,
    rotate: 0,
    elements,
    order,
    isFlipH: false,
    isFlipV: false,
  };
}
