import type { SafeXmlNode } from '../parser/XmlParser';
import type { RenderContext } from './RenderContext';
import { resolveColor } from './StyleResolver';
import { hexToRgb } from '../utils/color';

/** Preserve an explicit DrawingML two-color mapping in a portable image. */
export function applyDuotoneToDataUrl(
  src: string,
  duotone: SafeXmlNode,
  ctx: RenderContext,
): string {
  if (!duotone.exists() || !src.startsWith('data:image/')) return src;
  const nodes = duotone.allChildren();
  if (nodes.length !== 2) return src;
  const colors = nodes.map((node) => resolveColor(node, ctx));
  // Non-opaque endpoint colors require an additional luminance/alpha composite.
  if (colors.some((color) => color.alpha !== 1)) return src;
  const [dark, light] = colors.map((color) => hexToRgb(color.color));
  const transfer = (['r', 'g', 'b'] as const)
    .map(
      (channel) =>
        `<feFunc${channel.toUpperCase()} type="table" tableValues="${dark[channel] / 255} ${light[channel] / 255}"/>`,
    )
    .join('');
  const escaped = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000" preserveAspectRatio="none"><defs><filter id="duotone" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/><feComponentTransfer>${transfer}<feFuncA type="identity"/></feComponentTransfer></filter></defs><image href="${escaped}" width="1000" height="1000" preserveAspectRatio="none" filter="url(#duotone)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
