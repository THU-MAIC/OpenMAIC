/**
 * Slide serializer — orchestrates background fill, layoutElements, and slide elements
 * using the same order as SlideRenderer: fill → master template shapes → layout template shapes → slide nodes.
 */

import type { SafeXmlNode } from '../parser/XmlParser';
import type { SlideData } from '../model/Slide';
import type { SlideNode } from '../model/Slide';
import { parseShapeNode } from '../model/nodes/ShapeNode';
import { parsePicNode } from '../model/nodes/PicNode';
import { parseGroupNode } from '../model/nodes/GroupNode';
import { parseTableNode } from '../model/nodes/TableNode';
import type { PresentationData } from '../model/Presentation';
import type { PptxFiles } from '../parser/ZipParser';
import { createRenderContext, type MediaMode } from './RenderContext';
import { resolveSlideFill } from './backgroundSerializer';
import { shapeToElement } from './shapeSerializer';
import { pictureToElement } from './imageSerializer';
import { tableToElement } from './tableSerializer';
import { chartToElement } from './chartSerializer';
import { mathToElement } from './mathSerializer';
import { groupToElement, type NodeToElement } from './groupSerializer';
import type { Slide, Element } from '../adapter/types';
import { parseXml } from '../parser/XmlParser';
import { resolveRelTarget } from '../parser/RelParser';

/**
 * Check whether a shape node is a placeholder (has p:ph in nvPr).
 */
function isPlaceholderNode(node: SafeXmlNode): boolean {
  for (const wrapper of ['nvSpPr', 'nvPicPr', 'nvGrpSpPr', 'nvGraphicFramePr', 'nvCxnSpPr']) {
    const nv = node.child(wrapper);
    if (nv.exists()) {
      const nvPr = nv.child('nvPr');
      if (nvPr.child('ph').exists()) return true;
    }
  }
  return false;
}

function isTableFrame(node: SafeXmlNode): boolean {
  const graphic = node.child('graphic');
  const graphicData = graphic.child('graphicData');
  return graphicData.child('tbl').exists();
}

function isChartFrame(node: SafeXmlNode): boolean {
  const graphic = node.child('graphic');
  const graphicData = graphic.child('graphicData');
  const uri = graphicData.attr('uri') || '';
  return uri.includes('chart');
}

/**
 * Parse and collect renderable shapes from a master or layout spTree.
 * Only includes NON-placeholder shapes (decorative elements, logos, footers).
 * Placeholder shapes are never rendered from master/layout — they only serve
 * as position/size inheritance templates.
 */
function parseTemplateShapes(spTree: SafeXmlNode): SlideNode[] {
  const nodes: SlideNode[] = [];
  if (!spTree?.exists?.() || !spTree.exists()) return nodes;

  for (const child of spTree.allChildren()) {
    const tag = child.localName;

    // Skip ALL placeholder shapes — they're templates, not renderable content
    if (isPlaceholderNode(child)) continue;

    try {
      let node: SlideNode | undefined;
      switch (tag) {
        case 'sp':
        case 'cxnSp':
          node = parseShapeNode(child);
          break;
        case 'pic':
          node = parsePicNode(child);
          break;
        case 'grpSp':
          node = parseGroupNode(child);
          break;
        case 'graphicFrame':
          if (isTableFrame(child)) node = parseTableNode(child);
          break;
      }
      // Skip empty/invisible nodes (0x0 size and no text)
      if (node && (node.size.w > 0 || node.size.h > 0)) {
        nodes.push(node);
      }
    } catch {
      // Skip unparseable template shapes silently
    }
  }
  return nodes;
}

/**
 * Dispatch a slide node to the appropriate serializer and return Element.
 */
async function nodeToElement(
  node: SlideNode,
  ctx: ReturnType<typeof createRenderContext>,
  order: number,
  files?: PptxFiles,
): Promise<Element> {
  switch (node.nodeType) {
    case 'shape':
      return shapeToElement(node, ctx, order);
    case 'picture':
      return pictureToElement(node, ctx, order);
    case 'table':
      return tableToElement(node, ctx, order);
    case 'chart':
      return chartToElement(node, ctx, order);
    case 'math':
      return mathToElement(node, ctx, order);
    case 'group':
      return groupToElement(node, ctx, order, files, nodeToElement as NodeToElement);
    default:
      return shapeToElement(node as import('../model/nodes/ShapeNode').ShapeNodeData, ctx, order);
  }
}

