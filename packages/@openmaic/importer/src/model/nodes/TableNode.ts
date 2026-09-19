/**
 * Table node parser — handles graphicFrame elements containing a:tbl.
 */

import { SafeXmlNode } from '../../parser/XmlParser';
import { BaseNodeData, parseBaseProps } from './BaseNode';
import { TextBody, parseTextBody } from './ShapeNode';
import { emuToPx } from '../../parser/units';

export interface TableCell {
  gridSpan: number;
  rowSpan: number;
  hMerge: boolean;
  vMerge: boolean;
  textBody?: TextBody;
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  properties?: SafeXmlNode;
}

export interface TableRow {
  height: number;
  cells: TableCell[];
}

export interface TableNodeData extends BaseNodeData {
  nodeType: 'table';
  columns: number[];
  rows: TableRow[];
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  properties?: SafeXmlNode;
  tableStyleId?: string;
}

/**
 * Parse a single table cell (`a:tc`).
 */
function parseCell(tcNode: SafeXmlNode): TableCell {
  const gridSpan = tcNode.numAttr('gridSpan') ?? 1;
  const rowSpan = tcNode.numAttr('rowSpan') ?? 1;
  const hMerge = tcNode.attr('hMerge') === '1' || tcNode.attr('hMerge') === 'true';
  const vMerge = tcNode.attr('vMerge') === '1' || tcNode.attr('vMerge') === 'true';

  // Cell text body
  const txBody = tcNode.child('txBody');
  const textBody = parseTextBody(txBody);

  // Cell properties
  const tcPr = tcNode.child('tcPr');

  return {
    gridSpan,
    rowSpan,
    hMerge,
    vMerge,
    textBody,
    properties: tcPr.exists() ? tcPr : undefined,
  };
}

/**
 * Parse a table row (`a:tr`).
 */
function parseRow(trNode: SafeXmlNode): TableRow {
  const height = emuToPx(trNode.numAttr('h') ?? 0);
  const cells: TableCell[] = [];

  for (const tcNode of trNode.children('tc')) {
    cells.push(parseCell(tcNode));
  }

  return { height, cells };
}

/**
 * Locate the `a:tbl` element inside a graphicFrame.
 * Path: `a:graphic > a:graphicData > a:tbl`
 */
function findTable(frameNode: SafeXmlNode): SafeXmlNode {
  const graphic = frameNode.child('graphic');
  const graphicData = graphic.child('graphicData');
  return graphicData.child('tbl');
}

/**
 * Extract the table style ID from tblPr.
 * It can be in `a:tblStyle@val` or as a direct `tblStyle` attribute.
 */
function extractTableStyleId(tblPr: SafeXmlNode): string | undefined {
  // Try <a:tableStyleId>{UUID}</a:tableStyleId> (most common in OOXML)
  const tableStyleIdNode = tblPr.child('tableStyleId');
  if (tableStyleIdNode.exists()) {
    return tableStyleIdNode.text() || tableStyleIdNode.attr('val') || undefined;
  }
  // Try <a:tblStyle val="{UUID}"/>
  const tblStyleNode = tblPr.child('tblStyle');
  if (tblStyleNode.exists()) {
    return tblStyleNode.attr('val') ?? (tblStyleNode.text() || undefined);
  }
  // Try direct attribute
  return tblPr.attr('tblStyle') ?? undefined;
}

/**
 * Parse a graphicFrame XML node containing a table into TableNodeData.
 */
export function parseTableNode(frameNode: SafeXmlNode): TableNodeData {
  const base = parseBaseProps(frameNode);
  const tbl = findTable(frameNode);

  // --- Column widths ---
  const tblGrid = tbl.child('tblGrid');
  const columns: number[] = [];
  for (const gridCol of tblGrid.children('gridCol')) {
    columns.push(emuToPx(gridCol.numAttr('w') ?? 0));
  }

  // --- Rows ---
  const rows: TableRow[] = [];
  for (const trNode of tbl.children('tr')) {
    rows.push(parseRow(trNode));
  }

  // --- Table properties ---
  const tblPr = tbl.child('tblPr');
  const tableStyleId = extractTableStyleId(tblPr);

  return {
    ...base,
    nodeType: 'table',
    columns,
    rows,
    properties: tblPr.exists() ? tblPr : undefined,
    tableStyleId,
  };
}
