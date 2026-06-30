/**
 * Slide parser — converts a slide XML into a structured SlideData
 * with typed node objects for each shape on the slide.
 */

import { SafeXmlNode, parseXml } from '../parser/XmlParser';
import { RelEntry, resolveRelTarget } from '../parser/RelParser';
import { emuToPx } from '../parser/units';
import { parseBaseProps } from './nodes/BaseNode';
import { ShapeNodeData, parseShapeNode } from './nodes/ShapeNode';
import { PicNodeData, parsePicNode } from './nodes/PicNode';
import { TableNodeData, parseTableNode } from './nodes/TableNode';
import { GroupNodeData, parseGroupNode } from './nodes/GroupNode';
import { ChartNodeData, parseChartNode } from './nodes/ChartNode';
import {
  MathNodeData,
  parseMathNode,
  parseOleDocxMathNode,
  isMathAlternateContent,
} from './nodes/MathNode';

export type SlideNode =
  | ShapeNodeData
  | PicNodeData
  | TableNodeData
  | GroupNodeData
  | ChartNodeData
  | MathNodeData;

export interface SlideData {
  index: number;
  nodes: SlideNode[];
  background?: SafeXmlNode;
  layoutIndex: string;
  rels: Map<string, RelEntry>;
  /** Full path to the slide file (e.g. "ppt/slides/slide3.xml"). */
  slidePath: string;
  /** When false, shapes from the layout and master should NOT be rendered on this slide. */
  showMasterSp: boolean;
}

/**
 * Check whether a graphicFrame contains a table (`a:tbl`).
 */
function isTableFrame(node: SafeXmlNode): boolean {
  const graphic = node.child('graphic');
  const graphicData = graphic.child('graphicData');
  return graphicData.child('tbl').exists();
}

/**
 * Check whether a graphicFrame contains a chart.
 */
function isChartFrame(node: SafeXmlNode): boolean {
  const graphic = node.child('graphic');
  const graphicData = graphic.child('graphicData');
  const uri = graphicData.attr('uri') || '';
  return uri.includes('chart');
}

/**
 * Detect graphicFrame with oleObj progId="Word.Document.*" and delegate to
 * parseOleDocxMathNode. These are embedded .docx containing EQ field math.
 */
function tryParseOleDocxMath(graphicFrame: SafeXmlNode): MathNodeData | undefined {
  const graphicData = graphicFrame.child('graphic').child('graphicData');
  const uri = graphicData.attr('uri') || '';
  if (!uri.includes('ole')) return undefined;

  const altContent = graphicData.child('AlternateContent');
  if (!altContent.exists()) return undefined;

  const oleObj = altContent.child('Choice').child('oleObj');
  if (!oleObj.exists()) return undefined;

  const progId = oleObj.attr('progId') || '';
  if (!progId.startsWith('Word.Document')) return undefined;

  return parseOleDocxMathNode(graphicFrame);
}

/**
 * Find p:pic inside OLE graphicData (mc:AlternateContent > mc:Fallback or mc:Choice > p:oleObj > p:pic).
 * Returns the pic node if it has blipFill with embed (so we can render the preview image).
 */
function findOleFallbackPic(graphicFrame: SafeXmlNode): SafeXmlNode | null {
  const graphic = graphicFrame.child('graphic');
  const graphicData = graphic.child('graphicData');
  const uri = graphicData.attr('uri') || '';
  if (!uri.includes('ole')) return null;

  const altContent = graphicData.child('AlternateContent');
  if (!altContent.exists()) return null;

  for (const branch of ['Fallback', 'Choice'] as const) {
    const oleObj = altContent.child(branch).child('oleObj');
    if (!oleObj.exists()) continue;
    const pic = oleObj.child('pic');
    if (!pic.exists()) continue;
    const blipFill = pic.child('blipFill');
    const blip = blipFill.child('blip');
    const embed = blip.attr('embed') ?? blip.attr('r:embed');
    if (embed) return pic;
  }
  return null;
}

/**
 * Parse a graphicFrame that contains an OLE object with a fallback picture (preview image).
 * Uses the frame's position/size and the inner pic's blip embed.
 * Exported for use in GroupRenderer when parsing group children.
 */
