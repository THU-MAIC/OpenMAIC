/**
 * Slide layout parser — extracts color map override, background,
 * and placeholder shapes from a p:sldLayout XML.
 */

import { SafeXmlNode } from '../parser/XmlParser';
import type { RelEntry } from '../parser/RelParser';
import { emuToPx } from '../parser/units';

export interface PlaceholderXfrm {
  position: { x: number; y: number };
  size: { w: number; h: number };
}

export interface PlaceholderEntry {
  node: SafeXmlNode;
  /** When placeholder is inside a group, position/size in slide space (px). */
  absoluteXfrm?: PlaceholderXfrm;
}

export interface LayoutData {
  colorMapOverride?: Map<string, string>;
  background?: SafeXmlNode;
  placeholders: PlaceholderEntry[];
  spTree: SafeXmlNode;
  rels: Map<string, RelEntry>;
  /** When false, shapes from the slide master should NOT be rendered on this layout. */
  showMasterSp: boolean;
}

/**
 * Check whether a shape node contains a placeholder definition.
 */
function isPlaceholder(node: SafeXmlNode): boolean {
  const nvSpPr = node.child('nvSpPr');
  if (nvSpPr.exists()) {
    const nvPr = nvSpPr.child('nvPr');
    if (nvPr.child('ph').exists()) return true;
  }
  const nvPicPr = node.child('nvPicPr');
  if (nvPicPr.exists()) {
    const nvPr = nvPicPr.child('nvPr');
    if (nvPr.child('ph').exists()) return true;
  }
  return false;
}

function getShapeXfrmInEmu(
  node: SafeXmlNode,
): { offX: number; offY: number; cx: number; cy: number } | null {
  const spPr = node.child('spPr');
  if (!spPr.exists()) return null;
  const xfrm = spPr.child('xfrm');
  if (!xfrm.exists()) return null;
  const off = xfrm.child('off');
  const ext = xfrm.child('ext');
  const offX = off.numAttr('x') ?? 0;
  const offY = off.numAttr('y') ?? 0;
  const cx = ext.numAttr('cx') ?? 0;
  const cy = ext.numAttr('cy') ?? 0;
  return { offX, offY, cx, cy };
}

function getGroupXfrmInEmu(grpSp: SafeXmlNode): {
  offX: number;
  offY: number;
  cx: number;
  cy: number;
  chOffX: number;
  chOffY: number;
  chExtCx: number;
  chExtCy: number;
} | null {
  const grpSpPr = grpSp.child('grpSpPr');
  if (!grpSpPr.exists()) return null;
  const xfrm = grpSpPr.child('xfrm');
  if (!xfrm.exists()) return null;
  const off = xfrm.child('off');
  const ext = xfrm.child('ext');
  const chOff = xfrm.child('chOff');
  const chExt = xfrm.child('chExt');
  const offX = off.numAttr('x') ?? 0;
  const offY = off.numAttr('y') ?? 0;
  const cx = ext.numAttr('cx') ?? 0;
  const cy = ext.numAttr('cy') ?? 0;
  // OOXML: when chOff/chExt omitted, child box equals group box (chOff=0,0 and chExt=ext)
  const chOffX = chOff.exists() ? (chOff.numAttr('x') ?? 0) : 0;
  const chOffY = chOff.exists() ? (chOff.numAttr('y') ?? 0) : 0;
  const chExtCx = chExt.exists() ? (chExt.numAttr('cx') ?? cx) : cx;
  const chExtCy = chExt.exists() ? (chExt.numAttr('cy') ?? cy) : cy;
  return {
    offX,
    offY,
    cx,
    cy,
    chOffX,
    chOffY,
    chExtCx: chExtCx > 0 ? chExtCx : 1,
    chExtCy: chExtCy > 0 ? chExtCy : 1,
  };
}

/**
 * Recursively collect placeholders; when inside a group, compute position/size in slide space.
 */
