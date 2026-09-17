import { resolveRelTarget } from '../parser/RelParser';
import { getMimeType } from '../utils/media';
import { arrayBufferToBase64 } from '../utils/mediaWebConvert';
/**
 * Serializes ChartNodeData to pptxtojson CommonChart or ScatterChart.
 * Reads chart XML from presentation.charts; extracts chartType, series data,
 * colors, and chart-type-specific properties (barDir, marker, holeSize, etc.).
 */

import type { ChartNodeData } from '../model/nodes/ChartNode';
import type { RenderContext } from './RenderContext';
import type {
  ChartType,
  CommonChart,
  ScatterChart,
  ChartItem,
  ChartValue,
  ChartXLabel,
  ScatterChartData,
} from '../adapter/types';
import { SafeXmlNode } from '../parser/XmlParser';
import type { ChartFill, ImportedChartAxis, ImportedChartStyle } from '@openmaic/dsl';
import { resolveColorToCss, resolveColor } from './StyleResolver';

const PX_TO_PT = 0.75;

function pxToPt(px: number): number {
  return Number((px * PX_TO_PT).toFixed(4));
}

const OOXML_CHART_TYPES: string[] = [
  'lineChart',
  'line3DChart',
  'barChart',
  'bar3DChart',
  'pieChart',
  'pie3DChart',
  'doughnutChart',
  'areaChart',
  'area3DChart',
  'scatterChart',
  'bubbleChart',
  'radarChart',
  'stockChart',
  'surfaceChart',
  'surface3DChart',
];

function mapToChartType(ooxmlName: string): ChartType {
  if (OOXML_CHART_TYPES.includes(ooxmlName)) return ooxmlName as ChartType;
  return 'barChart';
}

// ---------------------------------------------------------------------------
// XML Data Extraction Helpers
// ---------------------------------------------------------------------------

function extractStringValues(refNode: SafeXmlNode): string[] {
  let cache = refNode.child('strRef').exists()
    ? refNode.child('strRef').child('strCache')
    : refNode.child('strCache');

  if (!cache.exists()) {
    cache = refNode.child('numRef').exists()
      ? refNode.child('numRef').child('numCache')
      : refNode.child('numCache');
    if (!cache.exists()) return [];
    return extractNumCacheAsStrings(cache);
  }

  const ptCount = cache.child('ptCount').numAttr('val') ?? 0;
  const values: string[] = new Array(ptCount).fill('');
  for (const pt of cache.children('pt')) {
    const idx = pt.numAttr('idx');
    if (idx !== undefined) values[idx] = pt.child('v').text();
  }
  return values;
}

function formatExcelSerialDate(raw: string, formatCode: string): string {
  if (!/m.*月.*d.*日/i.test(formatCode)) return raw;
  if (raw.trim() === '') return raw;
  const serial = Number(raw);
  if (!Number.isFinite(serial)) return raw;
  const utc = Date.UTC(1899, 11, 30) + serial * 24 * 60 * 60 * 1000;
  const d = new Date(utc);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

function extractNumCacheAsStrings(cache: SafeXmlNode): string[] {
  const ptCount = cache.child('ptCount').numAttr('val') ?? 0;
  const defaultFormatCode = cache.child('formatCode').text();
  const values: string[] = new Array(ptCount).fill('');
  for (const pt of cache.children('pt')) {
    const idx = pt.numAttr('idx');
    if (idx !== undefined) {
      const raw = pt.child('v').text();
      const formatCode = pt.attr('formatCode') ?? pt.attr('c:formatCode') ?? defaultFormatCode;
      values[idx] = formatExcelSerialDate(raw, formatCode);
    }
  }
  return values;
}

function extractNumericValues(refNode: SafeXmlNode): number[] {
  const cache = refNode.child('numRef').exists()
    ? refNode.child('numRef').child('numCache')
    : refNode.child('numCache');
  if (!cache.exists()) return [];

  const ptCount = cache.child('ptCount').numAttr('val') ?? 0;
  const values: number[] = new Array(ptCount).fill(0);
  for (const pt of cache.children('pt')) {
    const idx = pt.numAttr('idx');
    if (idx !== undefined) {
      const v = parseFloat(pt.child('v').text());
      values[idx] = isNaN(v) ? 0 : v;
    }
  }
  return values;
}

function extractSeriesName(txNode: SafeXmlNode): string {
  const strRef = txNode.child('strRef');
  if (strRef.exists()) {
    const pts = strRef.child('strCache').children('pt');
    if (pts.length > 0) return pts[0].child('v').text();
  }
  const v = txNode.child('v');
  if (v.exists()) return v.text();
  return '';
}

// ---------------------------------------------------------------------------
// Color Extraction
// ---------------------------------------------------------------------------

function resolveColorHex(fillNode: SafeXmlNode, ctx: RenderContext): string | undefined {
  try {
    const { color } = resolveColor(fillNode, ctx);
    return color.startsWith('#') ? color : `#${color}`;
  } catch {
    return undefined;
  }
}

function getThemeColors(ctx: RenderContext): string[] {
  const colors: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const hex = ctx.theme.colorScheme.get(`accent${i}`) ?? '000000';
    colors.push(hex.startsWith('#') ? hex : `#${hex}`);
  }
  return colors;
}

