/**
 * Maps StyleResolver line style to pptxtojson Border + borderStrokeDasharray.
 */

import type { SafeXmlNode } from '../parser/XmlParser';
import type { RenderContext } from './RenderContext';
import { resolveLineStyle } from './StyleResolver';
import type { Border } from '../adapter/types';

const PX_TO_PT = 0.75;

/**
 * Compute SVG-style dash array string from OOXML dash kind and stroke width (px).
 * Matches ShapeRenderer's svgDashArrayForKind logic for consistent output.
 */
export function dashArrayForKind(dashKind: string, strokeWidthPx: number): string {
  const w = Math.max(strokeWidthPx, 1);
  switch (dashKind) {
    case 'dot':
    case 'sysDot':
      return `${w},${w * 2}`;
    case 'dash':
    case 'sysDash':
      return `${w * 4},${w * 2}`;
    case 'lgDash':
      return `${w * 8},${w * 3}`;
    case 'dashDot':
    case 'sysDashDot':
      return `${w * 4},${w * 2},${w},${w * 2}`;
    case 'lgDashDot':
      return `${w * 8},${w * 3},${w},${w * 3}`;
    case 'lgDashDotDot':
    case 'sysDashDotDot':
      return `${w * 8},${w * 3},${w},${w * 2},${w},${w * 2}`;
    default:
      return '';
  }
}

/**
 * Map OOXML dash kind to types.Border.borderType.
 */
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

function ensureHex(color: string): string {
  const s = color.trim();
  if (s === 'transparent') return '#000000';
  if (s.startsWith('#')) return s;
  // resolveLineStyle can hand back CSS functions like `rgba(...)` / `hsl(...)`
  // when alpha is involved. Prefixing `#` to those produces `#rgba(...)`, which
  // browsers silently drop, so the border disappears entirely.
  if (/^(rgba?|hsla?)\(/i.test(s)) return s;
  return `#${s}`;
}

export interface BorderResult {
  border: Border;
  borderStrokeDasharray: string;
}

/**
 * Resolve ln (a:ln) node to types.Border and borderStrokeDasharray.
 * Width from resolveLineStyle is in px; we convert to pt for output.
 */
export function lineStyleToBorder(
  ln: SafeXmlNode,
  ctx: RenderContext,
  lnRef?: SafeXmlNode,
): BorderResult {
  const { width: widthPx, color, dashKind } = resolveLineStyle(ln, ctx, lnRef);
  const borderWidthPt = widthPx * PX_TO_PT;
  return {
    border: {
      borderColor: ensureHex(color),
      borderWidth: borderWidthPt,
      borderType: dashKindToBorderType(dashKind),
    },
    borderStrokeDasharray: dashArrayForKind(dashKind, widthPx),
  };
}
