/**
 * Top-level presentation builder — assembles all parsed components
 * (themes, masters, layouts, slides) into a single PresentationData structure.
 */

import { PptxFiles } from '../parser/ZipParser';
import { parseXml, SafeXmlNode } from '../parser/XmlParser';
import { parseRels, RelEntry, resolveRelTarget } from '../parser/RelParser';
import { emuToPx } from '../parser/units';
import { ThemeData, parseTheme } from './Theme';
import { MasterData, parseMaster } from './Master';
import { LayoutData, parseLayout, PlaceholderEntry } from './Layout';
import { SlideData, SlideNode, parseSlide } from './Slide';
import { Position, Size } from './nodes/BaseNode';

export interface PresentationData {
  width: number;
  height: number;
  slides: SlideData[];
  layouts: Map<string, LayoutData>;
  masters: Map<string, MasterData>;
  themes: Map<string, ThemeData>;
  slideToLayout: Map<number, string>;
  layoutToMaster: Map<string, string>;
  masterToTheme: Map<string, string>;
  media: Map<string, Uint8Array>;
  embeddings: Map<string, Uint8Array>;
  tableStyles?: SafeXmlNode;
  charts: Map<string, SafeXmlNode>;
  isWps: boolean;
}

/**
 * Derive the base directory from a file path.
 * E.g., "ppt/slides/slide1.xml" → "ppt/slides"
 */
function basePath(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx >= 0 ? filePath.substring(0, idx) : '';
}

/**
 * For a given XML file path, find its corresponding .rels file path.
 * E.g., "ppt/slides/slide1.xml" → "ppt/slides/_rels/slide1.xml.rels"
 */
function relsPathFor(filePath: string): string {
  const dir = basePath(filePath);
  const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
  return `${dir}/_rels/${fileName}.rels`;
}

/**
 * Extract ordered slide rId list from presentation.xml.
 * Reads `p:sldIdLst > p:sldId` elements and returns their r:id attributes in order.
 */
function _getSlideOrder(presRoot: SafeXmlNode): string[] {
  const sldIdLst = presRoot.child('sldIdLst');
  const rIds: string[] = [];
  for (const sldId of sldIdLst.children('sldId')) {
    const rId = sldId.attr('id') ?? sldId.attr('r:id');
    if (rId) rIds.push(rId);
  }
  return rIds;
}

/**
 * Detect WPS (Kingsoft Office / WPS Office) by checking for known markers
 * in the presentation XML string.
 */
function detectWps(presentationXml: string): boolean {
  // WPS adds its own namespace or processing instructions
  return (
    presentationXml.includes('wps') ||
    presentationXml.includes('kso') ||
    presentationXml.includes('Kingsoft') ||
    presentationXml.includes('WPS')
  );
}

/**
 * Find a rels entry by type substring match.
 */
