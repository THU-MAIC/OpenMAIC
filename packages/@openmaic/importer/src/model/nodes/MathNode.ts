/**
 * Math node — represents a math formula embedded via mc:AlternateContent.
 *
 * PPTX stores math formulas as:
 *   mc:AlternateContent
 *     mc:Choice (Requires="a14") → p:sp with m:oMathPara in txBody
 *     mc:Fallback → p:sp with blipFill (static image preview)
 */

import { SafeXmlNode } from '../../parser/XmlParser';
import { BaseNodeData, parseBaseProps } from './BaseNode';

export interface MathNodeData extends BaseNodeData {
  nodeType: 'math';
  /**
   * When every math run shares one explicit color (a:rPr>solidFill), this is
   * that color node — OMML→LaTeX converters drop drawingML run color, so the
   * serializer resolves this and applies it to the whole formula (e.g. 蓝色
   * 权重 W=(w₁,…,wₙ)). Mixed-color formulas leave it undefined (default color).
   */
  colorNode?: SafeXmlNode;
  /** Serialized OMML XML string (first m:oMathPara or m:oMath element). */
  ommlXml: string;
  /**
   * One serialized OMML string per paragraph-level formula in the box. A
   * PPTX 公式文本框 often holds several `<a:p>`, each with its own
   * `m:oMathPara` (e.g. slide 29 的输入框 4 行算式)。Older code only kept the
   * first (`ommlXml`); keep them all so the serializer can emit every line.
   */
  ommlXmls?: string[];
  /** r:embed of fallback image from mc:Fallback branch. */
  fallbackBlipEmbed?: string;
  /** Plain text extracted from m:t elements inside the OMML. */
  plainText: string;
  /** rId of embedded .docx package (Word.Document OLE — contains EQ field math). */
  oleDocxRId?: string;
}

/**
 * Recursively search for an element with localName 'oMathPara' or 'oMath'.
 */
function findOmmlNode(node: SafeXmlNode): SafeXmlNode | null {
  if (node.localName === 'oMathPara' || node.localName === 'oMath') return node;
  for (const child of node.allChildren()) {
    const found = findOmmlNode(child);
    if (found) return found;
  }
  return null;
}

/**
 * Collect every top-level OMML node (one per paragraph's formula). Stops
 * descending once it hits an oMathPara/oMath so a paragraph's container is
 * returned whole (and its inner oMath isn't double-counted).
 */
function collectOmmlNodes(node: SafeXmlNode): SafeXmlNode[] {
  if (node.localName === 'oMathPara' || node.localName === 'oMath') return [node];
  const out: SafeXmlNode[] = [];
  for (const child of node.allChildren()) out.push(...collectOmmlNodes(child));
  return out;
}

/**
 * If every math run (`m:r`) carries the same explicit color
 * (`a:rPr > a:solidFill > a:srgbClr|a:schemeClr`), return that color node so
 * the serializer can resolve + apply it. Returns undefined when there's no
 * explicit color or the runs use mixed colors (then the formula keeps the
 * default color — partial per-run coloring isn't reconstructed).
 */
export function uniformMathColorNode(ommlNode: SafeXmlNode): SafeXmlNode | undefined {
  const colors: SafeXmlNode[] = [];
  const walk = (n: SafeXmlNode) => {
    if (n.localName === 'r') {
      const fill = n.child('rPr').child('solidFill');
      if (fill.exists()) {
        const srgb = fill.child('srgbClr');
        const scheme = fill.child('schemeClr');
        if (srgb.exists()) colors.push(srgb);
        else if (scheme.exists()) colors.push(scheme);
        else colors.push(fill); // some other fill child — still counts as "has color"
      }
    }
    for (const child of n.allChildren()) walk(child);
  };
  walk(ommlNode);
  if (colors.length === 0) return undefined;
  const key = (x: SafeXmlNode) => `${x.localName}:${x.attr('val') ?? ''}`;
  const first = key(colors[0]);
  return colors.every((c) => key(c) === first) ? colors[0] : undefined;
}

/**
 * Recursively collect all text from m:t elements.
 */
function collectMathText(node: SafeXmlNode): string {
  if (node.localName === 't') return node.text();
  const parts: string[] = [];
  for (const child of node.allChildren()) {
    parts.push(collectMathText(child));
  }
  return parts.join('');
}

