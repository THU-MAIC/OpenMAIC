// ============================================================================
// OOXML Color Utilities
// Full color manipulation for PowerPoint XML color processing
// ============================================================================

// ---------------------------------------------------------------------------
// Basic Color Conversions
// ---------------------------------------------------------------------------

/**
 * Parse a hex color string (with or without '#') into RGB components.
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace(/^#/, '');
  if (cleaned.length !== 6 && cleaned.length !== 3) {
    return { r: 0, g: 0, b: 0 };
  }
  const full =
    cleaned.length === 3
      ? cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2]
      : cleaned;
  const num = parseInt(full, 16);
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

/**
 * Convert RGB components (0-255 each) to a 6-digit hex string with '#' prefix.
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [clamp(r), clamp(g), clamp(b)].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert RGB (0-255) to HSL (h: 0-360, s: 0-1, l: 0-1).
 */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
        break;
      case gn:
        h = ((bn - rn) / d + 2) * 60;
        break;
      case bn:
        h = ((rn - gn) / d + 4) * 60;
        break;
    }
  }

  return { h, s, l };
}

/**
 * Convert HSL (h: 0-360, s: 0-1, l: 0-1) to RGB (0-255).
 */
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360; // normalize hue
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));

  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }

  const hueToRgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hNorm = h / 360;

  return {
    r: Math.round(hueToRgb(p, q, hNorm + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hNorm) * 255),
    b: Math.round(hueToRgb(p, q, hNorm - 1 / 3) * 255),
  };
}

// ---------------------------------------------------------------------------
// sRGB ↔ Linear RGB conversion (IEC 61966-2-1)
// PowerPoint applies tint/shade in linear (scene-referred) space.
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

// ---------------------------------------------------------------------------
// OOXML Color Modifiers
// ---------------------------------------------------------------------------

/**
 * Apply tint modifier (mix toward white in linear RGB space).
 * OOXML spec: tint val is 0-100000 where 100000 = original color, 0 = fully white.
 * PowerPoint performs the blend in linear RGB space for perceptual correctness.
 */
export function applyTint(hex: string, tint: number): string {
  const { r, g, b } = hexToRgb(hex);
  const t = tint / 100000;
  const rl = srgbToLinear(r),
    gl = srgbToLinear(g),
    bl = srgbToLinear(b);
  return rgbToHex(
    linearToSrgb(rl * t + 1.0 * (1 - t)),
    linearToSrgb(gl * t + 1.0 * (1 - t)),
    linearToSrgb(bl * t + 1.0 * (1 - t)),
  );
}

/**
 * Apply shade modifier (mix toward black in linear RGB space).
 * shade: 0-100000 where 100000 = original color, 0 = fully black.
 */
export function applyShade(hex: string, shade: number): string {
  const { r, g, b } = hexToRgb(hex);
  const s = shade / 100000;
  return rgbToHex(
    linearToSrgb(srgbToLinear(r) * s),
    linearToSrgb(srgbToLinear(g) * s),
    linearToSrgb(srgbToLinear(b) * s),
  );
}

/**
 * Apply luminance modulation.
 * lumMod: percentage in OOXML units (e.g., 75000 = 75%).
 * Multiplies the L channel of HSL.
 */
export function applyLumMod(hex: string, lumMod: number): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const newL = Math.max(0, Math.min(1, l * (lumMod / 100000)));
  const rgb = hslToRgb(h, s, newL);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Apply luminance offset.
 * lumOff: percentage offset in OOXML units (e.g., 25000 = +25%).
 * Adds to the L channel of HSL.
 */
export function applyLumOff(hex: string, lumOff: number): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const newL = Math.max(0, Math.min(1, l + lumOff / 100000));
  const rgb = hslToRgb(h, s, newL);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Apply saturation modulation.
 * satMod: percentage in OOXML units (e.g., 120000 = 120%).
 * Multiplies the S channel of HSL.
 */
