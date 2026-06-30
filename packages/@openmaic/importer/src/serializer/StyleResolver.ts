/**
 * Style resolver — converts OOXML color and fill nodes to CSS values.
 */

import { SafeXmlNode } from '../parser/XmlParser';
import { RenderContext } from './RenderContext';
import {
  applyColorModifiers,
  presetColorToHex,
  hexToRgb,
  hslToRgb,
  rgbToHex,
} from '../utils/color';
import type { ColorModifier } from '../utils/color';
import { pctToDecimal, angleToDeg, emuToPx } from '../parser/units';

// ---------------------------------------------------------------------------
// Color Resolution
// ---------------------------------------------------------------------------

/**
 * Build a cache key for a color node based on its tag, value, and modifiers.
 */
function buildColorCacheKey(colorNode: SafeXmlNode): string {
  const parts: string[] = [colorNode.localName, colorNode.attr('val') ?? ''];
  for (const child of colorNode.allChildren()) {
    const tag = child.localName;
    const val = child.attr('val');
    if (tag) parts.push(`${tag}:${val ?? ''}`);
    // Include nested color children for wrapper nodes
    for (const grandchild of child.allChildren()) {
      const gtag = grandchild.localName;
      const gval = grandchild.attr('val');
      if (gtag) parts.push(`${gtag}:${gval ?? ''}`);
    }
  }
  return parts.join('|');
}

/**
 * Collect OOXML color modifier children from a color node.
 * Modifiers are child elements like alpha, lumMod, lumOff, tint, shade, satMod, hueMod.
 */
function collectModifiers(colorNode: SafeXmlNode): ColorModifier[] {
  const modifiers: ColorModifier[] = [];
  for (const child of colorNode.allChildren()) {
    const name = child.localName;
    const val = child.numAttr('val');
    if (val !== undefined && name) {
      modifiers.push({ name, val });
    }
  }
  return modifiers;
}

/**
 * Resolve a scheme color name through the master colorMap then theme colorScheme.
 *
 * OOXML scheme colors use logical names (e.g., "tx1", "bg1", "accent1").
 * The master's colorMap remaps some of these (e.g., "tx1" -> "dk1").
 * The theme's colorScheme holds the actual hex values keyed by the mapped name.
 */
function resolveSchemeColor(schemeName: string, ctx: RenderContext): string {
  // Apply colorMap remapping (layout override takes priority)
  let mappedName = schemeName;
  if (ctx.layout.colorMapOverride) {
    const override = ctx.layout.colorMapOverride.get(schemeName);
    if (override) mappedName = override;
  }
  if (mappedName === schemeName) {
    const mapped = ctx.master.colorMap.get(schemeName);
    if (mapped) mappedName = mapped;
  }

  // Look up in theme color scheme
  const hex = ctx.theme.colorScheme.get(mappedName);
  if (hex) return hex;

  // Fallback: try the original name directly in theme
  const fallback = ctx.theme.colorScheme.get(schemeName);
  return fallback || '000000';
}

/**
 * Resolve an OOXML color node (srgbClr, schemeClr, sysClr, prstClr, hslClr, scrgbClr)
 * into a CSS-ready hex color and alpha value.
 */
export function resolveColor(
  colorNode: SafeXmlNode,
  ctx: RenderContext,
): { color: string; alpha: number } {
  // Check cache
  const cacheKey = buildColorCacheKey(colorNode);
  const cached = ctx.colorCache.get(cacheKey);
  if (cached) return cached;

  const result = resolveColorUncached(colorNode, ctx);
  ctx.colorCache.set(cacheKey, result);
  return result;
}

