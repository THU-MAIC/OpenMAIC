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
import { resolveColor } from './StyleResolver';

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