/**
 * Serialize a SafeXmlNode's underlying DOM Element to an XML string.
 */
function serializeElement(node: SafeXmlNode): string {
  const el = node.rawElement;
  if (!el) return '';
  // @xmldom/xmldom Element supports toString() which returns outerHTML-equivalent XML
  return el.toString();
}

/**
 * Detect whether an mc:AlternateContent node contains a math formula.
 * Math formulas have mc:Choice with p:sp > p:txBody containing m:oMathPara/m:oMath.
 */
export function isMathAlternateContent(altContent: SafeXmlNode): boolean {
  const choice = altContent.child('Choice');
  if (!choice.exists()) return false;
  const sp = choice.child('sp');
  if (!sp.exists()) return false;
  const txBody = sp.child('txBody');
  if (!txBody.exists()) return false;
  return findOmmlNode(txBody) !== null;
}

/**
 * Parse a graphicFrame whose oleObj has progId starting with "Word.Document".
 * These OLE objects contain embedded .docx with EQ field math (legacy Word formula).
 * The actual docx parsing is deferred to the serializer (needs zip decompression);
 * here we just capture the rIds.
 */
export function parseOleDocxMathNode(graphicFrame: SafeXmlNode): MathNodeData | undefined {
  const base = parseBaseProps(graphicFrame);

  const graphicData = graphicFrame.child('graphic').child('graphicData');
  const altContent = graphicData.child('AlternateContent');
  if (!altContent.exists()) return undefined;

  // mc:Choice > p:oleObj has the docx rId
  const oleObj = altContent.child('Choice').child('oleObj');
  const docxRId = oleObj.attr('r:id') ?? oleObj.attr('id');
  if (!docxRId) return undefined;

  // mc:Fallback > p:oleObj > p:pic > p:blipFill > a:blip has the EMF fallback
  let fallbackBlipEmbed: string | undefined;
  const fallback = altContent.child('Fallback');
  if (fallback.exists()) {
    const fbOle = fallback.child('oleObj');
    const fbPic = fbOle.exists() ? fbOle.child('pic') : fallback.child('pic');
    if (fbPic.exists()) {
      const blip = fbPic.child('blipFill').child('blip');
      if (blip.exists()) {
        fallbackBlipEmbed = blip.attr('embed') ?? blip.attr('r:embed');
      }
    }
  }

  return {
    ...base,
    nodeType: 'math' as const,
    ommlXml: '',
    oleDocxRId: docxRId,
    fallbackBlipEmbed,
    plainText: '',
  };
}

/**
 * Parse an mc:AlternateContent node containing a math formula into MathNodeData.
 */
export function parseMathNode(altContent: SafeXmlNode): MathNodeData | undefined {
  const choice = altContent.child('Choice');
  if (!choice.exists()) return undefined;

  const sp = choice.child('sp');
  if (!sp.exists()) return undefined;

  const txBody = sp.child('txBody');
  if (!txBody.exists()) return undefined;

  const ommlNodes = collectOmmlNodes(txBody);
  if (ommlNodes.length === 0) return undefined;

  // Use the sp from Choice for position/size (it has the xfrm)
  const base = parseBaseProps(sp);
  const ommlXmls = ommlNodes.map(serializeElement).filter(Boolean);
  const ommlXml = ommlXmls[0] ?? '';
  const plainText = ommlNodes.map(collectMathText).join('\n');

  // Extract fallback image embed from mc:Fallback > p:sp > p:spPr > a:blipFill > a:blip
  let fallbackBlipEmbed: string | undefined;
  const fallback = altContent.child('Fallback');
  if (fallback.exists()) {
    const fbSp = fallback.child('sp');
    if (fbSp.exists()) {
      const blip = fbSp.child('spPr').child('blipFill').child('blip');
      if (blip.exists()) {
        fallbackBlipEmbed = blip.attr('embed') ?? blip.attr('r:embed');
      }
    }
  }

  return {
    ...base,
    nodeType: 'math' as const,
    ommlXml,
    ommlXmls,
    colorNode: uniformMathColorNode(ommlNodes[0]),
    fallbackBlipEmbed,
    plainText,
  };
}