export function applySatMod(hex: string, satMod: number): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const newS = Math.max(0, Math.min(1, s * (satMod / 100000)));
  const rgb = hslToRgb(h, newS, l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Apply hue modulation.
 * hueMod: percentage in OOXML units (e.g., 60000 = shift hue by ratio).
 * In OOXML, hueMod multiplies the hue value. Hue wraps around at 360.
 */
export function applyHueMod(hex: string, hueMod: number): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const newH = (h * (hueMod / 100000)) % 360;
  const rgb = hslToRgb(newH, s, l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Apply hue offset (additive).
 * hueOff: in 60000ths of a degree (OOXML ST_FixedAngle).
 * Adds to the hue channel of HSL, wrapping at 360.
 */
export function applyHueOff(hex: string, hueOff: number): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const offsetDeg = hueOff / 60000;
  const newH = (((h + offsetDeg) % 360) + 360) % 360;
  const rgb = hslToRgb(newH, s, l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Apply saturation offset (additive).
 * satOff: in OOXML percentage units (100000 = 100%).
 * Adds to the S channel of HSL.
 */
export function applySatOff(hex: string, satOff: number): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const newS = Math.max(0, Math.min(1, s + satOff / 100000));
  const rgb = hslToRgb(h, newS, l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Convert OOXML alpha value (0-100000) to CSS opacity (0-1).
 * 100000 = fully opaque, 0 = fully transparent.
 */
export function applyAlpha(alpha: number): number {
  return Math.max(0, Math.min(1, alpha / 100000));
}

// ---------------------------------------------------------------------------
// Composite Modifier Application
// ---------------------------------------------------------------------------

export interface ColorModifier {
  name: string;
  val: number;
}

/**
 * Apply all OOXML color modifiers from an array of {name, val} objects.
 * Modifiers are applied in the order they appear (matching XML document order).
 * Returns the final hex color and alpha value.
 */
export function applyColorModifiers(
  hex: string,
  modifiers: ColorModifier[],
): { color: string; alpha: number } {
  let color = hex;
  let alpha = 1;

  for (const mod of modifiers) {
    switch (mod.name) {
      case 'tint':
      case 'a:tint':
        color = applyTint(color, mod.val);
        break;
      case 'shade':
      case 'a:shade':
        color = applyShade(color, mod.val);
        break;
      case 'lumMod':
      case 'a:lumMod':
        color = applyLumMod(color, mod.val);
        break;
      case 'lumOff':
      case 'a:lumOff':
        color = applyLumOff(color, mod.val);
        break;
      case 'satMod':
      case 'a:satMod':
        color = applySatMod(color, mod.val);
        break;
      case 'hueMod':
      case 'a:hueMod':
        color = applyHueMod(color, mod.val);
        break;
      case 'hueOff':
      case 'a:hueOff':
        color = applyHueOff(color, mod.val);
        break;
      case 'satOff':
      case 'a:satOff':
        color = applySatOff(color, mod.val);
        break;
      case 'alpha':
      case 'a:alpha':
        alpha = applyAlpha(mod.val);
        break;
      case 'alphaOff':
      case 'a:alphaOff':
        alpha = Math.max(0, Math.min(1, alpha + mod.val / 100000));
        break;
      default:
        // Unknown modifier - skip silently
        break;
    }
  }

  return { color, alpha };
}

// ---------------------------------------------------------------------------
// OOXML Preset Color Table
// ---------------------------------------------------------------------------

const PRESET_COLORS: Record<string, string> = {
  // Basic colors
  black: '#000000',
  white: '#FFFFFF',
  red: '#FF0000',
  green: '#008000',
  blue: '#0000FF',
  yellow: '#FFFF00',
  cyan: '#00FFFF',
  magenta: '#FF00FF',

  // Extended standard colors
  orange: '#FFA500',
  purple: '#800080',
  brown: '#A52A2A',
  pink: '#FFC0CB',
  gray: '#808080',
  grey: '#808080',
  lime: '#00FF00',
  navy: '#000080',
  teal: '#008080',
  maroon: '#800000',
  olive: '#808000',
  silver: '#C0C0C0',
  aqua: '#00FFFF',
  fuchsia: '#FF00FF',

  // OOXML-specific preset colors
  aliceBlue: '#F0F8FF',
  antiqueWhite: '#FAEBD7',
  aquamarine: '#7FFFD4',
  azure: '#F0FFFF',
  beige: '#F5F5DC',
  bisque: '#FFE4C4',
  blanchedAlmond: '#FFEBCD',
  blueViolet: '#8A2BE2',
  burlyWood: '#DEB887',
  cadetBlue: '#5F9EA0',
  chartreuse: '#7FFF00',
  chocolate: '#D2691E',
  coral: '#FF7F50',
  cornflowerBlue: '#6495ED',
  cornsilk: '#FFF8DC',
  crimson: '#DC143C',
  darkBlue: '#00008B',
  darkCyan: '#008B8B',
  darkGoldenrod: '#B8860B',
  darkGray: '#A9A9A9',
  darkGrey: '#A9A9A9',
  darkGreen: '#006400',
  darkKhaki: '#BDB76B',
  darkMagenta: '#8B008B',
  darkOliveGreen: '#556B2F',
  darkOrange: '#FF8C00',
  darkOrchid: '#9932CC',
  darkRed: '#8B0000',
  darkSalmon: '#E9967A',
  darkSeaGreen: '#8FBC8F',
  darkSlateBlue: '#483D8B',
  darkSlateGray: '#2F4F4F',
  darkSlateGrey: '#2F4F4F',
  darkTurquoise: '#00CED1',
  darkViolet: '#9400D3',
  deepPink: '#FF1493',
  deepSkyBlue: '#00BFFF',
  dimGray: '#696969',
  dimGrey: '#696969',
  dodgerBlue: '#1E90FF',
  firebrick: '#B22222',
  floralWhite: '#FFFAF0',
  forestGreen: '#228B22',
  gainsboro: '#DCDCDC',
  ghostWhite: '#F8F8FF',
  gold: '#FFD700',
  goldenrod: '#DAA520',
  greenYellow: '#ADFF2F',
  honeydew: '#F0FFF0',
  hotPink: '#FF69B4',
  indianRed: '#CD5C5C',
  indigo: '#4B0082',
  ivory: '#FFFFF0',
  khaki: '#F0E68C',
  lavender: '#E6E6FA',
  lavenderBlush: '#FFF0F5',
  lawnGreen: '#7CFC00',
  lemonChiffon: '#FFFACD',
  lightBlue: '#ADD8E6',
  lightCoral: '#F08080',
  lightCyan: '#E0FFFF',
  lightGoldenrodYellow: '#FAFAD2',
  lightGray: '#D3D3D3',
  lightGrey: '#D3D3D3',
  lightGreen: '#90EE90',
  lightPink: '#FFB6C1',
  lightSalmon: '#FFA07A',
  lightSeaGreen: '#20B2AA',
  lightSkyBlue: '#87CEFA',
  lightSlateGray: '#778899',
  lightSlateGrey: '#778899',
  lightSteelBlue: '#B0C4DE',
  lightYellow: '#FFFFE0',
  limeGreen: '#32CD32',
  linen: '#FAF0E6',
  mediumAquamarine: '#66CDAA',
  mediumBlue: '#0000CD',
  mediumOrchid: '#BA55D3',
  mediumPurple: '#9370DB',
  mediumSeaGreen: '#3CB371',
  mediumSlateBlue: '#7B68EE',
  mediumSpringGreen: '#00FA9A',
  mediumTurquoise: '#48D1CC',
  mediumVioletRed: '#C71585',
  midnightBlue: '#191970',
  mintCream: '#F5FFFA',
  mistyRose: '#FFE4E1',
  moccasin: '#FFE4B5',
  navajoWhite: '#FFDEAD',
  oldLace: '#FDF5E6',
  oliveDrab: '#6B8E23',
  orangeRed: '#FF4500',
  orchid: '#DA70D6',
  paleGoldenrod: '#EEE8AA',
  paleGreen: '#98FB98',
  paleTurquoise: '#AFEEEE',
  paleVioletRed: '#DB7093',
  papayaWhip: '#FFEFD5',
  peachPuff: '#FFDAB9',
  peru: '#CD853F',
  plum: '#DDA0DD',
  powderBlue: '#B0E0E6',
  rosyBrown: '#BC8F8F',
  royalBlue: '#4169E1',
  saddleBrown: '#8B4513',
  salmon: '#FA8072',
  sandyBrown: '#F4A460',
  seaGreen: '#2E8B57',
  seaShell: '#FFF5EE',
  sienna: '#A0522D',
  skyBlue: '#87CEEB',
  slateBlue: '#6A5ACD',
  slateGray: '#708090',
  slateGrey: '#708090',
  snow: '#FFFAFA',
  springGreen: '#00FF7F',
  steelBlue: '#4682B4',
  tan: '#D2B48C',
  thistle: '#D8BFD8',
  tomato: '#FF6347',
  turquoise: '#40E0D0',
  violet: '#EE82EE',
  wheat: '#F5DEB3',
  whiteSmoke: '#F5F5F5',
  yellowGreen: '#9ACD32',
};

/**
 * Look up a preset OOXML color name and return its hex value.
 * Returns undefined if the name is not recognized.
 */
export function presetColorToHex(name: string): string | undefined {
  // Try exact match first, then case-insensitive
  if (PRESET_COLORS[name] !== undefined) {
    return PRESET_COLORS[name];
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(PRESET_COLORS)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}
