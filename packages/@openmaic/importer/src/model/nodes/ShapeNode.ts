/**
 * Shape node parser — handles auto-shapes, text boxes, and connectors.
 */

import { SafeXmlNode } from '../../parser/XmlParser';
import { emuToPx, angleToDeg } from '../../parser/units';
import { BaseNodeData, parseBaseProps } from './BaseNode';
import { uniformMathColorNode } from './MathNode';

export interface TextRun {
  text: string;
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  properties?: SafeXmlNode;
  /**
   * OOXML <a:fld type=""> 字段类型——常见 slidenum / datetime / footer。
   * 渲染时需在拿到 slide context 后替换为动态值（slidenum → 当前页码等）。
   */
  fldType?: string;
  /**
   * Serialized OMML (`m:oMathPara`/`m:oMath`) for an INLINE formula run that sits
   * inside a normal text paragraph (公式与中文混排，如「设 N 为类别数量」)。serializer
   * 把它渲染成行内 KaTeX；`text` 同时存纯文本作为渲染失败时的兜底。
   */
  ommlXml?: string;
  /** Uniform color node of an inline math run (OMML run color the converter drops). */
  mathColorNode?: SafeXmlNode;
}

export interface TextParagraph {
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  properties?: SafeXmlNode;
  runs: TextRun[];
  level: number;
  /** @internal End-of-paragraph run properties (a:endParaRPr). Defines font size for trailing paragraph mark. */
  endParaRPr?: SafeXmlNode;
}

export interface TextBody {
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  bodyProperties?: SafeXmlNode;
  /** @internal Fallback bodyPr from layout/master placeholder (used when shape's own bodyPr is missing attrs). */
  layoutBodyProperties?: SafeXmlNode;
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  listStyle?: SafeXmlNode;
  paragraphs: TextParagraph[];
}

export interface LineEndInfo {
  type: string; // 'triangle', 'arrow', 'stealth', 'diamond', 'oval', 'none'
  w?: string; // 'sm', 'med', 'lg'
  len?: string; // 'sm', 'med', 'lg'
}

/** Text box bounds in shape-local coordinates (used by diagram shapes with txXfrm). */
export interface TextBoxBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
}

export interface ShapeNodeData extends BaseNodeData {
  nodeType: 'shape';
  presetGeometry?: string;
  adjustments: Map<string, number>;
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  customGeometry?: SafeXmlNode;
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  fill?: SafeXmlNode;
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  line?: SafeXmlNode;
  headEnd?: LineEndInfo;
  tailEnd?: LineEndInfo;
  textBody?: TextBody;
  /** When set (e.g. diagram txXfrm), text is laid out in this rect instead of full shape. */
  textBoxBounds?: TextBoxBounds;
}

/** Recursively find the first OMML container (`m:oMathPara`/`m:oMath`). */
function findOmmlNode(node: SafeXmlNode): SafeXmlNode | null {
  if (node.localName === 'oMathPara' || node.localName === 'oMath') return node;
  for (const child of node.allChildren()) {
    const found = findOmmlNode(child);
    if (found) return found;
  }
  return null;
}

/** Concatenate all `m:t` text inside an OMML node (plain-text fallback). */
function collectMathPlainText(node: SafeXmlNode): string {
  if (node.localName === 't') return node.text();
  return node.allChildren().map(collectMathPlainText).join('');
}

/**
 * Build an inline-math run from an OMML node (already located). Returns
 * undefined if the node can't be serialized.
 */
function inlineMathRun(ommlNode: SafeXmlNode): TextRun | undefined {
  const el = ommlNode.rawElement;
  if (!el) return undefined;
  return {
    text: collectMathPlainText(ommlNode),
    ommlXml: el.toString(),
    mathColorNode: uniformMathColorNode(ommlNode),
  };
}

/**
 * Parse a single text paragraph (`a:p`).
 */
