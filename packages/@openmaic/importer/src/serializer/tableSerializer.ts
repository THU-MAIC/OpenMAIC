/**
 * Serializes TableNodeData to pptxtojson Table element.
 *
 * Style resolution follows TableRenderer.ts architecture:
 *   getStyleSections returns an ordered array of style parts
 *   (wholeTbl → band → firstRow/lastRow/firstCol/lastCol).
 *   Later sections override earlier ones for fill, borders, and text props.
 *   Direct cell tcPr always takes highest priority.
 *
 * Aligned with src1/table.js for output format and
 * pptx-renderer-main/TableRenderer.ts for resolution logic.
 */

import type { TableNodeData } from '../model/nodes/TableNode';
import type { RenderContext } from './RenderContext';
import { renderTextBody } from './textSerializer';
import type { Table, TableCell as OutCell, Border } from '../adapter/types';
import { resolveColor, resolveLineStyle } from './StyleResolver';
import { SafeXmlNode } from '../parser/XmlParser';
import { emuToPx } from '../parser/units';
import { hexToRgb } from '../utils/color';

const PX_TO_PT = 0.75;

function pxToPt(px: number): number {
  return Number((px * PX_TO_PT).toFixed(4));
}

function ensureHex(color: string): string {
  const s = color.trim();
  if (s === 'transparent') return '#000000';
  if (s.startsWith('#')) return s;
  if (/^(rgba?|hsla?)\(/i.test(s)) return s;
  return `#${s}`;
}

function dashKindToBorderType(dashKind: string): Border['borderType'] {
  switch (dashKind) {
    case 'dot':
    case 'sysDot':
      return 'dotted';
    case 'dash':
    case 'sysDash':
    case 'lgDash':
    case 'dashDot':
    case 'lgDashDot':
    case 'lgDashDotDot':
    case 'sysDashDot':
    case 'sysDashDotDot':
      return 'dashed';
    default:
      return 'solid';
  }
}

// ---------------------------------------------------------------------------
// Color resolution helpers
// ---------------------------------------------------------------------------

function resolveColorToHex(node: SafeXmlNode, ctx: RenderContext): string | undefined {
  if (!node.exists()) return undefined;
  const { color, alpha } = resolveColor(node, ctx);
  const hex = color.startsWith('#') ? color : `#${color}`;
  if (alpha < 1) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Table style lookup
// ---------------------------------------------------------------------------

function findTableStyle(
  tableStyleId: string | undefined,
  ctx: RenderContext,
): SafeXmlNode | undefined {
  if (!tableStyleId || !ctx.presentation.tableStyles) return undefined;
  const tblStyleLst = ctx.presentation.tableStyles;
  for (const style of tblStyleLst.children('tblStyle')) {
    if (style.attr('styleId') === tableStyleId) {
      return style;
    }
  }
  for (const style of tblStyleLst.children()) {
    if (style.localName === 'tblStyle' && style.attr('styleId') === tableStyleId) {
      return style;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Style sections — mirrors TableRenderer.ts getStyleSections (line 54)
// ---------------------------------------------------------------------------

function getStyleSections(
  tblStyle: SafeXmlNode,
  rowIdx: number,
  colIdx: number,
  totalRows: number,
  totalCols: number,
  tblPr: SafeXmlNode | undefined,
): SafeXmlNode[] {
  const sections: SafeXmlNode[] = [];

  // Matches TableRenderer flag(attrName, childName); both params are always
  // identical in practice so we use a single param for brevity.
  const flag = (attrName: string, _childName?: string): boolean => {
    if (!tblPr) return false;
    const attr = tblPr.attr(attrName);
    if (attr !== undefined) return attr === '1' || attr === 'true';
    const ch = tblPr.child(attrName);
    if (ch.exists()) {
      const val = ch.attr('val');
      return val !== '0' && val !== 'false';
    }
    return false;
  };

  const bandRow =
    tblPr?.attr('bandRow') === '1' ||
    tblPr?.attr('bandRow') === 'true' ||
    tblPr?.child('bandRow').exists();
  const bandCol =
    tblPr?.attr('bandCol') === '1' ||
    tblPr?.attr('bandCol') === 'true' ||
    tblPr?.child('bandCol').exists();
  const isFirstRow = flag('firstRow', 'firstRow');
  const isLastRow = flag('lastRow', 'lastRow');
  const isFirstCol = flag('firstCol', 'firstCol');
  const isLastCol = flag('lastCol', 'lastCol');

  // wholeTbl is the base (lowest priority)
  const wholeTbl = tblStyle.child('wholeTbl');
  if (wholeTbl.exists()) sections.push(wholeTbl);

  // Banding (applied on top of wholeTbl)
  if (bandRow) {
    const effectiveRow = isFirstRow ? rowIdx - 1 : rowIdx;
    if (effectiveRow >= 0 && effectiveRow % 2 === 1) {
      const band = tblStyle.child('band2H');
      if (band.exists()) sections.push(band);
    } else if (effectiveRow >= 0 && effectiveRow % 2 === 0) {
      const band = tblStyle.child('band1H');
      if (band.exists()) sections.push(band);
    }
  }

  if (bandCol) {
    if (colIdx % 2 === 1) {
      const band = tblStyle.child('band2V');
      if (band.exists()) sections.push(band);
    } else {
      const band = tblStyle.child('band1V');
      if (band.exists()) sections.push(band);
    }
  }

  // Special rows/cols (highest priority, override banding)
  if (isFirstRow && rowIdx === 0) {
    const s = tblStyle.child('firstRow');
    if (s.exists()) sections.push(s);
  }
  if (isLastRow && rowIdx === totalRows - 1) {
    const s = tblStyle.child('lastRow');
    if (s.exists()) sections.push(s);
  }
  if (isFirstCol && colIdx === 0) {
    const s = tblStyle.child('firstCol');
    if (s.exists()) sections.push(s);
  }
  if (isLastCol && colIdx === totalCols - 1) {
    const s = tblStyle.child('lastCol');
    if (s.exists()) sections.push(s);
  }

  return sections;
}

// ---------------------------------------------------------------------------
// tcTxStyle text props — mirrors TableRenderer.ts getEffectiveTableStyleTextProps (line 151)
// Output type omits italic/fontFamily since TableCell type doesn't carry them.
// ---------------------------------------------------------------------------

interface TableStyleTextProps {
  color?: string;
  bold?: boolean;
}

function getEffectiveTableStyleTextProps(
  sections: SafeXmlNode[],
  ctx: RenderContext,
): TableStyleTextProps | undefined {
  for (let i = sections.length - 1; i >= 0; i--) {
    const tcTxStyle = sections[i].child('tcTxStyle');
    if (!tcTxStyle.exists()) continue;

    const props: TableStyleTextProps = {};

    const b = tcTxStyle.attr('b');
    if (b === 'on') props.bold = true;
    else if (b === 'off') props.bold = false;

    for (const child of tcTxStyle.allChildren()) {
      const tag = child.localName;
      if (
        tag === 'schemeClr' ||
        tag === 'solidFill' ||
        tag === 'srgbClr' ||
        tag === 'scrgbClr' ||
        tag === 'prstClr' ||
        tag === 'sysClr'
      ) {
        const { color, alpha } = resolveColor(child, ctx);
        const hex = color.startsWith('#') ? color : `#${color}`;
        if (alpha < 1) {
          const { r, g, b: bl } = hexToRgb(hex);
          props.color = `rgba(${r},${g},${bl},${alpha.toFixed(3)})`;
        } else {
          props.color = hex;
        }
        break;
      }
    }

    return props;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fill resolution from tcStyle — mirrors TableRenderer.ts applyStyleFill (line 223)
// Returns color string instead of mutating DOM.
// ---------------------------------------------------------------------------

function applyStyleFill(tcStyle: SafeXmlNode, ctx: RenderContext): string | undefined {
  const fill = tcStyle.child('fill');
  if (!fill.exists()) return undefined;

  // solidFill
  const solidFill = fill.child('solidFill');
  if (solidFill.exists()) {
    return resolveColorToHex(solidFill, ctx);
  }

  // fillRef (theme fill reference)
  const fillRef = fill.child('fillRef');
  if (fillRef.exists()) {
    return resolveColorToHex(fillRef, ctx);
  }

  // noFill — explicitly no fill
  const noFill = fill.child('noFill');
  if (noFill.exists()) return '';

  return undefined;
}

// ---------------------------------------------------------------------------
// Border resolution from ln / lnRef
// ---------------------------------------------------------------------------

function resolveBorderFromLn(ln: SafeXmlNode, ctx: RenderContext): Border | undefined {
  if (!ln.exists()) return undefined;

  const noFill = ln.child('noFill');
  if (noFill.exists()) return undefined;

  const { width: widthPx, color, dashKind } = resolveLineStyle(ln, ctx);
  if (widthPx <= 0 || color === 'transparent') return undefined;

  return {
    borderColor: ensureHex(color),
    borderWidth: widthPx * PX_TO_PT,
    borderType: dashKindToBorderType(dashKind),
  };
}

function resolveBorderFromLnRef(lnRef: SafeXmlNode, ctx: RenderContext): Border | undefined {
  if (!lnRef.exists()) return undefined;
  const idx = lnRef.numAttr('idx') ?? 0;
  if (idx === 0) return undefined;

  const { color, alpha } = resolveColor(lnRef, ctx);
  const hex = color.startsWith('#') ? color : `#${color}`;

  let widthPx = 1;
  if (ctx.theme.lineStyles && ctx.theme.lineStyles.length >= idx) {
    const themeLn = ctx.theme.lineStyles[idx - 1];
    const themeW = themeLn.numAttr('w') ?? 12700;
    widthPx = emuToPx(themeW);
  }

  if (widthPx <= 0) return undefined;

  let borderColor: string;
  if (alpha < 1) {
    const { r, g, b } = hexToRgb(hex);
    borderColor = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  } else {
    borderColor = hex;
  }

  return {
    borderColor,
    borderWidth: widthPx * PX_TO_PT,
    borderType: 'solid',
  };
}

// ---------------------------------------------------------------------------
// Borders from tcStyle tcBdr — mirrors TableRenderer.ts applyStyleBorders (line 267)
// Returns border map instead of mutating DOM.
// ---------------------------------------------------------------------------

type BorderSide = 'top' | 'bottom' | 'left' | 'right';

function applyStyleBorders(
  tcStyle: SafeXmlNode,
  ctx: RenderContext,
  rowIdx: number,
  colIdx: number,
  totalRows: number,
  totalCols: number,
): Partial<Record<BorderSide, Border>> {
  const tcBdr = tcStyle.child('tcBdr');
  if (!tcBdr.exists()) return {};

  const result: Partial<Record<BorderSide, Border>> = {};

  const mapping: Array<[string, BorderSide]> = [
    ['top', 'top'],
    ['bottom', 'bottom'],
    ['left', 'left'],
    ['right', 'right'],
  ];

  // insideH → borderBottom for non-last rows, borderTop for non-first rows
  const insideH = tcBdr.child('insideH');
  if (insideH.exists()) {
    if (rowIdx < totalRows - 1) mapping.push(['insideH', 'bottom']);
    if (rowIdx > 0) mapping.push(['insideH', 'top']);
  }

  // insideV → borderRight for non-last cols, borderLeft for non-first cols
  const insideV = tcBdr.child('insideV');
  if (insideV.exists()) {
    if (colIdx < totalCols - 1) mapping.push(['insideV', 'right']);
    if (colIdx > 0) mapping.push(['insideV', 'left']);
  }

  for (const [xmlName, side] of mapping) {
    const sideNode = tcBdr.child(xmlName);
    if (!sideNode.exists()) continue;

    // Direct <a:ln>
    const ln = sideNode.child('ln');
    if (ln.exists()) {
      const border = resolveBorderFromLn(ln, ctx);
      if (border) result[side] = border;
      continue;
    }

    // <a:lnRef> — theme line style reference
    const lnRef = sideNode.child('lnRef');
    if (lnRef.exists()) {
      const border = resolveBorderFromLnRef(lnRef, ctx);
      if (border) result[side] = border;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Direct cell properties from tcPr — mirrors TableRenderer.ts applyCellProperties (line 538)
// Returns fill + border + vertical-anchor data instead of mutating DOM.
// (Margins are still rendering concerns and remain unexposed.)
// ---------------------------------------------------------------------------

interface CellDirectProps {
  fillColor?: string;
  // 显式 <a:noFill/> 时为 true：表格样式 firstRow/band/wholeTbl 的填充必须被清掉。
  // 用单独 flag 而不是 fillColor='' 以便和 "没定义 tcPr 填充" 区分。
  noFill?: boolean;
  vAlign?: 'up' | 'mid' | 'down';
  borders: Partial<Record<BorderSide, Border | null>>;
}

function applyCellProperties(tcPr: SafeXmlNode, ctx: RenderContext): CellDirectProps {
  const result: CellDirectProps = { borders: {} };

  // Vertical text alignment. OOXML spec: `t` (top, default), `ctr` (middle),
  // `b` (bottom). We follow the same vocabulary as Shape/Text vAlign.
  const anchor = tcPr.attr('anchor');
  if (anchor === 'ctr') result.vAlign = 'mid';
  else if (anchor === 'b') result.vAlign = 'down';
  else if (anchor === 't') result.vAlign = 'up';

  // Fill (overrides table style fill). solidFill 设色，noFill 清掉样式继承色——
  // 本 deck slide 2 教师表每个 cell 显式 <a:noFill/> 但表格样式 firstRow=accent1，
  // 不处理 noFill 会把整张表染成橙色。
  const solidFill = tcPr.child('solidFill');
  if (solidFill.exists()) {
    result.fillColor = resolveColorToHex(solidFill, ctx);
  } else if (tcPr.child('noFill').exists()) {
    result.noFill = true;
  }

  // Borders (override table style borders)
  const lnMap: Array<[string, BorderSide]> = [
    ['lnT', 'top'],
    ['lnB', 'bottom'],
    ['lnL', 'left'],
    ['lnR', 'right'],
  ];

  for (const [lnName, side] of lnMap) {
    const ln = tcPr.child(lnName);
    if (!ln.exists()) continue;

    // noFill explicitly clears any border set by table style
    if (ln.child('noFill').exists()) {
      result.borders[side] = null;
      continue;
    }

    const border = resolveBorderFromLn(ln, ctx);
    if (border) result.borders[side] = border;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Table background — mirrors TableRenderer.ts applyTableBackground (line 358)
// Returns color string instead of mutating DOM.
// ---------------------------------------------------------------------------

function applyTableBackground(tblStyle: SafeXmlNode, ctx: RenderContext): string | undefined {
  const tblBg = tblStyle.child('tblBg');
  if (!tblBg.exists()) return undefined;

  const fillRef = tblBg.child('fillRef');
  if (fillRef.exists()) return resolveColorToHex(fillRef, ctx);

  const solidFill = tblBg.child('solidFill');
  if (solidFill.exists()) return resolveColorToHex(solidFill, ctx);

  return undefined;
}

// ---------------------------------------------------------------------------
// Table-level borders — mirrors table.js getTableBorders (line 5)
// ---------------------------------------------------------------------------

function getTableBorders(tblStyle: SafeXmlNode, ctx: RenderContext): Table['borders'] {
  const borders: Table['borders'] = {};
  const tcBdr = tblStyle.child('wholeTbl').child('tcStyle').child('tcBdr');
  if (!tcBdr.exists()) return borders;

  const sides: BorderSide[] = ['bottom', 'top', 'left', 'right'];
  for (const side of sides) {
    const sideNode = tcBdr.child(side);
    if (!sideNode.exists()) continue;

    const ln = sideNode.child('ln');
    if (ln.exists()) {
      const b = resolveBorderFromLn(ln, ctx);
      if (b) borders[side] = b;
      continue;
    }

    const lnRef = sideNode.child('lnRef');
    if (lnRef.exists()) {
      const b = resolveBorderFromLnRef(lnRef, ctx);
      if (b) borders[side] = b;
    }
  }

  return borders;
}

// ---------------------------------------------------------------------------
// Main serializer
// ---------------------------------------------------------------------------

export function tableToElement(node: TableNodeData, ctx: RenderContext, _order: number): Table {
  const order = node.xmlOrder;
  const left = pxToPt(node.position.x);
  const top = pxToPt(node.position.y);
  const width = pxToPt(node.size.w);
  const height = pxToPt(node.size.h);

  const tblPr = node.properties;
  const tblStyle = findTableStyle(node.tableStyleId, ctx);
  const tableBgColor = tblStyle ? applyTableBackground(tblStyle, ctx) : undefined;
  const borders = tblStyle ? getTableBorders(tblStyle, ctx) : {};

  const totalRows = node.rows.length;
  const totalCols = node.columns.length;

  const data: OutCell[][] = node.rows.map((row, rowIdx) =>
    row.cells.map((cell, colIdx): OutCell => {
      // --- Style sections cascade (wholeTbl → band → firstRow/lastRow/firstCol/lastCol) ---
      const sections = tblStyle
        ? getStyleSections(tblStyle, rowIdx, colIdx, totalRows, totalCols, tblPr)
        : [];

      // Apply fill: later sections override earlier
      let fillColor: string | undefined;
      for (const section of sections) {
        const tcStyle = section.child('tcStyle');
        if (!tcStyle.exists()) continue;
        const f = applyStyleFill(tcStyle, ctx);
        if (f !== undefined) fillColor = f || undefined;
      }

      // Apply borders: later sections override earlier
      const mergedBorders: OutCell['borders'] = {};
      for (const section of sections) {
        const tcStyle = section.child('tcStyle');
        if (!tcStyle.exists()) continue;
        const styleBorders = applyStyleBorders(tcStyle, ctx, rowIdx, colIdx, totalRows, totalCols);
        for (const side of ['top', 'bottom', 'left', 'right'] as const) {
          if (styleBorders[side]) mergedBorders[side] = styleBorders[side];
        }
      }

      // Text props from tcTxStyle
      const textProps =
        sections.length > 0 ? getEffectiveTableStyleTextProps(sections, ctx) : undefined;

      // Cell padding comes from tcPr marL/marR/marT/marB. OOXML defaults are
      // 91440 EMU (L/R) and 45720 EMU (T/B), which happens to match the shape
      // bodyPr defaults — but cells often set tighter margins (e.g. 9842 EMU)
      // and the cell's inner bodyPr is empty, so without this the renderer
      // applied 7.2pt padding instead of <1pt and text wrapped onto extra
      // lines, growing rows beyond rowHeights and overflowing the slide.
      const tcPr = cell.properties;
      const cellMargins = tcPr?.exists()
        ? {
            lIns: tcPr.numAttr('marL') ?? 91440,
            rIns: tcPr.numAttr('marR') ?? 91440,
            tIns: tcPr.numAttr('marT') ?? 45720,
            bIns: tcPr.numAttr('marB') ?? 45720,
          }
        : undefined;

      // Render HTML text with table style tcTxStyle applied as defaults
      // (run-level rPr still overrides — e.g. user-set red text on a white
      // header cell still shows red). This keeps HTML <span> color/bold in
      // sync with cell.fontColor/fontBold metadata so downstream renderers
      // that read span.style.color first (pptist) render correctly.
      const text = cell.textBody
        ? renderTextBody(cell.textBody, undefined, ctx, {
            cellTextColor: textProps?.color,
            cellTextBold: textProps?.bold,
            cellMargins,
          })
        : '';

      // Direct cell tcPr overrides (highest priority)
      // Mirrors TableRenderer.ts applyCellProperties (line 538)
      let vAlign: 'up' | 'mid' | 'down' | undefined;
      if (tcPr?.exists()) {
        const cellProps = applyCellProperties(tcPr, ctx);

        if (cellProps.fillColor) fillColor = cellProps.fillColor;
        else if (cellProps.noFill) fillColor = undefined;
        if (cellProps.vAlign) vAlign = cellProps.vAlign;

        for (const side of ['top', 'bottom', 'left', 'right'] as const) {
          const val = cellProps.borders[side];
          if (val === null) {
            delete mergedBorders[side];
          } else if (val) {
            mergedBorders[side] = val;
          }
        }
      }

      // Fallback fill: table background
      if (!fillColor && tableBgColor) fillColor = tableBgColor;

      const outCell: OutCell = {
        text,
        borders: mergedBorders,
      };

      if (cell.rowSpan > 1) outCell.rowSpan = cell.rowSpan;
      if (cell.gridSpan > 1) outCell.colSpan = cell.gridSpan;
      if (cell.vMerge) outCell.vMerge = 1;
      if (cell.hMerge) outCell.hMerge = 1;
      if (fillColor) outCell.fillColor = fillColor;
      if (textProps?.color) outCell.fontColor = textProps.color;
      if (textProps?.bold) outCell.fontBold = textProps.bold;
      if (vAlign) outCell.vAlign = vAlign;

      return outCell;
    }),
  );

  let rowHeights = node.rows.map((r) => pxToPt(r.height));
  // Fallback: when every row has h="0" in source XML (PowerPoint "auto row
  // height" mode), distribute the table's total height evenly across rows so
  // downstream renderers don't have to implement auto-fit logic themselves.
  if (rowHeights.length > 0 && rowHeights.every((h) => h === 0)) {
    const evenHeight = Number((height / rowHeights.length).toFixed(4));
    rowHeights = rowHeights.map(() => evenHeight);
  }
  const colWidths = node.columns.map((c) => pxToPt(c));
  const actualTableWidth = colWidths.reduce((sum, w) => sum + w, 0);

  return {
    type: 'table',
    left,
    top,
    width: actualTableWidth || width,
    height,
    data,
    borders,
    order,
    rowHeights,
    colWidths,
  };
}