/**
 * Extract per-series (or per-data-point for pie) explicit colors from XML.
 * Falls back to theme accent colors for missing entries.
 */
function extractSeriesColors(
  chartTypeNode: SafeXmlNode,
  ctx: RenderContext,
  isPie: boolean,
): string[] {
  const themeColors = getThemeColors(ctx);
  const colors: string[] = [];

  if (isPie) {
    const ser = chartTypeNode.child('ser');
    if (!ser.exists()) return themeColors;
    for (const dPt of ser.children('dPt')) {
      const fill = dPt.child('spPr').child('solidFill');
      if (fill.exists()) {
        const hex = resolveColorHex(fill, ctx);
        if (hex) {
          colors.push(hex);
          continue;
        }
      }
      colors.push(themeColors[colors.length % themeColors.length]);
    }
    if (colors.length === 0) return themeColors;
    return colors;
  }

  for (const ser of chartTypeNode.children('ser')) {
    let hex: string | undefined;
    const spPr = ser.child('spPr');
    if (spPr.exists()) {
      const solidFill = spPr.child('solidFill');
      if (solidFill.exists()) hex = resolveColorHex(solidFill, ctx);
      if (!hex) {
        const lnFill = spPr.child('ln').child('solidFill');
        if (lnFill.exists()) hex = resolveColorHex(lnFill, ctx);
      }
    }
    if (!hex) {
      const markerFill = ser.child('marker').child('spPr').child('solidFill');
      if (markerFill.exists()) hex = resolveColorHex(markerFill, ctx);
      if (!hex) {
        const markerLnFill = ser.child('marker').child('spPr').child('ln').child('solidFill');
        if (markerLnFill.exists()) hex = resolveColorHex(markerLnFill, ctx);
      }
    }
    colors.push(hex || themeColors[colors.length % themeColors.length]);
  }

  return colors.length > 0 ? colors : themeColors;
}

// ---------------------------------------------------------------------------
// Chart Data Extraction
// ---------------------------------------------------------------------------

function extractCommonChartData(chartTypeNode: SafeXmlNode): ChartItem[] {
  const items: ChartItem[] = [];
  for (const ser of chartTypeNode.children('ser')) {
    const name = extractSeriesName(ser.child('tx'));
    const order = ser.child('order').numAttr('val') ?? items.length;

    const cat = ser.child('cat');
    const categories = extractStringValues(cat);

    const xlabels: ChartXLabel = {};
    for (let i = 0; i < categories.length; i++) {
      if (categories[i]) xlabels[String(i)] = categories[i];
    }

    const val = ser.child('val');
    const numValues = extractNumericValues(val);

    const values: ChartValue[] = numValues.map((y, i) => ({
      x: String(i),
      y,
    }));

    items.push({ key: name || String(order), values, xlabels });
  }
  return items;
}

function extractScatterChartData(chartTypeNode: SafeXmlNode): ScatterChartData {
  const xArr: number[] = [];
  const yArr: number[] = [];
  const ser = chartTypeNode.child('ser');
  if (!ser.exists()) return [xArr, yArr];

  const xValNode = ser.child('xVal');
  const yValNode = ser.child('yVal');
  if (xValNode.exists()) {
    xArr.push(...extractNumericValues(xValNode));
  }
  if (yValNode.exists()) {
    yArr.push(...extractNumericValues(yValNode));
  }
  return [xArr, yArr];
}