function findRelByType(rels: Map<string, RelEntry>, typeSubstring: string): RelEntry | undefined {
  for (const [, entry] of rels) {
    if (entry.type.includes(typeSubstring)) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Find ALL rels entries matching a type substring, returning [rId, entry] pairs.
 */
function findRelsByType(rels: Map<string, RelEntry>, typeSubstring: string): [string, RelEntry][] {
  const results: [string, RelEntry][] = [];
  for (const [rId, entry] of rels) {
    if (entry.type.includes(typeSubstring)) {
      results.push([rId, entry]);
    }
  }
  return results;
}

/**
 * Build the complete PresentationData from extracted PPTX files.
 *
 * This is the main factory function that wires together all parsed components:
 * 1. Parses presentation.xml for slide ordering and size
 * 2. Resolves the full relationship chain: slide → layout → master → theme
 * 3. Parses each component and assembles the final structure
 */
export function buildPresentation(files: PptxFiles): PresentationData {
  // --- Parse presentation root ---
  const presRoot = parseXml(files.presentation);
  const presRels = parseRels(files.presentationRels);

  // --- Slide size ---
  const sldSz = presRoot.child('sldSz');
  const width = emuToPx(sldSz.numAttr('cx') ?? 9144000); // default 10 inches
  const height = emuToPx(sldSz.numAttr('cy') ?? 6858000); // default 7.5 inches

  // --- WPS detection ---
  const isWps = detectWps(files.presentation);

  // --- Parse themes ---
  const themes = new Map<string, ThemeData>();
  for (const [themePath, themeXml] of files.themes) {
    const themeRoot = parseXml(themeXml);
    themes.set(themePath, parseTheme(themeRoot));
  }

  // --- Parse slide masters and build master→theme mapping ---
  const masters = new Map<string, MasterData>();
  const masterToTheme = new Map<string, string>();

  for (const [masterPath, masterXml] of files.slideMasters) {
    const masterRoot = parseXml(masterXml);
    const masterData = parseMaster(masterRoot);

    // Find theme relationship for this master
    const masterRelsPath = relsPathFor(masterPath);
    const masterRelsXml = files.slideMasterRels.get(masterRelsPath);
    if (masterRelsXml) {
      const masterRels = parseRels(masterRelsXml);
      masterData.rels = masterRels;
      const themeRel = findRelByType(masterRels, 'theme');
      if (themeRel) {
        const themePath = resolveRelTarget(basePath(masterPath), themeRel.target);
        masterToTheme.set(masterPath, themePath);
      }
    }
    masters.set(masterPath, masterData);
  }

  // --- Parse slide layouts and build layout→master mapping ---
  const layouts = new Map<string, LayoutData>();
  const layoutToMaster = new Map<string, string>();

  for (const [layoutPath, layoutXml] of files.slideLayouts) {
    const layoutRoot = parseXml(layoutXml);
    const layoutData = parseLayout(layoutRoot);

    // Find master relationship for this layout
    const layoutRelsPath = relsPathFor(layoutPath);
    const layoutRelsXml = files.slideLayoutRels.get(layoutRelsPath);
    if (layoutRelsXml) {
      const layoutRels = parseRels(layoutRelsXml);
      layoutData.rels = layoutRels;
      const masterRel = findRelByType(layoutRels, 'slideMaster');
      if (masterRel) {
        const masterPath = resolveRelTarget(basePath(layoutPath), masterRel.target);
        layoutToMaster.set(layoutPath, masterPath);
      }
    }
    layouts.set(layoutPath, layoutData);
  }

  // --- Parse charts ---
  const charts = new Map<string, SafeXmlNode>();
  for (const [chartPath, chartXml] of files.charts) {
    const chartRoot = parseXml(chartXml);
    if (chartRoot.exists()) {
      charts.set(chartPath, chartRoot);
    }
  }

  // --- Determine slide ordering ---
  // The sldIdLst contains sldId elements with r:id attributes that reference
  // presentation.xml.rels. We need to handle the fact that the attr might be
  // stored as 'r:id' in the original XML but SafeXmlNode.attr() uses localName.
  const sldIdLst = presRoot.child('sldIdLst');
  const orderedSlideTargets: string[] = [];

  for (const sldId of sldIdLst.children('sldId')) {
    // Try multiple attribute name patterns
    const rId = sldId.attr('r:id') ?? sldId.attr('id');
    if (rId) {
      const relEntry = presRels.get(rId);
      if (relEntry) {
        const slidePath = resolveRelTarget('ppt', relEntry.target);
        orderedSlideTargets.push(slidePath);
      }
    }
  }

  // Fallback: if sldIdLst parsing didn't yield results, use presRels directly
  if (orderedSlideTargets.length === 0) {
    const slideRels = findRelsByType(presRels, 'slide');
    // Sort by rId number to maintain order
    slideRels.sort((a, b) => {
      const numA = parseInt(a[0].replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b[0].replace(/\D/g, ''), 10) || 0;
      return numA - numB;
    });
    for (const [, entry] of slideRels) {
      // Only include direct slide relationships, not slideLayout or slideMaster
      if (
        entry.type.includes('/slide') &&
        !entry.type.includes('slideLayout') &&
        !entry.type.includes('slideMaster')
      ) {
        const slidePath = resolveRelTarget('ppt', entry.target);
        orderedSlideTargets.push(slidePath);
      }
    }
  }

  // --- Parse slides ---
  const slides: SlideData[] = [];
  const slideToLayout = new Map<number, string>();

  for (let i = 0; i < orderedSlideTargets.length; i++) {
    const slidePath = orderedSlideTargets[i];
    const slideXml = files.slides.get(slidePath);
    if (!slideXml) continue;

    // Parse slide rels
    const slideRelsPath = relsPathFor(slidePath);
    const slideRelsXml = files.slideRels.get(slideRelsPath);
    const slideRels = slideRelsXml ? parseRels(slideRelsXml) : new Map<string, RelEntry>();

    // Parse slide
    const slideRoot = parseXml(slideXml);
    const slideData = parseSlide(slideRoot, i, slideRels, slidePath, files.diagramDrawings);

    // Resolve layout path from the slide's layout relationship target
    if (slideData.layoutIndex) {
      const layoutPath = resolveRelTarget(basePath(slidePath), slideData.layoutIndex);
      slideData.layoutIndex = layoutPath;
      slideToLayout.set(i, layoutPath);
    }

    slides.push(slideData);
  }

  // --- Table styles ---
  let tableStyles: SafeXmlNode | undefined;
  if (files.tableStyles) {
    const tsRoot = parseXml(files.tableStyles);
    if (tsRoot.exists()) {
      tableStyles = tsRoot;
    }
  }

  const result: PresentationData = {
    width,
    height,
    slides,
    layouts,
    masters,
    themes,
    slideToLayout,
    layoutToMaster,
    masterToTheme,
    media: files.media,
    embeddings: files.embeddings,
    tableStyles,
    charts,
    isWps,
  };

  // --- Resolve placeholder position inheritance ---
  resolvePlaceholderInheritance(result);

  return result;
}

// ---------------------------------------------------------------------------
// Placeholder Position Inheritance
// ---------------------------------------------------------------------------

/**
 * Extract placeholder info (type, idx) from a raw placeholder XML node
 * stored in layout/master.
 */
function getPhInfo(phNode: SafeXmlNode): { type?: string; idx?: number } {
  // Try nvSpPr > nvPr > ph, or nvPicPr > nvPr > ph
  for (const wrapper of ['nvSpPr', 'nvPicPr', 'nvGrpSpPr', 'nvGraphicFramePr', 'nvCxnSpPr']) {
    const nvWrapper = phNode.child(wrapper);
    if (nvWrapper.exists()) {
      const nvPr = nvWrapper.child('nvPr');
      const ph = nvPr.child('ph');
      if (ph.exists()) {
        const type = ph.attr('type');
        const idxStr = ph.attr('idx');
        const idx = idxStr !== undefined ? Number(idxStr) : undefined;
        return { type, idx: idx !== undefined && !isNaN(idx) ? idx : undefined };
      }
    }
  }
  return {};
}

/**
 * Extract xfrm position/size from a raw placeholder XML node.
 */
function getPhXfrm(phNode: SafeXmlNode): { position: Position; size: Size } | undefined {
  // Try spPr > xfrm first (most shapes)
  const spPr = phNode.child('spPr');
  if (spPr.exists()) {
    const xfrm = spPr.child('xfrm');
    if (xfrm.exists()) {
      const off = xfrm.child('off');
      const ext = xfrm.child('ext');
      const x = off.numAttr('x');
      const cx = ext.numAttr('cx');
      if (x !== undefined && cx !== undefined) {
        return {
          position: { x: emuToPx(off.numAttr('x') ?? 0), y: emuToPx(off.numAttr('y') ?? 0) },
          size: { w: emuToPx(ext.numAttr('cx') ?? 0), h: emuToPx(ext.numAttr('cy') ?? 0) },
        };
      }
    }
  }
  return undefined;
}

/**
 * Find a matching placeholder node by type and idx.
 * Matching rules (based on OOXML spec):
 * 1. Exact match on type AND idx
 * 2. Match on type only (if idx is undefined or not found)
 * 3. For "body" type, also check idx match only
 */
function findMatchingPlaceholder(
  placeholders: SafeXmlNode[],
  type?: string,
  idx?: number,
): SafeXmlNode | undefined {
  let typeMatch: SafeXmlNode | undefined;

  for (const ph of placeholders) {
    const info = getPhInfo(ph);

    // Exact match (type + idx)
    if (type !== undefined && info.type === type && idx !== undefined && info.idx === idx) {
      return ph;
    }

    // Type-only match
    if (type !== undefined && info.type === type) {
      if (!typeMatch) typeMatch = ph;
    }

    // idx-only match (for body/content placeholders that may omit type)
    if (idx !== undefined && info.idx === idx && type === undefined && info.type === undefined) {
      return ph;
    }
  }

  // For placeholders without type (defaults to "body"), match by idx
  if (type === undefined && idx !== undefined) {
    for (const ph of placeholders) {
      const info = getPhInfo(ph);
      if (info.idx === idx) return ph;
    }
  }

  return typeMatch;
}

/**
 * Find a matching layout placeholder (PlaceholderEntry); use entry.absoluteXfrm when present.
 */
function findMatchingLayoutPlaceholder(
  placeholders: PlaceholderEntry[],
  type?: string,
  idx?: number,
): PlaceholderEntry | undefined {
  let typeMatch: PlaceholderEntry | undefined;

  for (const entry of placeholders) {
    const info = getPhInfo(entry.node);

    if (type !== undefined && info.type === type && idx !== undefined && info.idx === idx) {
      return entry;
    }
    if (type !== undefined && info.type === type && !typeMatch) {
      typeMatch = entry;
    }
    if (idx !== undefined && info.idx === idx && type === undefined && info.type === undefined) {
      return entry;
    }
  }
  if (type === undefined && idx !== undefined) {
    for (const entry of placeholders) {
      if (getPhInfo(entry.node).idx === idx) return entry;
    }
  }
  return typeMatch;
}

/**
 * Walk through all slide nodes (including group children recursively)
 * and fill in missing position/size from layout/master placeholders.
 */
function resolvePlaceholderInheritance(pres: PresentationData): void {
  for (let i = 0; i < pres.slides.length; i++) {
    const slide = pres.slides[i];
    const layoutPath = pres.slideToLayout.get(i);
    const layout = layoutPath ? pres.layouts.get(layoutPath) : undefined;
    const masterPath = layoutPath ? pres.layoutToMaster.get(layoutPath) : undefined;
    const master = masterPath ? pres.masters.get(masterPath) : undefined;

    resolveNodesPlaceholders(slide.nodes, layout, master);
  }
}

/** Extract bodyPr from a placeholder shape node (layout or master). */
function getPhBodyPr(phNode: SafeXmlNode): SafeXmlNode | undefined {
  const txBody = phNode.child('txBody');
  if (!txBody.exists()) return undefined;
  const bodyPr = txBody.child('bodyPr');
  return bodyPr.exists() ? bodyPr : undefined;
}

function resolveNodesPlaceholders(
  nodes: SlideNode[],
  layout: LayoutData | undefined,
  master: MasterData | undefined,
): void {
  for (const node of nodes) {
    // Recursively handle group children
    if (node.nodeType === 'group' && 'children' in node) {
      // Group children are raw SafeXmlNode, not parsed yet — skip
      // (they get parsed during rendering in GroupRenderer)
    }

    if (!node.placeholder) continue;

    const { type, idx } = node.placeholder;
    const sizeIsEmpty = node.size.w === 0 && node.size.h === 0;
    const positionLooksDefault = node.position.y < 5; // y=0 or near top → use layout position

    if (layout) {
      const layoutMatch = findMatchingLayoutPlaceholder(layout.placeholders, type, idx);
      if (layoutMatch) {
        const xfrm = layoutMatch.absoluteXfrm ?? getPhXfrm(layoutMatch.node);
        if (xfrm) {
          if (sizeIsEmpty) {
            node.position = xfrm.position;
            node.size = xfrm.size;
          } else if (positionLooksDefault) {
            node.position = xfrm.position;
          }
        }

        // Inherit bodyPr from layout placeholder for text rendering (anchor, insets, etc.)
        if ('textBody' in node && node.textBody) {
          const layoutBodyPr = getPhBodyPr(layoutMatch.node);
          if (layoutBodyPr) {
            node.textBody.layoutBodyProperties = layoutBodyPr;
          }
        }

        if (xfrm) continue;
      }
    }

    if (master) {
      const match = findMatchingPlaceholder(master.placeholders, type, idx);
      if (match) {
        const xfrm = getPhXfrm(match);
        if (xfrm) {
          if (sizeIsEmpty) {
            node.position = xfrm.position;
            node.size = xfrm.size;
          } else if (positionLooksDefault) {
            node.position = xfrm.position;
          }
        }

        // Inherit bodyPr from master placeholder as fallback
        if ('textBody' in node && node.textBody && !node.textBody.layoutBodyProperties) {
          const masterBodyPr = getPhBodyPr(match);
          if (masterBodyPr) {
            node.textBody.layoutBodyProperties = masterBodyPr;
          }
        }
      }
    }
  }
}