function extractPlaceholdersRecursive(
  spTree: SafeXmlNode,
  groupTransform: { offX: number; offY: number; scaleX: number; scaleY: number } | null,
): PlaceholderEntry[] {
  const out: PlaceholderEntry[] = [];
  for (const child of spTree.allChildren()) {
    if (child.localName === 'grpSp') {
      const gx = getGroupXfrmInEmu(child);
      if (gx && gx.chExtCx > 0 && gx.chExtCy > 0) {
        const scaleX = gx.cx / gx.chExtCx;
        const scaleY = gx.cy / gx.chExtCy;
        const baseOffX = gx.offX - gx.chOffX * scaleX;
        const baseOffY = gx.offY - gx.chOffY * scaleY;
        const nextTransform = groupTransform
          ? {
              offX: groupTransform.offX + baseOffX * groupTransform.scaleX,
              offY: groupTransform.offY + baseOffY * groupTransform.scaleY,
              scaleX: groupTransform.scaleX * scaleX,
              scaleY: groupTransform.scaleY * scaleY,
            }
          : { offX: baseOffX, offY: baseOffY, scaleX, scaleY };
        const nested = extractPlaceholdersRecursive(child, nextTransform);
        out.push(...nested);
      } else {
        out.push(...extractPlaceholdersRecursive(child, groupTransform));
      }
      continue;
    }
    if (!isPlaceholder(child)) continue;
    const sx = getShapeXfrmInEmu(child);
    if (!sx) {
      out.push({ node: child });
      continue;
    }
    if (groupTransform) {
      const absOffX = groupTransform.offX + sx.offX * groupTransform.scaleX;
      const absOffY = groupTransform.offY + sx.offY * groupTransform.scaleY;
      const absCx = sx.cx * groupTransform.scaleX;
      const absCy = sx.cy * groupTransform.scaleY;
      out.push({
        node: child,
        absoluteXfrm: {
          position: { x: emuToPx(absOffX), y: emuToPx(absOffY) },
          size: { w: emuToPx(absCx), h: emuToPx(absCy) },
        },
      });
    } else {
      out.push({
        node: child,
        absoluteXfrm: {
          position: { x: emuToPx(sx.offX), y: emuToPx(sx.offY) },
          size: { w: emuToPx(sx.cx), h: emuToPx(sx.cy) },
        },
      });
    }
  }
  return out;
}

/**
 * Parse all attributes of a node into a Map<string, string>.
 */
function parseAllAttributes(node: SafeXmlNode): Map<string, string> {
  const result = new Map<string, string>();
  const el = node.element;
  if (!el) return result;
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    result.set(attr.localName, attr.value);
  }
  return result;
}

/**
 * Parse a slide layout XML root (`p:sldLayout`) into LayoutData.
 */
export function parseLayout(root: SafeXmlNode): LayoutData {
  const cSld = root.child('cSld');

  // --- Background ---
  const bg = cSld.child('bg');
  const background = bg.exists() ? bg : undefined;

  // --- Shape tree ---
  const spTree = cSld.child('spTree');

  // --- Color map override ---
  let colorMapOverride: Map<string, string> | undefined;
  const clrMapOvr = root.child('clrMapOvr');
  if (clrMapOvr.exists()) {
    const overrideMapping = clrMapOvr.child('overrideClrMapping');
    if (overrideMapping.exists()) {
      colorMapOverride = parseAllAttributes(overrideMapping);
    }
  }

  // --- Placeholders (recursive so we find title/body inside grpSp; resolve position in slide space) ---
  const placeholders = extractPlaceholdersRecursive(spTree, null);

  // --- showMasterSp: if "0", master shapes should not be rendered for this layout ---
  const showMasterSpAttr = root.attr('showMasterSp');
  const showMasterSp = showMasterSpAttr !== '0';

  return {
    colorMapOverride,
    background,
    placeholders,
    spTree,
    rels: new Map(), // populated later by buildPresentation
    showMasterSp,
  };
}