function chartFill(spPr: SafeXmlNode, ctx: RenderContext): ChartFill | undefined {
  if (spPr.child('noFill').exists()) return 'transparent';
  const solid = spPr.child('solidFill');
  if (solid.exists()) return resolveColorToCss(solid, ctx);
  const grad = spPr.child('gradFill');
  const lin = grad.child('lin');
  if (!lin.exists()) return undefined;
  const stops = grad
    .child('gsLst')
    .children('gs')
    .map((gs) => ({
      offset: Math.max(0, Math.min(1, (gs.numAttr('pos') ?? 0) / 100000)),
      color: resolveColorToCss(gs, ctx),
    }))
    .sort((a, b) => a.offset - b.offset);
  if (!stops.length) return undefined;
  const rad = (((lin.numAttr('ang') ?? 0) / 60000) * Math.PI) / 180;
  const dx = Math.cos(rad),
    dy = Math.sin(rad);
  const span = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    type: 'linear',
    x: 0.5 - dx / (2 * span),
    y: 0.5 - dy / (2 * span),
    x2: 0.5 + dx / (2 * span),
    y2: 0.5 + dy / (2 * span),
    colorStops: stops,
  };
}
function chartBool(node: SafeXmlNode): boolean | undefined {
  if (!node.exists()) return undefined;
  return !['0', 'false'].includes(node.attr('val') ?? '1');
}
function chartAxis(
  node: SafeXmlNode,
  ctx: RenderContext,
  sourceFormat?: string,
): ImportedChartAxis | undefined {
  if (!node.exists()) return undefined;
  const label = node.child('txPr').child('p').child('pPr').child('defRPr');
  const line = node.child('spPr').child('ln');
  const grid = node.child('majorGridlines');
  const gridFill = grid.child('spPr').child('ln').child('solidFill');
  const fill = line.child('solidFill');
  const labelFill = label.child('solidFill');
  const deleted = chartBool(node.child('delete'));
  const numFmt = node.child('numFmt');
  // sourceLinked defaults to true. Cached series formats describe the linked
  // data; preserve the axis format when that information is unavailable.
  const linked = !['0', 'false'].includes(numFmt.attr('sourceLinked') ?? '1');
  return {
    show: deleted === undefined ? undefined : !deleted,
    gridlines: grid.exists() && !grid.child('spPr').child('ln').child('noFill').exists(),
    gridlineColor: gridFill.exists() ? resolveColorToCss(gridFill, ctx) : undefined,
    lineColor: fill.exists() ? resolveColorToCss(fill, ctx) : undefined,
    lineVisible: line.exists() ? !line.child('noFill').exists() : undefined,
    labelVisible: node.child('tickLblPos').exists()
      ? node.child('tickLblPos').attr('val') !== 'none'
      : undefined,
    labelColor: labelFill.exists() ? resolveColorToCss(labelFill, ctx) : undefined,
    labelFontSize: label.numAttr('sz') === undefined ? undefined : label.numAttr('sz')! / 100,
    labelBold: label.attr('b') === undefined ? undefined : ['1', 'true'].includes(label.attr('b')!),
    min: node.child('scaling').child('min').numAttr('val'),
    max: node.child('scaling').child('max').numAttr('val'),
    majorUnit: node.child('majorUnit').numAttr('val'),
    numberFormat: linked ? (sourceFormat ?? numFmt.attr('formatCode')) : numFmt.attr('formatCode'),
  };
}
function chartPicture(
  spPr: SafeXmlNode,
  ctx: RenderContext,
  chartPath: string,
): string | undefined {
  const fill = spPr.child('blipFill');
  // Only stretch fills with an uncropped rectangle are supported here.
  if (!fill.child('stretch').exists() || fill.child('srcRect').exists()) return;
  const rect = fill.child('stretch').child('fillRect');
  if (['l', 't', 'r', 'b'].some((key) => rect.numAttr(key))) return;
  const rid = fill.child('blip').attr('r:embed') ?? fill.child('blip').attr('embed');
  const rel = rid ? ctx.presentation.chartRels?.get(chartPath)?.get(rid) : undefined;
  if (!rel || rel.targetMode === 'External') return;
  const path = resolveRelTarget(chartPath.slice(0, chartPath.lastIndexOf('/')), rel.target);
  if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return;
  const data = ctx.presentation.media?.get(path);
  if (!data) return;
  return `data:${getMimeType(path)};base64,${arrayBufferToBase64(data)}`;
}