function resolveColorUncached(
  colorNode: SafeXmlNode,
  ctx: RenderContext,
  placeholderColorNode?: SafeXmlNode,
): { color: string; alpha: number } {
  // Iterate child elements to find the actual color type node
  for (const child of colorNode.allChildren()) {
    const tag = child.localName;
    const modifiers = collectModifiers(child);

    switch (tag) {
      case 'srgbClr': {
        const hex = child.attr('val') || '000000';
        return applyColorModifiers(hex, modifiers);
      }

      case 'schemeClr': {
        const scheme = child.attr('val') || 'tx1';
        if (scheme.toLowerCase() === 'phclr' && placeholderColorNode?.exists()) {
          const base = resolveColor(placeholderColorNode, ctx);
          const baseHex = base.color.startsWith('#') ? base.color.slice(1) : base.color;
          const adjusted = applyColorModifiers(baseHex, modifiers);
          return { color: adjusted.color, alpha: adjusted.alpha * base.alpha };
        }
        const hex = resolveSchemeColor(scheme, ctx);
        return applyColorModifiers(hex, modifiers);
      }

      case 'sysClr': {
        const hex = child.attr('lastClr') || child.attr('val') || '000000';
        return applyColorModifiers(hex, modifiers);
      }

      case 'prstClr': {
        const name = child.attr('val') || 'black';
        const hex = presetColorToHex(name) || '#000000';
        return applyColorModifiers(hex.replace('#', ''), modifiers);
      }

      case 'hslClr': {
        const hue = (child.numAttr('hue') ?? 0) / 60000; // 60000ths of degree -> degrees
        const sat = (child.numAttr('sat') ?? 0) / 100000; // percentage
        const lum = (child.numAttr('lum') ?? 0) / 100000;
        const rgb = hslToRgb(hue, sat, lum);
        const hex = rgbToHex(rgb.r, rgb.g, rgb.b).replace('#', '');
        return applyColorModifiers(hex, modifiers);
      }

      case 'scrgbClr': {
        // r, g, b are percentages (0-100000)
        const r = Math.round(((child.numAttr('r') ?? 0) / 100000) * 255);
        const g = Math.round(((child.numAttr('g') ?? 0) / 100000) * 255);
        const b = Math.round(((child.numAttr('b') ?? 0) / 100000) * 255);
        const hex = rgbToHex(r, g, b).replace('#', '');
        return applyColorModifiers(hex, modifiers);
      }

      default:
        // Not a recognized color child — continue looking
        break;
    }
  }

  // If the node itself is a color type (no wrapper)
  const selfTag = colorNode.localName;
  if (selfTag === 'srgbClr') {
    const hex = colorNode.attr('val') || '000000';
    return applyColorModifiers(hex, collectModifiers(colorNode));
  }
  if (selfTag === 'schemeClr') {
    const scheme = colorNode.attr('val') || 'tx1';
    if (scheme.toLowerCase() === 'phclr' && placeholderColorNode?.exists()) {
      const base = resolveColor(placeholderColorNode, ctx);
      const baseHex = base.color.startsWith('#') ? base.color.slice(1) : base.color;
      const adjusted = applyColorModifiers(baseHex, collectModifiers(colorNode));
      return { color: adjusted.color, alpha: adjusted.alpha * base.alpha };
    }
    const hex = resolveSchemeColor(scheme, ctx);
    return applyColorModifiers(hex, collectModifiers(colorNode));
  }
  if (selfTag === 'sysClr') {
    const hex = colorNode.attr('lastClr') || colorNode.attr('val') || '000000';
    return applyColorModifiers(hex, collectModifiers(colorNode));
  }
  if (selfTag === 'prstClr') {
    const name = colorNode.attr('val') || 'black';
    const hex = presetColorToHex(name) || '#000000';
    return applyColorModifiers(hex.replace('#', ''), collectModifiers(colorNode));
  }

  return { color: '#000000', alpha: 1 };
}

/**
 * Resolve a color node and return a CSS color string.
 * Convenience wrapper combining resolveColor + colorToCss.
 */
export function resolveColorToCss(node: SafeXmlNode, ctx: RenderContext): string {
  const { color, alpha } = resolveColor(node, ctx);
  return colorToCss(color, alpha);
}

/**
 * Convert a resolved color + alpha into a CSS rgba() string.
 */