export function parseOleFrameAsPicture(graphicFrame: SafeXmlNode): PicNodeData | undefined {
  const pic = findOleFallbackPic(graphicFrame);
  if (!pic) return undefined;

  const base = parseBaseProps(graphicFrame);
  const blipFill = pic.child('blipFill');
  const blip = blipFill.child('blip');
  const blipEmbed = blip.attr('embed') ?? blip.attr('r:embed');
  const blipLink = blip.attr('link') ?? blip.attr('r:link');
  if (!blipEmbed) return undefined;

  return {
    ...base,
    nodeType: 'picture',
    blipEmbed,
    blipLink,
    source: graphicFrame,
  };
}

/**
 * Check whether a graphicFrame contains a SmartArt diagram.
 */
function isDiagramFrame(node: SafeXmlNode): boolean {
  const graphic = node.child('graphic');
  const graphicData = graphic.child('graphicData');
  const uri = graphicData.attr('uri') || '';
  return uri.includes('diagram');
}

/**
 * Parse a SmartArt diagram graphicFrame by resolving the diagram drawing fallback XML.
 * The drawing XML contains pre-rendered shapes in a spTree that we can display as a group.
 */
function parseDiagramFrame(
  graphicFrame: SafeXmlNode,
  rels: Map<string, RelEntry>,
  slidePath: string,
  diagramDrawings: Map<string, string>,
): GroupNodeData | undefined {
  const base = parseBaseProps(graphicFrame);
  const slideDir = slidePath.substring(0, slidePath.lastIndexOf('/'));
  const drawingCandidates = Array.from(rels.values())
    .filter(
      (entry) => entry.type.includes('diagramDrawing') || entry.target.includes('diagrams/drawing'),
    )
    .map((entry) => {
      const target = entry.target;
      const match = target.match(/drawing(\d+)/);
      return {
        target,
        num: match ? Number.parseInt(match[1], 10) : undefined,
      };
    });

  // Extract the diagram data rId from the relIds element to identify which diagram this is
  const graphic = graphicFrame.child('graphic');
  const graphicData = graphic.child('graphicData');
  const relIds = graphicData.child('relIds');

  // Strategy 1: Match data file number to drawing file number
  // e.g. data3.xml → drawing3.xml
  if (relIds.exists()) {
    const dmRId = relIds.attr('r:dm') ?? relIds.attr('dm');
    if (dmRId) {
      const dmRel = rels.get(dmRId);
      if (dmRel) {
        // Extract the number from the data target (e.g. "data3" → "3")
        const numMatch = dmRel.target.match(/data(\d+)/);
        if (numMatch) {
          const drawingNum = Number.parseInt(numMatch[1], 10);
          // Prefer exact drawingN; if absent, use the nearest numbered drawing relation.
          const ordered = drawingCandidates.slice().sort((a, b) => {
            const da =
              a.num === undefined ? Number.POSITIVE_INFINITY : Math.abs(a.num - drawingNum);
            const db =
              b.num === undefined ? Number.POSITIVE_INFINITY : Math.abs(b.num - drawingNum);
            return da - db;
          });
          for (const candidate of ordered) {
            const drawingPath = resolveRelTarget(slideDir, candidate.target);
            const drawingXml = diagramDrawings.get(drawingPath);
            if (drawingXml) {
              return buildDiagramGroup(base, drawingXml);
            }
          }
        }
      }
    }
  }

  // Strategy 2: Fallback - find any diagramDrawing relationship
  for (const candidate of drawingCandidates) {
    const drawingPath = resolveRelTarget(slideDir, candidate.target);
    const drawingXml = diagramDrawings.get(drawingPath);
    if (drawingXml) {
      return buildDiagramGroup(base, drawingXml);
    }
  }

  return undefined;
}

/**
 * Read xfrm off/ext from a shape-like node (dsp:sp uses dsp:spPr > a:xfrm).
 */
function readShapeBounds(node: SafeXmlNode): { x: number; y: number; w: number; h: number } | null {
  const spPr = node.child('spPr');
  if (!spPr.exists()) return null;
  const xfrm = spPr.child('xfrm');
  if (!xfrm.exists()) return null;
  const off = xfrm.child('off');
  const ext = xfrm.child('ext');
  const x = emuToPx(off.numAttr('x') ?? 0);
  const y = emuToPx(off.numAttr('y') ?? 0);
  const w = emuToPx(ext.numAttr('cx') ?? 0);
  const h = emuToPx(ext.numAttr('cy') ?? 0);
  return { x, y, w, h };
}

/**
 * Build a GroupNodeData from a diagram drawing XML string.
 * Diagram drawings use dsp: namespace (drawingml 2008); structure is dsp:drawing > dsp:spTree > dsp:sp.
 * Diagram shapes use their own coordinate space; we compute childOffset/childExtent from
 * the actual bounding box of all shapes so remapping preserves layout and spacing.
 */