function barStyle(
  chart: SafeXmlNode,
  plot: SafeXmlNode,
  ctx: RenderContext,
  chartPath: string,
): ImportedChartStyle {
  const showLabel = (node: SafeXmlNode): boolean | undefined => {
    if (chartBool(node.child('delete')) === true) return false;
    return chartBool(node.child('showVal'));
  };
  const sourceFormats = chart
    .children('ser')
    .map((ser) =>
      ser.child('val').child('numRef').child('numCache').child('formatCode').text().trim(),
    );
  // A shared axis with mixed/missing source formats has no unambiguous cache
  // format. Keep its saved format instead of guessing from the first series.
  const sourceFormat =
    sourceFormats.length > 0 &&
    sourceFormats[0] &&
    sourceFormats.every((format) => format === sourceFormats[0])
      ? sourceFormats[0]
      : undefined;
  const style: ImportedChartStyle = {
    series: chart.children('ser').map((ser) => {
      const pointFills: Record<string, ChartFill> = {};
      const pointImages: Record<string, string> = {};
      for (const point of ser.children('dPt')) {
        const idx = point.child('idx').numAttr('val');
        const fill = chartFill(point.child('spPr'), ctx);
        const image = chartPicture(point.child('spPr'), ctx, chartPath);
        if (idx !== undefined && image) pointImages[String(idx)] = image;
        if (idx !== undefined && fill !== undefined) pointFills[String(idx)] = fill;
      }
      return {
        fill: chartFill(ser.child('spPr'), ctx),
        pointFills,
        pointImages,
        showValue: showLabel(ser.child('dLbls')) ?? showLabel(chart.child('dLbls')),
      };
    }),
    categoryAxis: chartAxis(plot.child('catAx'), ctx),
    valueAxis: chartAxis(plot.child('valAx'), ctx, sourceFormat),
    gapWidth: chart.child('gapWidth').numAttr('val'),
  };
  const layout = plot.child('layout').child('manualLayout');
  const x = layout.child('x').numAttr('val'),
    y = layout.child('y').numAttr('val');
  const w = layout.child('w').numAttr('val'),
    h = layout.child('h').numAttr('val');
  if (
    layout.child('layoutTarget').attr('val') === 'inner' &&
    layout.child('xMode').attr('val') === 'edge' &&
    layout.child('yMode').attr('val') === 'edge' &&
    x !== undefined &&
    y !== undefined &&
    w !== undefined &&
    h !== undefined &&
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= 1.001 &&
    y + h <= 1.001
  ) {
    style.plotArea = { x, y, w, h };
  }
  return style;
}

// ---------------------------------------------------------------------------
// Main Serializer
// ---------------------------------------------------------------------------

export function chartToElement(
  node: ChartNodeData,
  ctx: RenderContext,
  _order: number,
): CommonChart | ScatterChart {
  const order = node.xmlOrder;
  const left = pxToPt(node.position.x);
  const top = pxToPt(node.position.y);
  const width = pxToPt(node.size.w);
  const height = pxToPt(node.size.h);

  const chartRoot = ctx.presentation.charts.get(node.chartPath);
  let chartType: ChartType = 'barChart';
  let chartTypeNode: SafeXmlNode | undefined;
  let plotArea: SafeXmlNode | undefined;

  if (chartRoot?.exists()) {
    const chart = chartRoot.child('chart');
    plotArea = chart.exists() ? chart.child('plotArea') : chartRoot.child('plotArea');
    if (plotArea?.exists()) {
      const lineChart = plotArea.child('lineChart');
      const areaChart = plotArea.child('areaChart');
      if (lineChart.exists() && areaChart.exists()) {
        chartType = 'areaChart';
        chartTypeNode = lineChart;
      } else {
        for (const name of OOXML_CHART_TYPES) {
          const el = plotArea.child(name);
          if (el.exists()) {
            chartType = mapToChartType(name);
            chartTypeNode = el;
            break;
          }
        }
      }
    }
  }

  const isPie = ['pieChart', 'pie3DChart', 'doughnutChart'].includes(chartType);
  const colors = chartTypeNode
    ? extractSeriesColors(chartTypeNode, ctx, isPie)
    : getThemeColors(ctx);

  if (chartType === 'scatterChart' || chartType === 'bubbleChart') {
    const data: ScatterChartData = chartTypeNode
      ? extractScatterChartData(chartTypeNode)
      : [[], []];
    const result: ScatterChart = {
      type: 'chart',
      left,
      top,
      width,
      height,
      data,
      colors,
      chartType,
      order,
    };
    return result;
  }

  const data: ChartItem[] = chartTypeNode ? extractCommonChartData(chartTypeNode) : [];

  const result: CommonChart = {
    type: 'chart',
    left,
    top,
    width,
    height,
    data,
    colors,
    chartType: chartType as CommonChart['chartType'],
    order,
  };

  if (chartTypeNode && plotArea && chartType === 'barChart') {
    result.importedStyle = barStyle(chartTypeNode, plotArea, ctx, node.chartPath);
  }

  if (chartTypeNode) {
    const barDir = chartTypeNode.child('barDir').attr('val');
    if (barDir === 'bar' || barDir === 'col') result.barDir = barDir;

    const grouping = chartTypeNode.child('grouping').attr('val');
    if (grouping) result.grouping = grouping;

    if (chartTypeNode.child('marker').exists()) result.marker = true;

    const holeSize = chartTypeNode.child('holeSize').attr('val');
    if (holeSize) result.holeSize = holeSize;

    const scatterStyle = chartTypeNode.child('scatterStyle').attr('val');
    if (scatterStyle) result.style = scatterStyle;

    const radarStyle = chartTypeNode.child('radarStyle').attr('val');
    if (radarStyle) result.style = radarStyle;
  }

  return result;
}
