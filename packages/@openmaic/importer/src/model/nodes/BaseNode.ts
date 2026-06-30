/**
 * Base node types and property parser shared by all slide node kinds.
 */

import { SafeXmlNode } from '../../parser/XmlParser';
import { emuToPx, angleToDeg } from '../../parser/units';

export type NodeType = 'shape' | 'picture' | 'table' | 'group' | 'chart' | 'math' | 'unknown';

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface PlaceholderInfo {
  type?: string;
  idx?: number;
}

/** Shape-level hyperlink click action (from cNvPr > a:hlinkClick). */
export interface HlinkAction {
  /** Action URI, e.g. "ppaction://hlinksldjump", "ppaction://hlinkpres", or empty for URL links. */
  action?: string;
  /** Relationship ID for the target (slide, URL, etc.). */
  rId?: string;
  /** Optional tooltip text. */
  tooltip?: string;
}

export interface BaseNodeData {
  id: string;
  name: string;
  nodeType: NodeType;
  position: Position;
  size: Size;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  placeholder?: PlaceholderInfo;
  /** Shape-level hyperlink/click action (action buttons, clickable shapes). */
  hlinkClick?: HlinkAction;
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  source: SafeXmlNode;
  /** Document-order index of this node's XML element (depth-first walk from root). */
  xmlOrder: number;
}

/**
 * Try to find the non-visual properties container in the given node.
 * PPTX uses different wrapper names depending on the shape kind:
 *   p:nvSpPr (shapes/connectors), p:nvPicPr (pictures),
 *   p:nvGrpSpPr (groups), p:nvGraphicFramePr (tables/charts).
 */
function findNvProps(node: SafeXmlNode): { cNvPr: SafeXmlNode; nvPr: SafeXmlNode } {
  const wrappers = ['nvSpPr', 'nvPicPr', 'nvGrpSpPr', 'nvGraphicFramePr', 'nvCxnSpPr'];
  for (const name of wrappers) {
    const wrapper = node.child(name);
    if (wrapper.exists()) {
      return {
        cNvPr: wrapper.child('cNvPr'),
        nvPr: wrapper.child('nvPr'),
      };
    }
  }
  return {
    cNvPr: node.child('cNvPr'),
    nvPr: node.child('nvPr'),
  };
}

/**
 * Find the transform (xfrm) node. Shapes use `p:spPr > a:xfrm`,
 * groups use `p:grpSpPr > a:xfrm`, graphic frames use `p:xfrm`.
 */
function findXfrm(node: SafeXmlNode): SafeXmlNode {
  // Try spPr first (most shapes)
  const spPr = node.child('spPr');
  if (spPr.exists()) {
    const xfrm = spPr.child('xfrm');
    if (xfrm.exists()) return xfrm;
  }

  // Try grpSpPr (groups)
  const grpSpPr = node.child('grpSpPr');
  if (grpSpPr.exists()) {
    const xfrm = grpSpPr.child('xfrm');
    if (xfrm.exists()) return xfrm;
  }

  // Try direct xfrm (graphic frames)
  const directXfrm = node.child('xfrm');
  if (directXfrm.exists()) return directXfrm;

  // Return empty node — all reads will return defaults
  return node.child('__nonexistent__');
}

/**
 * Parse placeholder info from nvPr > p:ph.
 */
function parsePlaceholder(nvPr: SafeXmlNode): PlaceholderInfo | undefined {
  const ph = nvPr.child('ph');
  if (!ph.exists()) return undefined;

  const type = ph.attr('type');
  const idx = ph.numAttr('idx');

  return { type, idx };
}

/**
 * Compute document-order index: count all Element nodes preceding this one
 * in a depth-first walk from the document root.
 * Mirrors the `cust_attr_order` counter in src1's `simplifyLostLess`.
 */
function getDocumentOrder(node: SafeXmlNode): number {
  const el = node.rawElement;
  if (!el) return 0;
  const root = el.ownerDocument?.documentElement;
  if (!root) return 0;
  let count = 0;
  function walk(cur: Element): boolean {
    count++;
    if (cur === el) return true;
    const children = cur.childNodes;
    for (let i = 0; i < children.length; i++) {
      if (children[i].nodeType === 1 && walk(children[i] as Element)) return true;
    }
    return false;
  }
  walk(root);
  return count;
}

/**
 * Parse the base properties common to all node types from a shape-like XML node.
 * Returns everything except `nodeType`, which the caller must set.
 */
export function parseBaseProps(spNode: SafeXmlNode): Omit<BaseNodeData, 'nodeType'> {
  const { cNvPr, nvPr } = findNvProps(spNode);

  const id = cNvPr.attr('id') ?? '';
  const name = cNvPr.attr('name') ?? '';

  // --- Transform ---
  const xfrm = findXfrm(spNode);
  const off = xfrm.child('off');
  const ext = xfrm.child('ext');

  const position: Position = {
    x: emuToPx(off.numAttr('x') ?? 0),
    y: emuToPx(off.numAttr('y') ?? 0),
  };

  const size: Size = {
    w: emuToPx(ext.numAttr('cx') ?? 0),
    h: emuToPx(ext.numAttr('cy') ?? 0),
  };

  let rotation = angleToDeg(xfrm.numAttr('rot') ?? 0);
  let flipH = xfrm.attr('flipH') === '1' || xfrm.attr('flipH') === 'true';
  let flipV = xfrm.attr('flipV') === '1' || xfrm.attr('flipV') === 'true';

  // OOXML 等价规约：rot 180° === flipH + flipV（绕中心旋转）。因此
  //   rot 180° + flipH         ≡ flipV
  //   rot 180° + flipV         ≡ flipH
  //   rot 180° + flipH + flipV ≡ identity
  // 这里优先消除 rot=180° 的形式，把它折算成等价的 flip 组合，因为
  // PowerPoint / WPS 对 text 的 flip 不影响字形朝向，但 rotate 会把字
  // 一起旋转。设计师常用 "rot=180 + flipV" 让背景图水平镜像而文字保持
  // 正向，下游若直接套 rotate=180 就会把文字也翻成镜像不可读。
  // 注意：单纯 "rot=180° 无 flip" 是真旋转 180°，PowerPoint 中文字也翻，
  // 这里不规约。
  const rotMod = ((Math.round(rotation) % 360) + 360) % 360;
  if (rotMod === 180 && (flipH || flipV)) {
    flipH = !flipH;
    flipV = !flipV;
    rotation = rotation - 180;
  }

  // --- Placeholder ---
  const placeholder = parsePlaceholder(nvPr);

  // --- Shape-level hyperlink action (cNvPr > a:hlinkClick) ---
  let hlinkClick: HlinkAction | undefined;
  const hlinkNode = cNvPr.child('hlinkClick');
  if (hlinkNode.exists()) {
    hlinkClick = {
      action: hlinkNode.attr('action') ?? undefined,
      rId: hlinkNode.attr('id') ?? hlinkNode.attr('r:id') ?? undefined,
      tooltip: hlinkNode.attr('tooltip') ?? undefined,
    };
  }

  return {
    id,
    name,
    position,
    size,
    rotation,
    flipH,
    flipV,
    placeholder,
    hlinkClick,
    source: spNode,
    xmlOrder: getDocumentOrder(spNode),
  };
}