function parseParagraph(pNode: SafeXmlNode): TextParagraph {
  const pPr = pNode.child('pPr');
  const level = pPr.numAttr('lvl') ?? 0;

  const runs: TextRun[] = [];

  // Regular runs (a:r)
  for (const rNode of pNode.children('r')) {
    const rPr = rNode.child('rPr');
    const tNode = rNode.child('t');
    runs.push({
      text: tNode.text(),
      properties: rPr.exists() ? rPr : undefined,
    });
  }

  // Line breaks (a:br) — treated as runs with newline text
  // Field codes (a:fld) — treated as runs with their display text
  for (const child of pNode.allChildren()) {
    if (child.localName === 'br') {
      // a:br nodes are interspersed with a:r nodes, but since we iterate
      // children separately, we need a combined approach. We handle this
      // by re-scanning all children in order below.
    }
  }

  // Re-scan in document order to get correct interleaving of r, br, fld
  const orderedRuns: TextRun[] = [];
  for (const child of pNode.allChildren()) {
    const ln = child.localName;
    if (ln === 'r') {
      const rPr = child.child('rPr');
      const tNode = child.child('t');
      orderedRuns.push({
        text: tNode.text(),
        properties: rPr.exists() ? rPr : undefined,
      });
    } else if (ln === 'br') {
      const rPr = child.child('rPr');
      orderedRuns.push({
        text: '\n',
        properties: rPr.exists() ? rPr : undefined,
      });
    } else if (ln === 'fld') {
      const rPr = child.child('rPr');
      const tNode = child.child('t');
      orderedRuns.push({
        text: tNode.text(),
        properties: rPr.exists() ? rPr : undefined,
        fldType: child.attr('type') || undefined,
      });
    } else if (ln === 'm' || ln === 'oMathPara' || ln === 'oMath') {
      // Inline formula run: `<a14:m>`(localName 'm') wraps m:oMathPara/m:oMath,
      // or the OMML sits directly in the paragraph. Capture it as a math run so
      // 公式与中文混排不会丢正文（serializer 渲染成行内 KaTeX）。
      const ommlNode = findOmmlNode(child);
      const mathRun = ommlNode ? inlineMathRun(ommlNode) : undefined;
      if (mathRun) orderedRuns.push(mathRun);
    }
  }

  const endParaRPrNode = pNode.child('endParaRPr');
  return {
    properties: pPr.exists() ? pPr : undefined,
    runs: orderedRuns.length > 0 ? orderedRuns : runs,
    level,
    endParaRPr: endParaRPrNode.exists() ? endParaRPrNode : undefined,
  };
}

/**
 * Parse a text body (`p:txBody` or `a:txBody`).
 */
export function parseTextBody(txBody: SafeXmlNode): TextBody | undefined {
  if (!txBody.exists()) return undefined;

  const bodyPr = txBody.child('bodyPr');
  const lstStyle = txBody.child('lstStyle');

  const paragraphs: TextParagraph[] = [];
  for (const pNode of txBody.children('p')) {
    paragraphs.push(parseParagraph(pNode));
  }

  return {
    bodyProperties: bodyPr.exists() ? bodyPr : undefined,
    listStyle: lstStyle.exists() ? lstStyle : undefined,
    paragraphs,
  };
}