function colorToCss(color: string, alpha: number): string {
  const hex = color.startsWith('#') ? color : `#${color}`;
  const { r, g, b } = hexToRgb(hex);
  if (alpha >= 1) {
    return hex;
  }
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

function resolveColorWithPlaceholder(
  colorNode: SafeXmlNode,
  ctx: RenderContext,
  placeholderColorNode?: SafeXmlNode,
): { color: string; alpha: number } {
  if (!placeholderColorNode?.exists()) return resolveColor(colorNode, ctx);
  return resolveColorUncached(colorNode, ctx, placeholderColorNode);
}

// ---------------------------------------------------------------------------
// Fill Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a fill from shape properties (spPr) into a CSS background value.
 *
 * Returns:
 *   - CSS color/gradient string for solidFill/gradFill
 *   - 'transparent' for noFill
 *   - '' for blipFill (handled by ImageRenderer) or no fill found (inherit)
 */
export function resolveFill(spPr: SafeXmlNode, ctx: RenderContext): string {
  // solidFill
  const solidFill = spPr.child('solidFill');
  if (solidFill.exists()) {
    const { color, alpha } = resolveColor(solidFill, ctx);
    return colorToCss(color, alpha);
  }

  // gradFill
  const gradFill = spPr.child('gradFill');
  if (gradFill.exists()) {
    return resolveGradient(gradFill, ctx);
  }

  // blipFill — handled externally by ImageRenderer
  const blipFill = spPr.child('blipFill');
  if (blipFill.exists()) {
    return '';
  }

  // pattFill — pattern fill rendered as CSS repeating gradient
  const pattFill = spPr.child('pattFill');
  if (pattFill.exists()) {
    return resolvePatternFill(pattFill, ctx);
  }

  // grpFill — inherit fill from parent group
  const grpFill = spPr.child('grpFill');
  if (grpFill.exists()) {
    if (ctx.groupFillNode) {
      return resolveFill(ctx.groupFillNode, ctx);
    }
    // No group fill context available — fall through to no fill
    return '';
  }

  // noFill
  const noFill = spPr.child('noFill');
  if (noFill.exists()) {
    return 'transparent';
  }

  // No fill found — inherit
  return '';
}

// ---------------------------------------------------------------------------
// Pattern Fill Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `<a:pattFill>` into a CSS background value using repeating gradients.
 *
 * OOXML defines 40+ pattern presets. We support the most common ones and
 * fall back to a simple foreground/background 50% mix for unknown patterns.
 */
function resolvePatternFill(pattFill: SafeXmlNode, ctx: RenderContext): string {
  const preset = pattFill.attr('prst') ?? 'solid';

  // Foreground and background colors
  let fg = '#000000';
  let bg = '#ffffff';

  const fgClr = pattFill.child('fgClr');
  if (fgClr.exists()) {
    const { color, alpha } = resolveColor(fgClr, ctx);
    fg = colorToCss(color, alpha);
  }

  const bgClr = pattFill.child('bgClr');
  if (bgClr.exists()) {
    const { color, alpha } = resolveColor(bgClr, ctx);
    bg = colorToCss(color, alpha);
  }

  // Size of pattern tile in px
  const s = 8;

  // Helper: returns CSS `background` shorthand with repeating pattern layer(s) over bg color.
  // Format: "<gradient-layer> 0 0/<size>, <bg-color-layer>"
  // This is a valid multi-layer CSS background shorthand.
  const pat = (gradient: string): string => `${gradient} 0 0/${s}px ${s}px, ${bg}`;
  const pat2 = (g1: string, g2: string): string =>
    `${g1} 0 0/${s}px ${s}px, ${g2} 0 0/${s}px ${s}px, ${bg}`;

  switch (preset) {
    // Solid fills
    case 'solid':
    case 'solidDmnd':
      return fg;

    // Percentage fills (dots on background)
    case 'pct5':
    case 'pct10':
    case 'pct20':
    case 'pct25':
      return pat(`radial-gradient(${fg} 1px, transparent 1px)`);
    case 'pct30':
    case 'pct40':
    case 'pct50':
      return pat(`radial-gradient(${fg} 1.5px, transparent 1.5px)`);
    case 'pct60':
    case 'pct70':
    case 'pct75':
    case 'pct80':
    case 'pct90':
      return pat(`radial-gradient(${fg} 2.5px, transparent 2.5px)`);

    // Horizontal lines
    case 'horz':
    case 'ltHorz':
    case 'narHorz':
    case 'dkHorz':
      return pat(
        `repeating-linear-gradient(0deg, ${fg} 0px, ${fg} 1px, transparent 1px, transparent ${s}px)`,
      );

    // Vertical lines
    case 'vert':
    case 'ltVert':
    case 'narVert':
    case 'dkVert':
      return pat(
        `repeating-linear-gradient(90deg, ${fg} 0px, ${fg} 1px, transparent 1px, transparent ${s}px)`,
      );

    // Diagonal lines (down-right)
    case 'dnDiag':
    case 'ltDnDiag':
    case 'narDnDiag':
    case 'dkDnDiag':
    case 'wdDnDiag':
      return pat(
        `repeating-linear-gradient(45deg, ${fg} 0px, ${fg} 1px, transparent 1px, transparent ${s}px)`,
      );

    // Diagonal lines (up-right)
    case 'upDiag':
    case 'ltUpDiag':
    case 'narUpDiag':
    case 'dkUpDiag':
    case 'wdUpDiag':
      return pat(
        `repeating-linear-gradient(-45deg, ${fg} 0px, ${fg} 1px, transparent 1px, transparent ${s}px)`,
      );

    // Grid (horizontal + vertical)
    case 'smGrid':
    case 'lgGrid':
    case 'cross':
      return pat2(
        `repeating-linear-gradient(0deg, ${fg} 0px, ${fg} 1px, transparent 1px, transparent ${s}px)`,
        `repeating-linear-gradient(90deg, ${fg} 0px, ${fg} 1px, transparent 1px, transparent ${s}px)`,
      );

    // Diagonal cross
    case 'smCheck':
    case 'lgCheck':
    case 'diagCross':
    case 'openDmnd':
      return pat2(
        `repeating-linear-gradient(45deg, ${fg} 0px, ${fg} 1px, transparent 1px, transparent ${s}px)`,
        `repeating-linear-gradient(-45deg, ${fg} 0px, ${fg} 1px, transparent 1px, transparent ${s}px)`,
      );

    // Dot patterns
    case 'dotGrid':
    case 'dotDmnd':
      return pat(`radial-gradient(${fg} 1px, transparent 1px)`);

    // Trellis / weave
    case 'trellis':
    case 'weave':
      return pat2(
        `repeating-linear-gradient(45deg, ${fg} 0px, ${fg} 2px, transparent 2px, transparent ${s}px)`,
        `repeating-linear-gradient(-45deg, ${fg} 0px, ${fg} 2px, transparent 2px, transparent ${s}px)`,
      );

    // Dash variants
    case 'dashDnDiag':
    case 'dashUpDiag':
    case 'dashHorz':
    case 'dashVert': {
      const angle = preset.includes('Dn')
        ? '45deg'
        : preset.includes('Up')
          ? '-45deg'
          : preset.includes('Horz')
            ? '0deg'
            : '90deg';
      return pat(
        `repeating-linear-gradient(${angle}, ${fg} 0px, ${fg} 3px, transparent 3px, transparent ${s}px)`,
      );
    }

    // Sphere / shingle — radial gradient approximation
    case 'sphere':
    case 'shingle':
    case 'plaid':
    case 'divot':
    case 'zigZag':
      return pat(`radial-gradient(${fg} 2px, transparent 2px)`);

    default:
      return bg;
  }
}

/**
 * Parse a gradient fill into a CSS gradient string.
 */
function resolveGradient(
  gradFill: SafeXmlNode,
  ctx: RenderContext,
  placeholderColorNode?: SafeXmlNode,
): string {
  // Parse gradient stops
  const gsLst = gradFill.child('gsLst');
  const stops: { position: number; color: string }[] = [];

  for (const gs of gsLst.children('gs')) {
    const pos = gs.numAttr('pos') ?? 0;
    const posPercent = pctToDecimal(pos) * 100;
    const { color, alpha } = resolveColorWithPlaceholder(gs, ctx, placeholderColorNode);
    stops.push({ position: posPercent, color: colorToCss(color, alpha) });
  }

  if (stops.length === 0) {
    return '';
  }

  // Sort stops by position
  stops.sort((a, b) => a.position - b.position);

  const stopsStr = stops.map((s) => `${s.color} ${s.position.toFixed(1)}%`).join(', ');

  // Determine gradient type
  const lin = gradFill.child('lin');
  if (lin.exists()) {
    const angle = angleToDeg(lin.numAttr('ang') ?? 0);
    // OOXML angle 0 = top-to-bottom in the gradient coordinate system
    // CSS angle 0 = bottom-to-top, so we need to adjust
    const cssAngle = (angle + 90) % 360;
    return `linear-gradient(${cssAngle.toFixed(1)}deg, ${stopsStr})`;
  }

  const path = gradFill.child('path');
  if (path.exists()) {
    const pathType = path.attr('path');
    if (pathType === 'circle' || pathType === 'shape' || pathType === 'rect') {
      // OOXML path gradients: stop pos=0 = fillToRect center, pos=100000 = shape edge.
      // CSS radial-gradient: 0% = center, 100% = edge.
      // Conventions match — no reversal needed.

      // Resolve fillToRect center point
      const ftr = path.child('fillToRect');
      let cx = 50;
      let cy = 50;
      if (ftr.exists()) {
        const l = (ftr.numAttr('l') ?? 0) / 100000;
        const t = (ftr.numAttr('t') ?? 0) / 100000;
        const r = (ftr.numAttr('r') ?? 0) / 100000;
        const b = (ftr.numAttr('b') ?? 0) / 100000;
        cx = ((l + (1 - r)) / 2) * 100;
        cy = ((t + (1 - b)) / 2) * 100;
      }

      if (pathType === 'rect') {
        // Rectangular gradient (L∞ norm / Chebyshev distance): creates cross/X contour
        // pattern. CSS can't do this natively; approximate by overlaying horizontal and
        // vertical linear gradients with a radial gradient as fallback.
        // The SVG path in ShapeRenderer uses the proper blend approach.
        return `radial-gradient(closest-side at ${cx.toFixed(1)}% ${cy.toFixed(1)}%, ${stopsStr})`;
      }

      return `radial-gradient(ellipse at ${cx.toFixed(1)}% ${cy.toFixed(1)}%, ${stopsStr})`;
    }
  }

  // Default to linear top-to-bottom
  return `linear-gradient(180deg, ${stopsStr})`;
}

// ---------------------------------------------------------------------------
// Line Style Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a line (outline) node into CSS-compatible properties.
 *
 * @param ln       The `<a:ln>` node from spPr
 * @param ctx      Render context
 * @param lnRef    Optional `<a:lnRef>` from `<p:style>` — provides fallback color
 *                 when `<a:ln>` has no explicit solidFill (common for connectors)
 */
export function resolveLineStyle(
  ln: SafeXmlNode,
  ctx: RenderContext,
  lnRef?: SafeXmlNode,
): { width: number; color: string; dash: string; dashKind: string } {
  // Width: a:ln@w is in EMU, convert to px
  const widthEmu = ln.numAttr('w') ?? 0;
  let width = emuToPx(widthEmu);

  // Color from solidFill child
  let color = 'transparent';
  const solidFill = ln.child('solidFill');
  if (solidFill.exists()) {
    const phClr = solidFill.child('schemeClr');
    const usesPlaceholder = phClr.exists() && (phClr.attr('val') ?? '').toLowerCase() === 'phclr';
    if (usesPlaceholder && lnRef && lnRef.exists()) {
      // Theme line styles often use schemeClr=phClr and expect the concrete color from lnRef.
      const base = resolveColor(lnRef, ctx);
      const baseHex = base.color.startsWith('#') ? base.color.slice(1) : base.color;
      const adjusted = applyColorModifiers(baseHex, collectModifiers(phClr));
      color = colorToCss(adjusted.color, adjusted.alpha * base.alpha);
    } else {
      const resolved = resolveColor(solidFill, ctx);
      color = colorToCss(resolved.color, resolved.alpha);
    }
  } else if (lnRef && lnRef.exists() && (lnRef.numAttr('idx') ?? 0) > 0) {
    const idx = lnRef.numAttr('idx') ?? 0;
    // Look up theme line style for width, color, and dash
    if (idx > 0 && ctx.theme.lineStyles && ctx.theme.lineStyles.length >= idx) {
      const themeLn = ctx.theme.lineStyles[idx - 1];
      // Get width from theme line if not set on the explicit ln node
      if (width === 0) {
        const themeW = themeLn.numAttr('w') ?? 0;
        width = emuToPx(themeW);
      }
      // Get color: prefer lnRef's own color child, fall back to theme line's solidFill
      const resolved = resolveColor(lnRef, ctx);
      color = colorToCss(resolved.color, resolved.alpha);
    } else {
      // Fallback: use lnRef color directly, approximate width from idx
      const resolved = resolveColor(lnRef, ctx);
      color = colorToCss(resolved.color, resolved.alpha);
      if (width === 0 && idx > 0) {
        width = idx * 0.75; // approximate: idx 1 = ~0.75px, idx 2 = ~1.5px
      }
    }
  }

  // Width fallback should still use lnRef/theme even when explicit solidFill is present on <a:ln>.
  if (width === 0 && lnRef && lnRef.exists()) {
    const idx = lnRef.numAttr('idx') ?? 0;
    if (idx > 0 && ctx.theme.lineStyles && ctx.theme.lineStyles.length >= idx) {
      const themeLn = ctx.theme.lineStyles[idx - 1];
      const themeW = themeLn.numAttr('w') ?? 0;
      width = emuToPx(themeW);
    } else if (idx > 0) {
      width = idx * 0.75;
    }
  }

  // Dash pattern
  let dash = 'solid';
  let dashKind = 'solid';
  const prstDash = ln.child('prstDash');
  if (prstDash.exists()) {
    const val = prstDash.attr('val') || 'solid';
    dashKind = val;
    dash = ooxmlDashToCss(val);
  }

  // If no dash from explicit ln, check theme line style
  if (dash === 'solid' && lnRef && lnRef.exists()) {
    const idx = lnRef.numAttr('idx') ?? 0;
    if (idx > 0 && ctx.theme.lineStyles && ctx.theme.lineStyles.length >= idx) {
      const themeLn = ctx.theme.lineStyles[idx - 1];
      const themeDash = themeLn.child('prstDash');
      if (themeDash.exists()) {
        dashKind = themeDash.attr('val') || 'solid';
        dash = ooxmlDashToCss(dashKind);
      }
    }
  }

  // OOXML default line width: when <a:ln> has explicit stroke info (color or dash)
  // but no `w` attribute (and no theme width), use 9525 EMU (0.75pt = 1px) per spec.
  if (width === 0 && (color !== 'transparent' || prstDash.exists())) {
    width = emuToPx(9525);
  }

  return { width, color, dash, dashKind };
}

/**
 * Map OOXML preset dash values to CSS border-style.
 */
function ooxmlDashToCss(val: string): string {
  switch (val) {
    case 'solid':
      return 'solid';
    case 'dot':
    case 'sysDot':
      return 'dotted';
    case 'dash':
    case 'sysDash':
    case 'lgDash':
      return 'dashed';
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
// Gradient Fill Resolution (structured data for SVG use)
// ---------------------------------------------------------------------------

export interface GradientFillData {
  type: 'linear' | 'radial';
  stops: Array<{ position: number; color: string }>;
  /** SVG gradient interpolation space; OOXML gradients visually match linearRGB more closely. */
  colorInterpolation?: 'linearRGB' | 'sRGB';
  /** OOXML angle in degrees (0 = top-to-bottom). Only relevant for linear gradients. */
  angle: number;
  /** Radial gradient center X as fraction 0–1. Default 0.5. */
  cx?: number;
  /** Radial gradient center Y as fraction 0–1. Default 0.5. */
  cy?: number;
  /** OOXML path type for radial gradients: 'rect', 'circle', or 'shape'. */
  pathType?: string;
}

function resolveGradientFillNode(
  gradFill: SafeXmlNode,
  ctx: RenderContext,
  placeholderColorNode?: SafeXmlNode,
): GradientFillData | null {
  const gsLst = gradFill.child('gsLst');
  const stops: Array<{ position: number; color: string }> = [];

  for (const gs of gsLst.children('gs')) {
    const pos = gs.numAttr('pos') ?? 0;
    const posPercent = pctToDecimal(pos) * 100;
    const { color, alpha } = resolveColorWithPlaceholder(gs, ctx, placeholderColorNode);
    stops.push({ position: posPercent, color: colorToCss(color, alpha) });
  }

  if (stops.length === 0) return null;
  stops.sort((a, b) => a.position - b.position);

  const lin = gradFill.child('lin');
  if (lin.exists()) {
    const angle = angleToDeg(lin.numAttr('ang') ?? 0);
    return { type: 'linear', stops, angle, colorInterpolation: 'linearRGB' };
  }

  const path = gradFill.child('path');
  if (path.exists()) {
    const pathType = path.attr('path');
    if (pathType === 'circle' || pathType === 'shape' || pathType === 'rect') {
      const ftr = path.child('fillToRect');
      let cx = 0.5;
      let cy = 0.5;
      if (ftr.exists()) {
        const l = (ftr.numAttr('l') ?? 0) / 100000;
        const t = (ftr.numAttr('t') ?? 0) / 100000;
        const r = (ftr.numAttr('r') ?? 0) / 100000;
        const b = (ftr.numAttr('b') ?? 0) / 100000;
        cx = (l + (1 - r)) / 2;
        cy = (t + (1 - b)) / 2;
      }
      return {
        type: 'radial',
        stops,
        angle: 0,
        cx,
        cy,
        pathType: pathType,
        colorInterpolation: 'linearRGB',
      };
    }
  }

  return { type: 'linear', stops, angle: 0, colorInterpolation: 'linearRGB' };
}

/**
 * Resolve a gradient fill from `spPr` into structured data suitable for
 * creating SVG gradient elements. Returns null if no gradient fill is present.
 */
export function resolveGradientFill(
  spPr: SafeXmlNode,
  ctx: RenderContext,
): GradientFillData | null {
  let gradFill = spPr.child('gradFill');

  // grpFill: inherit gradient from parent group's grpSpPr
  if (!gradFill.exists() && spPr.child('grpFill').exists() && ctx.groupFillNode) {
    gradFill = ctx.groupFillNode.child('gradFill');
  }

  if (!gradFill.exists()) return null;

  return resolveGradientFillNode(gradFill, ctx);
}

export function resolveThemeFillReference(
  fillRef: SafeXmlNode,
  ctx: RenderContext,
): { fillCss: string; gradientFillData: GradientFillData | null } {
  const idx = fillRef.numAttr('idx') ?? 0;
  // ECMA-376: idx=0 (或 1000) 表示 "不应用 style matrix 中的填充"。
  // 内部 <a:schemeClr> 只是 phClr 替换用的占位色——当没有引用样式时它
  // 没有应用对象，不能当作实际填充返回（否则会把本应无填充的描边形状
  // 当成实心色块渲染，例如本 deck slide 5 中间那段 custGeom 灰色连接线
  // 被错染成大块橙色）。
  if (idx <= 0) {
    return { fillCss: '', gradientFillData: null };
  }
  if ((ctx.theme.fillStyles?.length ?? 0) < idx) {
    return { fillCss: resolveColorToCss(fillRef, ctx), gradientFillData: null };
  }

  const themeFill = ctx.theme.fillStyles[idx - 1];
  if (!themeFill?.exists()) {
    return { fillCss: resolveColorToCss(fillRef, ctx), gradientFillData: null };
  }

  if (themeFill.localName === 'solidFill') {
    const resolved = resolveColorWithPlaceholder(themeFill, ctx, fillRef);
    return { fillCss: colorToCss(resolved.color, resolved.alpha), gradientFillData: null };
  }

  if (themeFill.localName === 'gradFill') {
    return {
      fillCss: resolveGradient(themeFill, ctx, fillRef),
      gradientFillData: resolveGradientFillNode(themeFill, ctx, fillRef),
    };
  }

  if (themeFill.localName === 'pattFill') {
    return { fillCss: resolvePatternFill(themeFill, ctx), gradientFillData: null };
  }

  if (themeFill.localName === 'noFill') {
    return { fillCss: 'transparent', gradientFillData: null };
  }

  return { fillCss: resolveColorToCss(fillRef, ctx), gradientFillData: null };
}

// ---------------------------------------------------------------------------
// Gradient Stroke Resolution
// ---------------------------------------------------------------------------

export interface GradientStrokeData {
  stops: Array<{ position: number; color: string }>;
  angle: number;
  width: number;
  colorInterpolation?: 'linearRGB' | 'sRGB';
}

/**
 * Resolve a gradient stroke from an `<a:ln>` node that contains `<a:gradFill>`.
 * Returns gradient stop data, angle, and line width — or null if no gradient fill is present.
 */
export function resolveGradientStroke(
  ln: SafeXmlNode,
  ctx: RenderContext,
): GradientStrokeData | null {
  const gradFill = ln.child('gradFill');
  if (!gradFill.exists()) return null;

  const gsLst = gradFill.child('gsLst');
  const stops: Array<{ position: number; color: string }> = [];

  for (const gs of gsLst.children('gs')) {
    const pos = gs.numAttr('pos') ?? 0;
    const posPercent = pctToDecimal(pos) * 100;
    const { color, alpha } = resolveColor(gs, ctx);
    const cssColor = colorToCss(color, alpha);
    stops.push({ position: posPercent, color: cssColor });
  }

  if (stops.length === 0) return null;
  stops.sort((a, b) => a.position - b.position);

  const lin = gradFill.child('lin');
  let angle = 0;
  if (lin.exists()) {
    angle = angleToDeg(lin.numAttr('ang') ?? 0);
  }

  const widthEmu = ln.numAttr('w') ?? 0;
  let width = emuToPx(widthEmu);
  // OOXML default when w is omitted is typically 1 pt; avoid invisible gradient stroke
  if (width <= 0) width = 1;

  return { stops, angle, width, colorInterpolation: 'linearRGB' };
}
