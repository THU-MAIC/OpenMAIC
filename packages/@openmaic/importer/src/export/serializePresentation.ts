/**
 * Serialize PresentationData into a plain JSON-serializable structure.
 * Strips all SafeXmlNode references and re-parses group children.
 */

import { PresentationData } from '../model/Presentation';
import { SlideNode } from '../model/Slide';
import { ShapeNodeData, TextBody } from '../model/nodes/ShapeNode';
import { PicNodeData } from '../model/nodes/PicNode';
import { TableNodeData, TableRow, TableCell } from '../model/nodes/TableNode';
import { GroupNodeData } from '../model/nodes/GroupNode';
import { ChartNodeData } from '../model/nodes/ChartNode';
import { BaseNodeData } from '../model/nodes/BaseNode';
import { parseShapeNode } from '../model/nodes/ShapeNode';
import { parsePicNode } from '../model/nodes/PicNode';
import { parseTableNode } from '../model/nodes/TableNode';
import { parseGroupNode } from '../model/nodes/GroupNode';
import { SafeXmlNode } from '../parser/XmlParser';

// ---------------------------------------------------------------------------
// Serialized Types (JSON-safe)
// ---------------------------------------------------------------------------

interface SerializedParagraph {
  level: number;
  text: string;
}

interface SerializedTextBody {
  paragraphs: SerializedParagraph[];
  totalText: string;
}

interface SerializedCell {
  text: string;
  gridSpan: number;
  rowSpan: number;
}

interface SerializedRow {
  height: number;
  cells: SerializedCell[];
}

export interface SerializedNode {
  id: string;
  name: string;
  nodeType: string;
  position: { x: number; y: number };
  size: { w: number; h: number };
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  presetGeometry?: string;
  textBody?: SerializedTextBody;
  columns?: number[];
  rows?: SerializedRow[];
  tableStyleId?: string;
  blipEmbed?: string;
  chartPath?: string;
  children?: SerializedNode[];
}

export interface SerializedSlide {
  index: number;
  nodes: SerializedNode[];
}

export interface SerializedPresentation {
  width: number;
  height: number;
  slideCount: number;
  slides: SerializedSlide[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeTextBody(tb: TextBody | undefined): SerializedTextBody | undefined {
  if (!tb) return undefined;
  const paragraphs: SerializedParagraph[] = tb.paragraphs.map((p) => ({
    level: p.level,
    text: p.runs.map((r) => r.text).join(''),
  }));
  const totalText = paragraphs.map((p) => p.text).join('\n');
  if (!totalText.trim()) return undefined;
  return { paragraphs, totalText };
}

function serializeCell(cell: TableCell): SerializedCell {
  const text = cell.textBody
    ? cell.textBody.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')
    : '';
  return { text, gridSpan: cell.gridSpan, rowSpan: cell.rowSpan };
}

function serializeRow(row: TableRow): SerializedRow {
  return {
    height: row.height,
    cells: row.cells.map(serializeCell),
  };
}

/**
 * Parse a raw XML child node from a group into a typed node.
 */
function parseGroupChild(childXml: SafeXmlNode): BaseNodeData | undefined {
  const tag = childXml.localName;
  switch (tag) {
    case 'sp':
    case 'cxnSp':
      return parseShapeNode(childXml);
    case 'pic':
      return parsePicNode(childXml);
    case 'grpSp':
      return parseGroupNode(childXml);
    case 'graphicFrame': {
      const graphic = childXml.child('graphic');
      const graphicData = graphic.child('graphicData');
      if (graphicData.child('tbl').exists()) {
        return parseTableNode(childXml);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function serializeNode(node: SlideNode | BaseNodeData): SerializedNode {
  const base: SerializedNode = {
    id: node.id,
    name: node.name,
    nodeType: node.nodeType,
    position: { x: node.position.x, y: node.position.y },
    size: { w: node.size.w, h: node.size.h },
    rotation: node.rotation,
    flipH: node.flipH,
    flipV: node.flipV,
  };

  switch (node.nodeType) {
    case 'shape': {
      const s = node as ShapeNodeData;
      base.presetGeometry = s.presetGeometry;
      base.textBody = serializeTextBody(s.textBody);
      break;
    }
    case 'picture': {
      const p = node as PicNodeData;
      base.blipEmbed = p.blipEmbed;
      break;
    }
    case 'table': {
      const t = node as TableNodeData;
      base.columns = [...t.columns];
      base.rows = t.rows.map(serializeRow);
      base.tableStyleId = t.tableStyleId;
      break;
    }
    case 'chart': {
      const c = node as ChartNodeData;
      base.chartPath = c.chartPath;
      break;
    }
    case 'group': {
      const g = node as GroupNodeData;
      const children: SerializedNode[] = [];
      for (const childXml of g.children) {
        try {
          const parsed = parseGroupChild(childXml);
          if (parsed) children.push(serializeNode(parsed));
        } catch {
          // skip unparseable group children
        }
      }
      base.children = children;
      break;
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

export function serializePresentation(pres: PresentationData): SerializedPresentation {
  return {
    width: pres.width,
    height: pres.height,
    slideCount: pres.slides.length,
    slides: pres.slides.map((slide, i) => ({
      index: i,
      nodes: slide.nodes.map(serializeNode),
    })),
  };
}
