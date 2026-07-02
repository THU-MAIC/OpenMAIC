/**
 * Chart node — represents a chart embedded in a graphicFrame element.
 */

import { SafeXmlNode } from '../../parser/XmlParser';
import { RelEntry, resolveRelTarget } from '../../parser/RelParser';
import { BaseNodeData, parseBaseProps } from './BaseNode';

export interface ChartNodeData extends BaseNodeData {
  nodeType: 'chart';
  chartPath: string; // e.g. "ppt/charts/chart1.xml"
}

/**
 * Parse a graphicFrame containing a chart reference into a ChartNodeData.
 *
 * @param graphicFrame  The graphicFrame XML node
 * @param slideRels     Relationship entries for the containing slide
 * @param slidePath     Full path of the slide (e.g. "ppt/slides/slide1.xml")
 */
export function parseChartNode(
  graphicFrame: SafeXmlNode,
  slideRels: Map<string, RelEntry>,
  slidePath: string,
): ChartNodeData | undefined {
  const base = parseBaseProps(graphicFrame);

  // Find chart relationship
  const graphic = graphicFrame.child('graphic');
  const graphicData = graphic.child('graphicData');

  // Find the chart reference - look for c:chart element with r:id
  let chartRId: string | undefined;
  for (const child of graphicData.allChildren()) {
    if (child.localName === 'chart') {
      chartRId = child.attr('r:id') || child.attr('id');
      break;
    }
  }

  if (!chartRId) return undefined;

  const rel = slideRels.get(chartRId);
  if (!rel) return undefined;

  // Resolve chart path relative to slide
  const slideDir = slidePath.substring(0, slidePath.lastIndexOf('/'));
  const chartPath = resolveRelTarget(slideDir, rel.target);

  return {
    ...base,
    nodeType: 'chart' as const,
    chartPath,
  };
}
