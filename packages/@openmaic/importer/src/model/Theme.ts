/**
 * Theme parser — extracts color scheme and font definitions from a:theme XML.
 */

import { SafeXmlNode } from '../parser/XmlParser';

export interface ThemeData {
  colorScheme: Map<string, string>;
  majorFont: { latin: string; ea: string; cs: string; hans: string };
  minorFont: { latin: string; ea: string; cs: string; hans: string };
  fillStyles: SafeXmlNode[]; // from a:fillStyleLst children (indexed 1-based)
  lineStyles: SafeXmlNode[]; // from a:lnStyleLst children (indexed 1-based)
  effectStyles: SafeXmlNode[]; // from a:effectStyleLst children (indexed 1-based)
}

/** Known color scheme slot names in a:clrScheme. */
const COLOR_SLOTS = [
  'dk1',
  'dk2',
  'lt1',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
] as const;

/**
 * Extract a hex color value from a color definition node.
 * Handles both `a:srgbClr@val` and `a:sysClr@lastClr`.
 */
function extractColor(node: SafeXmlNode): string | undefined {
  const srgb = node.child('srgbClr');
  if (srgb.exists()) {
    return srgb.attr('val');
  }
  const sys = node.child('sysClr');
  if (sys.exists()) {
    return sys.attr('lastClr') ?? sys.attr('val');
  }
  return undefined;
}

/**
 * Parse font info from a majorFont or minorFont node.
 * Extracts typeface attributes from latin, ea, and cs child elements, plus
 * the Hans (Simplified Chinese) script fallback so callers can use it when
 * `ea` is empty — Office decks routinely leave the `ea` slot blank and rely
 * on the script-keyed `<a:font script="Hans" typeface="宋体"/>` row instead.
 */
function parseFontInfo(fontNode: SafeXmlNode): {
  latin: string;
  ea: string;
  cs: string;
  hans: string;
} {
  let hans = '';
  for (const child of fontNode.children('font')) {
    if (child.attr('script') === 'Hans') {
      hans = child.attr('typeface') ?? '';
      break;
    }
  }
  return {
    latin: fontNode.child('latin').attr('typeface') ?? '',
    ea: fontNode.child('ea').attr('typeface') ?? '',
    cs: fontNode.child('cs').attr('typeface') ?? '',
    hans,
  };
}

/**
 * Parse a theme XML root (`a:theme`) into ThemeData.
 */
export function parseTheme(root: SafeXmlNode): ThemeData {
  const themeElements = root.child('themeElements');

  // --- Color scheme ---
  const clrScheme = themeElements.child('clrScheme');
  const colorScheme = new Map<string, string>();

  for (const slot of COLOR_SLOTS) {
    const slotNode = clrScheme.child(slot);
    if (slotNode.exists()) {
      const hex = extractColor(slotNode);
      if (hex !== undefined) {
        colorScheme.set(slot, hex);
      }
    }
  }

  // --- Font scheme ---
  const fontScheme = themeElements.child('fontScheme');
  const majorFont = parseFontInfo(fontScheme.child('majorFont'));
  const minorFont = parseFontInfo(fontScheme.child('minorFont'));

  // --- Format scheme ---
  const fmtScheme = themeElements.child('fmtScheme');
  const fillStyleLst = fmtScheme.child('fillStyleLst');
  const fillStyles: SafeXmlNode[] = fillStyleLst.allChildren();
  const lnStyleLst = fmtScheme.child('lnStyleLst');
  const lineStyles: SafeXmlNode[] = lnStyleLst.allChildren();
  const effectStyleLst = fmtScheme.child('effectStyleLst');
  const effectStyles: SafeXmlNode[] = effectStyleLst.allChildren();

  return { colorScheme, majorFont, minorFont, fillStyles, lineStyles, effectStyles };
}