function getNoteForSlide(slide: SlideData, files: PptxFiles): string {
  for (const [, entry] of slide.rels) {
    if (!entry.type.includes('notesSlide')) continue;
    const basePath = slide.slidePath.replace(/\/[^/]+$/, '');
    const notesPath = resolveRelTarget(basePath, entry.target);
    const notesXml = files.notesSlides.get(notesPath);
    if (!notesXml) continue;
    const root = parseXml(notesXml);
    const cSld = root.child('cSld');
    if (!cSld.exists()) continue;
    const spTree = cSld.child('spTree');
    const parts: string[] = [];
    for (const sp of spTree.allChildren()) {
      if (sp.localName !== 'sp') continue;
      const nvPr = sp.child('nvSpPr').child('nvPr');
      const ph = nvPr.child('ph');
      if (ph.attr('type') !== 'body') continue;
      const txBody = sp.child('txBody');
      if (!txBody.exists()) continue;
      for (const p of txBody.children('p')) {
        for (const r of p.children('r')) {
          const t = r.child('t');
          parts.push(t.text());
        }
      }
    }
    return parts.length > 0 ? parts.join('').trim() : '';
  }
  return '';
}

function getTransitionForSlide(slide: SlideData, files: PptxFiles): Slide['transition'] {
  const slideXml = files.slides.get(slide.slidePath);
  if (!slideXml) return undefined;
  const root = parseXml(slideXml);
  const transition = root.child('transition');
  if (!transition.exists()) return undefined;
  let type = 'none';
  let duration = 1000;
  let direction: string | null = null;
  for (const child of transition.allChildren()) {
    if (child.localName && child.localName !== 'p14:transition') {
      type = child.localName;
      break;
    }
  }
  const spd = transition.attr('spd');
  if (spd === 'fast') duration = 500;
  else if (spd === 'med') duration = 800;
  else if (spd === 'slow') duration = 1000;
  const dir = transition.attr('dir');
  if (dir) direction = dir;
  return { type, duration, direction };
}

// ---------------------------------------------------------------------------
// Main Slide Serialize Function
// ---------------------------------------------------------------------------

/**
 * Serialize one slide to pptxtojson Slide (fill, layoutElements, elements, note, transition).
 *
 * Order:
 * 1. Background (slide → layout → master inheritance)
 * 2. Master non-placeholder shapes (behind everything)
 * 3. Layout non-placeholder shapes
 * 4. Slide shapes (on top)
 */
export async function slideToSlide(
  presentation: PresentationData,
  slide: SlideData,
  files: PptxFiles,
  mediaMode: MediaMode = 'base64',
): Promise<Slide> {
  // Create render context (resolves slide -> layout -> master -> theme chain)
  const ctx = createRenderContext(presentation, slide, undefined, mediaMode);

  // Render background
  const fill = await resolveSlideFill(ctx);

  // --- Render master template shapes (behind layout and slide) ---
  // Respect showMasterSp flags:
  //  - layout.showMasterSp === false  → skip master shapes
  //  - slide.showMasterSp === false   → skip both master AND layout shapes
  const layoutElements: Element[] = [];
  if (slide.showMasterSp && ctx.layout.showMasterSp) {
    const masterCtx = { ...ctx, slide: { ...ctx.slide, rels: ctx.master.rels } };
    const masterShapes = parseTemplateShapes(ctx.master.spTree);
    for (let i = 0; i < masterShapes.length; i++) {
      try {
        layoutElements.push(await nodeToElement(masterShapes[i], masterCtx, i, files));
      } catch {
        // skip
      }
    }
  }

  // --- Render layout template shapes ---
  // xmlOrder is computed per-document, so master and layout orders are not
  // directly comparable. Offset layout orders to guarantee they sort above
  // all master elements when the renderer sorts layoutElements by order.
  if (slide.showMasterSp) {
    let maxMasterOrder = 0;
    for (const el of layoutElements) {
      if (el.order > maxMasterOrder) maxMasterOrder = el.order;
    }
    const layoutOrderOffset = layoutElements.length > 0 ? maxMasterOrder + 1 : 0;

    const layoutCtx = { ...ctx, slide: { ...ctx.slide, rels: ctx.layout.rels } };
    const layoutShapes = parseTemplateShapes(ctx.layout.spTree);
    for (let i = 0; i < layoutShapes.length; i++) {
      try {
        const el = await nodeToElement(layoutShapes[i], layoutCtx, i, files);
        el.order += layoutOrderOffset;
        layoutElements.push(el);
      } catch {
        // skip
      }
    }
  }

  // --- Render slide shapes (on top) ---
  const elements: Element[] = [];
  for (let i = 0; i < slide.nodes.length; i++) {
    try {
      elements.push(await nodeToElement(slide.nodes[i], ctx, i, files));
    } catch {
      // skip failed node
    }
  }

  return {
    fill,
    elements,
    layoutElements,
    note: getNoteForSlide(slide, files),
    transition: getTransitionForSlide(slide, files),
  };
}

export { nodeToElement };