function buildDiagramGroup(
  base: ReturnType<typeof parseBaseProps>,
  drawingXml: string,
): GroupNodeData {
  const drawingRoot = parseXml(drawingXml);
  const spTree = drawingRoot.child('spTree');
  if (!spTree.exists()) {
    return {
      ...base,
      nodeType: 'group',
      childOffset: { x: 0, y: 0 },
      childExtent: { w: base.size.w, h: base.size.h },
      children: [],
    };
  }

  const CHILD_TAGS = new Set(['sp', 'pic', 'grpSp', 'graphicFrame', 'cxnSp']);
  // Circular presets need isotropic scaling; tree/org-chart style diagrams should keep native axis scaling.
  const CIRCULAR_PRESETS = new Set(['pie', 'arc', 'blockArc', 'donut', 'circularArrow']);
  const children: SafeXmlNode[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;
  let hasCircularPreset = false;

  for (const child of spTree.allChildren()) {
    if (CHILD_TAGS.has(child.localName)) {
      children.push(child);
      const prst = child.child('spPr').child('prstGeom').attr('prst');
      if (prst && CIRCULAR_PRESETS.has(prst)) hasCircularPreset = true;
      const b = readShapeBounds(child);
      if (b) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxRight = Math.max(maxRight, b.x + b.w);
        maxBottom = Math.max(maxBottom, b.y + b.h);
      }
    }
  }

  const hasBounds =
    minX !== Infinity && minY !== Infinity && maxRight !== -Infinity && maxBottom !== -Infinity;

  // Check if shapes extend significantly beyond the diagram frame (negative offsets or huge extents).
  // When decorative shapes (e.g. blockArc) have large negative coordinates, including them in
  // the bounding box distorts the layout. Fall back to frame-based coordinates in that case.
  const bboxSpansNegative = hasBounds && (minX < 0 || minY < 0);
  const bboxMuchLargerThanFrame =
    hasBounds && (maxRight - minX > base.size.w * 2 || maxBottom - minY > base.size.h * 2);
  const useFrameCoords = bboxSpansNegative || bboxMuchLargerThanFrame;

  // Use the graphicFrame's own dimensions as the child coordinate space.
  // Diagram shapes are positioned in the frame's coordinate space (EMU converted to px).
  // Using frame dimensions gives a 1:1 scale, preserving original positions and sizes.
  // This avoids enlarging shapes when the bounding box is smaller than the frame.
  let extentW = Math.max(1, base.size.w);
  let extentH = Math.max(1, base.size.h);
  let offX = 0;
  let offY = 0;

  if (!hasBounds) {
    extentW = Math.max(1, base.size.w);
    extentH = Math.max(1, base.size.h);
    offX = 0;
    offY = 0;
  }

  return {
    ...base,
    nodeType: 'group',
    childOffset: { x: offX, y: offY },
    childExtent: { w: extentW, h: extentH },
    children,
  };
}

/**
 * True when an sp's txBody has at least one non-empty regular text run (`a:r > a:t`).
 * Used to tell "text box that happens to contain inline formulas" (→ text shape)
 * apart from "a box that is purely a formula" (→ Math node).
 */
function spHasTextRuns(sp: SafeXmlNode): boolean {
  const txBody = sp.child('txBody');
  if (!txBody.exists()) return false;
  for (const p of txBody.children('p')) {
    for (const r of p.children('r')) {
      if (r.child('t').text().trim().length > 0) return true;
    }
  }
  return false;
}

/**
 * True when an sp is a visible "box" — has an explicit fill or a visible border
 * (either directly in spPr or via a non-zero p:style fillRef/lnRef). Such a box
 * whose only label is an inline formula (e.g. slide 26 的彩色 x / W₁ / σ 方框，
 * 标签是 a14:m 公式而非文本 run) must be parsed as a SHAPE so its背景色/边框得以
 * 保留——parseMathNode 只取公式、会把方框底色丢掉，渲染成透明。纯公式框（无填充、
 * 无边框）仍走 parseMathNode 以获得正确的块级排版与缩放。
 */