/** Fill type local names in priority order. */
const FILL_TYPES = ['solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'noFill'] as const;

/**
 * Find the first fill element in a shape properties node.
 */
function findFill(spPr: SafeXmlNode): SafeXmlNode | undefined {
  for (const fillType of FILL_TYPES) {
    const fill = spPr.child(fillType);
    if (fill.exists()) return fill;
  }
  return undefined;
}

/**
 * Parse adjustment values from `a:avLst > a:gd` elements.
 * Each guide has a `name` attribute and a `fmla` attribute like "val 50000".
 */
function parseAdjustments(avLst: SafeXmlNode): Map<string, number> {
  const adjustments = new Map<string, number>();
  for (const gd of avLst.children('gd')) {
    const name = gd.attr('name');
    const fmla = gd.attr('fmla') ?? '';
    if (!name) continue;

    // fmla is typically "val NNNNN" — extract the numeric part
    const match = fmla.match(/val\s+(-?\d+)/);
    if (match) {
      adjustments.set(name, Number(match[1]));
    } else {
      // Try direct numeric value
      const num = Number(fmla);
      if (!Number.isNaN(num)) {
        adjustments.set(name, num);
      }
    }
  }
  return adjustments;
}

/**
 * Parse a shape XML node (`p:sp` or `p:cxnSp`) into ShapeNodeData.
 */
export function parseShapeNode(spNode: SafeXmlNode): ShapeNodeData {
  const base = parseBaseProps(spNode);
  const spPr = spNode.child('spPr');

  // --- Preset geometry ---
  const prstGeom = spPr.child('prstGeom');
  const presetGeometry = prstGeom.attr('prst');
  const avLst = prstGeom.child('avLst');
  const adjustments = parseAdjustments(avLst);

  // --- Custom geometry ---
  const custGeom = spPr.child('custGeom');
  const customGeometry = custGeom.exists() ? custGeom : undefined;

  // --- Fill ---
  const fill = findFill(spPr);

  // --- Line ---
  const ln = spPr.child('ln');
  const line = ln.exists() ? ln : undefined;

  // --- Line end markers (arrowheads) ---
  let headEnd: LineEndInfo | undefined;
  let tailEnd: LineEndInfo | undefined;
  if (ln.exists()) {
    const headEndNode = ln.child('headEnd');
    if (headEndNode.exists()) {
      const t = headEndNode.attr('type');
      if (t && t !== 'none') {
        headEnd = { type: t, w: headEndNode.attr('w'), len: headEndNode.attr('len') };
      }
    }
    const tailEndNode = ln.child('tailEnd');
    if (tailEndNode.exists()) {
      const t = tailEndNode.attr('type');
      if (t && t !== 'none') {
        tailEnd = { type: t, w: tailEndNode.attr('w'), len: tailEndNode.attr('len') };
      }
    }
  }

  // --- Text body ---
  const txBody = spNode.child('txBody');
  const textBody = parseTextBody(txBody);

  // --- Text transform (diagram shapes: dsp:txXfrm gives text box position/size in same space as xfrm)
  let textBoxBounds: TextBoxBounds | undefined;
  const txXfrm = spNode.child('txXfrm');
  if (txXfrm.exists()) {
    const txOff = txXfrm.child('off');
    const txExt = txXfrm.child('ext');
    const xfrm = spPr.child('xfrm');
    const off = xfrm.child('off');
    const ext = xfrm.child('ext');
    const shapeX = off.numAttr('x') ?? 0;
    const shapeY = off.numAttr('y') ?? 0;
    const shapeW = ext.numAttr('cx') ?? 0;
    const shapeH = ext.numAttr('cy') ?? 0;
    const txX = txOff.numAttr('x') ?? 0;
    const txY = txOff.numAttr('y') ?? 0;
    const txW = txExt.numAttr('cx') ?? 0;
    const txH = txExt.numAttr('cy') ?? 0;
    if (shapeW > 0 && shapeH > 0) {
      const txRotDeg = angleToDeg(txXfrm.numAttr('rot') ?? 0);
      const localX = txX - shapeX;
      const localY = txY - shapeY;
      // For 180deg txXfrm, mirror text box placement inside shape-local coordinates.
      // (Common in SmartArt where shape xfrm also rotates by 180deg but text should remain upright.)
      const isHalfTurn = Math.abs(Math.round(txRotDeg)) % 360 === 180;
      const boxX = isHalfTurn ? shapeW - (localX + txW) : localX;
      const boxY = isHalfTurn ? shapeH - (localY + txH) : localY;
      textBoxBounds = {
        x: emuToPx(boxX),
        y: emuToPx(boxY),
        w: emuToPx(txW),
        h: emuToPx(txH),
        rotation: txRotDeg,
      };
    }
  }

  return {
    ...base,
    nodeType: 'shape',
    presetGeometry,
    adjustments,
    customGeometry,
    fill,
    line,
    headEnd,
    tailEnd,
    textBody,
    textBoxBounds,
  };
}