function spHasVisibleFillOrLine(sp: SafeXmlNode): boolean {
  const spPr = sp.child('spPr');
  const spPrHasNoFill = spPr.exists() && spPr.child('noFill').exists();
  if (spPr.exists()) {
    for (const tag of ['solidFill', 'gradFill', 'blipFill', 'pattFill']) {
      if (spPr.child(tag).exists()) return true;
    }
    const ln = spPr.child('ln');
    if (ln.exists() && !ln.child('noFill').exists()) {
      for (const tag of ['solidFill', 'gradFill', 'pattFill']) {
        if (ln.child(tag).exists()) return true;
      }
    }
  }
  const style = sp.child('style');
  if (style.exists()) {
    if (!spPrHasNoFill) {
      const fillRef = style.child('fillRef');
      if (fillRef.exists() && (fillRef.attr('idx') ?? '0') !== '0') return true;
    }
    const lnRef = style.child('lnRef');
    if (lnRef.exists() && (lnRef.attr('idx') ?? '0') !== '0') return true;
  }
  return false;
}

/**
 * Parse a single child node from spTree, dispatching to the appropriate parser.
 */
export function parseChildNode(
  child: SafeXmlNode,
  rels: Map<string, RelEntry>,
  slidePath: string,
  diagramDrawings?: Map<string, string>,
): SlideNode | undefined {
  const tag = child.localName;

  switch (tag) {
    case 'sp':
    case 'cxnSp':
      return parseShapeNode(child);
    case 'pic':
      return parsePicNode(child);
    case 'grpSp':
      return parseGroupNode(child);
    case 'graphicFrame':
      if (isTableFrame(child)) {
        return parseTableNode(child);
      }
      if (isChartFrame(child)) {
        return parseChartNode(child, rels, slidePath);
      }
      // SmartArt diagram with drawing fallback
      if (isDiagramFrame(child) && diagramDrawings) {
        return parseDiagramFrame(child, rels, slidePath, diagramDrawings);
      }
      // Word.Document OLE → math node (EQ field formulas in embedded .docx)
      {
        const oleDocxMath = tryParseOleDocxMath(child);
        if (oleDocxMath) return oleDocxMath;
      }
      // OLE object with fallback picture (e.g. embedded PDF preview on slide 34)
      {
        const olePic = parseOleFrameAsPicture(child);
        if (olePic) return olePic;
      }
      // Non-table/chart/ole graphic frames — skip
      return undefined;
    case 'AlternateContent':
      if (isMathAlternateContent(child)) {
        // A box that mixes real text runs with inline formulas (公式与正文混排，
        // 如「设 N 为类别数量」) must be parsed as a TEXT shape — parseMathNode
        // would keep only the formulas and drop all the Chinese. Only a box that
        // is essentially just a formula (no text runs) stays a pure Math node.
        const choiceSp = child.child('Choice').child('sp');
        if (choiceSp.exists() && (spHasTextRuns(choiceSp) || spHasVisibleFillOrLine(choiceSp))) {
          return parseShapeNode(choiceSp);
        }
        return parseMathNode(child);
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Find the layout relationship target from a slide's rels map.
 * The relationship type URI for slide layouts ends with "slideLayout".
 */
function findLayoutRel(rels: Map<string, RelEntry>): string {
  for (const [, entry] of rels) {
    if (entry.type.includes('slideLayout')) {
      return entry.target;
    }
  }
  return '';
}

/**
 * Parse a slide XML root (`p:sld`) into SlideData.
 *
 * @param root      Parsed XML root of the slide
 * @param index     Zero-based slide index
 * @param rels      Relationship entries for this slide
 * @param slidePath Full path to the slide file (e.g. "ppt/slides/slide1.xml")
 */
export function parseSlide(
  root: SafeXmlNode,
  index: number,
  rels: Map<string, RelEntry>,
  slidePath: string = '',
  diagramDrawings?: Map<string, string>,
): SlideData {
  const cSld = root.child('cSld');

  // --- Background ---
  const bg = cSld.child('bg');
  const background = bg.exists() ? bg : undefined;

  // --- Parse shape tree children ---
  const spTree = cSld.child('spTree');
  const nodes: SlideNode[] = [];

  for (const child of spTree.allChildren()) {
    const node = parseChildNode(child, rels, slidePath, diagramDrawings);
    if (node) {
      nodes.push(node);
    }
  }

  // --- Layout relationship ---
  const layoutIndex = findLayoutRel(rels);

  // --- showMasterSp: if "0", layout/master shapes should not be rendered on this slide ---
  const showMasterSpAttr = root.attr('showMasterSp');
  const showMasterSp = showMasterSpAttr !== '0';

  return {
    index,
    nodes,
    background,
    layoutIndex,
    rels,
    slidePath,
    showMasterSp,
  };
}
