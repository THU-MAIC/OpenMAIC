/**
 * Text serializer — maps TextBody to HTML for pptxtojson `content` (Shape.content / Text.content).
 * Migration of pptx-renderer `TextRenderer.renderTextBody`: same inheritance and merge logic;
 * output is an HTML string instead of a DOM container. See textSerializer.md (this folder).
 */

import katex from 'katex';
import type { RenderContext } from './RenderContext';
import type { TextBody, TextParagraph, TextRun } from '../model/nodes/ShapeNode';
import type { PlaceholderInfo } from '../model/nodes/BaseNode';
import { SafeXmlNode } from '../parser/XmlParser';
import { resolveColor, resolveColorToCss } from './StyleResolver';
import { ommlToLatex } from './mathSerializer';
import { emuToPx, pctToDecimal, angleToDeg } from '../parser/units';
import { isAllowedExternalUrl } from '../utils/urlSafety';

// ---------------------------------------------------------------------------
// Wingdings / Symbol Font → Unicode Mapping
// ---------------------------------------------------------------------------

const SYMBOL_FONTS = new Set(['wingdings', 'wingdings 2', 'wingdings 3', 'symbol', 'webdings']);

function isSymbolFont(fontName: string | undefined): boolean {
  return !!fontName && SYMBOL_FONTS.has(fontName.toLowerCase());
}

const WINGDINGS: Record<number, string> = {
  0x66: '●',
  0x67: '●',
  0x6c: '●',
  0x6d: '○',
  0x6e: '■',
  0x6f: '□',
  0x71: '✕',
  0x72: '✓',
  0x73: '☐',
  0x74: '⬥',
  0x75: '◆',
  0x76: '❖',
  0x77: '⬜',
  0x9c: '●',
  0x9d: '○',
  0x9e: '■',
  0x9f: '□',
  0xa1: '✡',
  0xa7: '✺',
  0xab: '⇨',
  0xfc: '●',
  0xa8: '✶',
  0xaa: '⇦',
  0xac: '⇧',
  0xad: '⇩',
  // Arrows
  0xe0: '→',
  0xe1: '←',
  0xe2: '↑',
  0xe3: '↓',
  0xe4: '↔',
  0xe5: '↕',
  0xe6: '⇒',
  0xe7: '⇐',
  0xe8: '⇑',
  0xe9: '⇓',
  0xea: '⇔',
  0xeb: '⇕',
  0xef: '➔',
  // Miscellaneous
  0xd5: '✉',
  0xd6: '☛',
  0xd7: '☞',
  0xd8: '✌',
  0xfb: '⚫',
};

const WINGDINGS2: Record<number, string> = {
  0x9e: '◉',
  0x9f: '⊙',
  0x62: '①',
  0x63: '②',
  0x64: '③',
  0x65: '④',
  0x66: '⑤',
  0x67: '⑥',
  0x68: '⑦',
  0x69: '⑧',
  0x6a: '⑨',
  0x6b: '⑩',
  0x98: '⬥',
  0x99: '◇',
  0xa3: '✦',
  0xf0: '●',
  0xf1: '○',
  0xf2: '◉',
  0xf3: '◎',
};

const WINGDINGS3: Record<number, string> = {
  0x7d: '▶',
  0x7e: '◀',
  0x7b: '▲',
  0x7c: '▼',
  0x75: '►',
  0x76: '◄',
  0x77: '▸',
  0x78: '◂',
};

const SYMBOL: Record<number, string> = {
  0xb7: '•',
  0xd8: '≠',
  0xb3: '≥',
  0xa3: '≤',
  0xae: '®',
  0xa9: '©',
  0xc6: '…',
};

function symbolFontCharToUnicode(char: string, fontName: string): string {
  if (!char || char.length === 0) return char;
  const font = fontName.toLowerCase();
  let code = char.codePointAt(0) ?? 0;
  if (code >= 0xf000 && code <= 0xf0ff) code -= 0xf000;

  let table: Record<number, string> | undefined;
  if (font === 'wingdings') table = WINGDINGS;
  else if (font === 'wingdings 2') table = WINGDINGS2;
  else if (font === 'wingdings 3') table = WINGDINGS3;
  else if (font === 'symbol') table = SYMBOL;

  if (table && table[code]) return table[code];
  return '•';
}

// ---------------------------------------------------------------------------
// Style Inheritance Helpers
// ---------------------------------------------------------------------------

/**
 * Find paragraph properties at a specific indent level from a list style node.
 * Tries lvl{n}pPr (where n = level + 1), then falls back to defPPr.
 */
function findStyleAtLevel(styleNode: SafeXmlNode | undefined, level: number): SafeXmlNode {
  if (!styleNode || !styleNode.exists()) {
    return new SafeXmlNode(null);
  }
  // Try level-specific style (lvl1pPr, lvl2pPr, etc.)
  const lvlNode = styleNode.child(`lvl${level + 1}pPr`);
  if (lvlNode.exists()) return lvlNode;
  // Fall back to default
  return styleNode.child('defPPr');
}

/**
 * Determine the placeholder category for style inheritance.
 * Returns 'title', 'body', or 'other'.
 */
function getPlaceholderCategory(
  placeholder: PlaceholderInfo | undefined,
): 'title' | 'body' | 'other' {
  if (!placeholder) return 'other';
  const t = placeholder.type;
  if (t === 'title' || t === 'ctrTitle') return 'title';
  if (
    t === 'body' ||
    t === 'subTitle' ||
    t === 'obj' ||
    t === 'dt' ||
    t === 'ftr' ||
    t === 'sldNum' ||
    !t
  ) {
    return 'body';
  }
  return 'other';
}

/**
 * Find a placeholder node in a list by matching type and/or idx.
 */
export function findPlaceholderNode(
  placeholders: SafeXmlNode[],
  info: PlaceholderInfo,
): SafeXmlNode | undefined {
  for (const ph of placeholders) {
    // Navigate to the ph element to read its attributes
    let phEl: SafeXmlNode | undefined;
    const nvSpPr = ph.child('nvSpPr');
    if (nvSpPr.exists()) {
      phEl = nvSpPr.child('nvPr').child('ph');
    }
    if (!phEl || !phEl.exists()) {
      const nvPicPr = ph.child('nvPicPr');
      if (nvPicPr.exists()) {
        phEl = nvPicPr.child('nvPr').child('ph');
      }
    }
    if (!phEl || !phEl.exists()) continue;

    const phType = phEl.attr('type');
    const phIdx = phEl.numAttr('idx');

    // Match by idx first (most specific), then by type
    if (info.idx !== undefined && phIdx === info.idx) return ph;
    if (info.type && phType === info.type) return ph;
  }
  return undefined;
}

/**
 * Extract lstStyle from a placeholder shape node.
 */
function getPlaceholderLstStyle(phNode: SafeXmlNode): SafeXmlNode | undefined {
  const txBody = phNode.child('txBody');
  if (!txBody.exists()) return undefined;
  const lstStyle = txBody.child('lstStyle');
  return lstStyle.exists() ? lstStyle : undefined;
}

/**
 * Merge a source paragraph property node onto a target style object.
 * Later calls override earlier values (higher priority wins).
 */
interface MergedParagraphStyle {
  align?: string;
  marginLeft?: number;
  textIndent?: number;
  lineHeight?: string;
  /** True when lineHeight comes from spcPts (absolute pt value). For CJK fonts, CSS line-height
   *  with absolute values may not produce exact spacing because the font's content area can exceed
   *  the line-height. When true, we use block-level line wrappers instead of <br> for line breaks. */
  lineHeightAbsolute?: boolean;
  spaceBefore?: number;
  spaceBeforePct?: number; // percentage of font size (0-1 range)
  spaceAfter?: number;
  spaceAfterPct?: number; // percentage of font size (0-1 range)
  bulletChar?: string;
  bulletFont?: string;
  bulletAutoNum?: string;
  bulletNone?: boolean;
  /** buSzPct: bullet size as percentage of font size (e.g. 73000 → 0.73). */
  bulletSizePct?: number;
  /** When set, bullet color is taken from this OOXML buClr node (a:buClr with srgbClr/schemeClr child). */
  bulletColorNode?: SafeXmlNode;
  defRPrs?: SafeXmlNode[];
  /** Custom tab stop positions (a:tabLst/a:tab@pos) in px, measured from the text frame's
   *  left inset, sorted ascending. PowerPoint uses these to align tabbed text (e.g. list
   *  items / titles positioned to the right of an icon). Without them we fall back to the
   *  OOXML default 96px tab grid, which pushes tabbed text far past its intended column. */
  tabStopsPx?: number[];
}

function buildMergedParagraphStyle(
  textBody: TextBody,
  paragraph: TextParagraph,
  category: 'title' | 'body' | 'other',
  placeholder: PlaceholderInfo | undefined,
  ctx: RenderContext,
): MergedParagraphStyle {
  const merged: MergedParagraphStyle = {};
  const level = paragraph.level;

  // Level 1: master defaultTextStyle
  mergeParagraphProps(merged, findStyleAtLevel(ctx.master.defaultTextStyle, level));

  // Level 2: master text styles by category
  const masterTextStyle =
    category === 'title'
      ? ctx.master.textStyles.titleStyle
      : category === 'body'
        ? ctx.master.textStyles.bodyStyle
        : ctx.master.textStyles.otherStyle;
  mergeParagraphProps(merged, findStyleAtLevel(masterTextStyle, level));

  // Level 3: master placeholder lstStyle
  if (placeholder) {
    const masterPh = findPlaceholderNode(ctx.master.placeholders, placeholder);
    if (masterPh) {
      const lstStyle = getPlaceholderLstStyle(masterPh);
      mergeParagraphProps(merged, findStyleAtLevel(lstStyle, level));
    }
  }

  // Level 4: layout placeholder lstStyle
  if (placeholder) {
    const layoutPh = findPlaceholderNode(
      ctx.layout.placeholders.map((e) => e.node),
      placeholder,
    );
    if (layoutPh) {
      const lstStyle = getPlaceholderLstStyle(layoutPh);
      mergeParagraphProps(merged, findStyleAtLevel(lstStyle, level));
    }
  }

  // Level 5: shape lstStyle
  mergeParagraphProps(merged, findStyleAtLevel(textBody.listStyle, level));

  // Level 6: paragraph pPr
  if (paragraph.properties) {
    mergeParagraphProps(merged, paragraph.properties);
  }

  return merged;
}

function mergeParagraphProps(target: MergedParagraphStyle, pPr: SafeXmlNode): void {
  if (!pPr.exists()) return;

  const algn = pPr.attr('algn');
  if (algn) target.align = algn;

  const marL = pPr.numAttr('marL');
  if (marL !== undefined) target.marginLeft = emuToPx(marL);

  const indent = pPr.numAttr('indent');
  if (indent !== undefined) target.textIndent = emuToPx(indent);

  // Custom tab stops (a:tabLst). A more specific level fully replaces the list —
  // OOXML tabLst is not additive across inheritance levels.
  const tabLst = pPr.child('tabLst');
  if (tabLst.exists()) {
    const stops = tabLst
      .children('tab')
      .map((t) => t.numAttr('pos'))
      .filter((p): p is number => p !== undefined)
      .map((p) => emuToPx(p))
      .sort((a, b) => a - b);
    if (stops.length > 0) target.tabStopsPx = stops;
  }

  // Line spacing
  // OOXML spcPct: 100000 = "single spacing" = 1.0× the font's line height.
  // IMPORTANT: We must use UNITLESS CSS line-height values (e.g., 1.0, 1.2)
  // instead of percentages (e.g., 100%, 120%). CSS percentage line-height is
  // computed once against the element's own font-size and inherited as a FIXED
  // pixel value — so a parent div with line-height:120% and font-size:16px
  // inherits 19.2px to ALL children, even those with font-size:80pt.
  // Unitless values are inherited as-is and each child recomputes against its
  // own font-size.
  const lnSpc = pPr.child('lnSpc');
  if (lnSpc.exists()) {
    const spcPct = lnSpc.child('spcPct');
    if (spcPct.exists()) {
      const val = spcPct.numAttr('val');
      if (val !== undefined) {
        // OOXML 100000 → CSS unitless 1.0; OOXML 120000 → CSS 1.2
        target.lineHeight = `${parseFloat((val / 100000).toFixed(4))}`;
        // Reset the absolute flag: a spcPct override at a more specific level
        // must not leave a stale `lineHeightAbsolute=true` from an inherited
        // spcPts, otherwise the line wrapper would emit `height: 1.0` (no unit).
        target.lineHeightAbsolute = false;
      }
    }
    const spcPts = lnSpc.child('spcPts');
    if (spcPts.exists()) {
      const val = spcPts.numAttr('val');
      if (val !== undefined) {
        target.lineHeight = `${val / 100}pt`;
        target.lineHeightAbsolute = true;
      }
    }
  }

  // Space before
  const spcBef = pPr.child('spcBef');
  if (spcBef.exists()) {
    const spcPts = spcBef.child('spcPts');
    if (spcPts.exists()) {
      const val = spcPts.numAttr('val');
      if (val !== undefined) target.spaceBefore = val / 100;
    }
    const spcPct = spcBef.child('spcPct');
    if (spcPct.exists()) {
      const val = spcPct.numAttr('val');
      if (val !== undefined) target.spaceBeforePct = val / 100000; // store as ratio
    }
  }

  // Space after
  const spcAft = pPr.child('spcAft');
  if (spcAft.exists()) {
    const spcPts = spcAft.child('spcPts');
    if (spcPts.exists()) {
      const val = spcPts.numAttr('val');
      if (val !== undefined) target.spaceAfter = val / 100;
    }
    const spcPct = spcAft.child('spcPct');
    if (spcPct.exists()) {
      const val = spcPct.numAttr('val');
      if (val !== undefined) target.spaceAfterPct = val / 100000; // store as ratio
    }
  }

  // Bullets
  const buChar = pPr.child('buChar');
  if (buChar.exists()) {
    target.bulletChar = buChar.attr('char') || '';
    target.bulletNone = false;
  }
  const buAutoNum = pPr.child('buAutoNum');
  if (buAutoNum.exists()) {
    target.bulletAutoNum = buAutoNum.attr('type') || 'arabicPeriod';
    target.bulletNone = false;
  }
  const buNone = pPr.child('buNone');
  if (buNone.exists()) {
    target.bulletNone = true;
    target.bulletChar = undefined;
    target.bulletAutoNum = undefined;
  }
  const buFont = pPr.child('buFont');
  if (buFont.exists()) {
    target.bulletFont = buFont.attr('typeface');
  }
  const buSzPct = pPr.child('buSzPct');
  if (buSzPct.exists()) {
    const val = buSzPct.numAttr('val');
    if (val !== undefined) target.bulletSizePct = val / 100000;
  }
  // Explicit bullet color (a:buClr); when present overrides defRPr for bullet color
  const buClr = pPr.child('buClr');
  if (buClr.exists()) {
    target.bulletColorNode = buClr;
  }

  // Default run properties — accumulate across all inheritance levels so that
  // an empty <a:defRPr/> at a lower level doesn't discard the sz/color set by
  // a higher level (e.g. master titleStyle sz="4400").
  const defRPr = pPr.child('defRPr');
  if (defRPr.exists()) {
    if (!target.defRPrs) target.defRPrs = [];
    target.defRPrs.push(defRPr);
  }
}

// ---------------------------------------------------------------------------
// Run Style Resolution
// ---------------------------------------------------------------------------

interface MergedRunStyle {
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  fontFamily?: string;
  hlinkClick?: string;
  /** Character spacing (tracking) in points — from a:spc @val (hundredths of pt). */
  letterSpacingPt?: number;
  /** Kerning: minimum font size (pt) for kerning; 0 = always kern. */
  kern?: number;
  /** Text capitalization: "all" = ALL CAPS, "small" = SMALL CAPS, "none" = normal. */
  cap?: string;
  /** Baseline shift in percentage (positive = superscript, negative = subscript). */
  baseline?: number;
  /** CSS gradient string for text fill (from rPr > gradFill). */
  textGradientCss?: string;
  /** When true, text fill is transparent (a:noFill on rPr). */
  textNoFill?: boolean;
  /** Text outline width in px (from a:ln on rPr). */
  textOutlineWidth?: number;
  /** Text outline CSS color (solid fill on ln). */
  textOutlineColor?: string;
  /** Text outline CSS gradient (gradient fill on ln) — used as mask-image for fade effect. */
  textOutlineGradientCss?: string;
  /** CSS text-shadow string from a:rPr > a:effectLst > a:outerShdw. */
  textShadowCss?: string;
}

/**
 * Compute CSS text-shadow from <a:effectLst><a:outerShdw> inside a rPr. PPT
 * cover titles routinely use this for the soft drop shadow under big chapter
 * text. Mirrors shapeSerializer.resolveShapeShadow but emits in px for
 * text-shadow rather than the shape Shadow record.
 */
function resolveTextShadowCss(rPr: SafeXmlNode, ctx: RenderContext): string | undefined {
  const effectLst = rPr.child('effectLst');
  if (!effectLst.exists()) return undefined;
  const shd = effectLst.child('outerShdw');
  if (!shd.exists()) return undefined;
  const dir = shd.numAttr('dir') ?? 0;
  const dist = shd.numAttr('dist') ?? 0;
  const blurRad = shd.numAttr('blurRad') ?? 0;
  const dirDeg = dir / 60000;
  const distPx = emuToPx(dist);
  const blurPx = emuToPx(blurRad);
  const x = distPx * Math.cos((dirDeg * Math.PI) / 180);
  const y = distPx * Math.sin((dirDeg * Math.PI) / 180);
  let color = 'rgba(0,0,0,0.4)';
  const { color: shdColor, alpha: shdAlpha } = resolveColor(shd, ctx);
  if (shdColor) {
    const hex = shdColor.startsWith('#') ? shdColor : `#${shdColor}`;
    const { r, g, b } = hexToRgbInternal(hex);
    color = `rgba(${r},${g},${b},${shdAlpha.toFixed(3)})`;
  }
  return `${x.toFixed(2)}px ${y.toFixed(2)}px ${blurPx.toFixed(2)}px ${color}`;
}

function mergeRunProps(target: MergedRunStyle, rPr: SafeXmlNode, ctx: RenderContext): void {
  if (!rPr.exists()) return;

  const sz = rPr.numAttr('sz');
  if (sz !== undefined) target.fontSize = sz / 100; // hundredths of point -> pt

  const b = rPr.attr('b');
  if (b !== undefined) target.bold = b === '1' || b === 'true';

  const i = rPr.attr('i');
  if (i !== undefined) target.italic = i === '1' || i === 'true';

  const u = rPr.attr('u');
  if (u !== undefined && u !== 'none') target.underline = true;
  if (u === 'none') target.underline = false;

  const strike = rPr.attr('strike');
  if (strike !== undefined && strike !== 'noStrike') target.strikethrough = true;
  if (strike === 'noStrike') target.strikethrough = false;

  // Color from solidFill / gradFill / noFill child.
  // 这三种是 OOXML 里互斥的 fill 类型——后处理的 rPr 层级一旦显式声明
  // 其中之一，必须把其它两种从上层继承下来的状态清掉。否则会出现
  // master 给了 noFill、slide 给了 solidFill 这种"既要白色又要透明"的
  // CSS 输出 `color:#FFF;color:transparent;`，浏览器取后者，文字直接看不见
  // （slide #3 的"01"-"05" 编号即此类）。
  const solidFill = rPr.child('solidFill');
  if (solidFill.exists()) {
    const { color, alpha } = resolveColor(solidFill, ctx);
    const hex = color.startsWith('#') ? color : `#${color}`;
    if (alpha < 1) {
      const { r, g, b: bl } = hexToRgbInternal(hex);
      target.color = `rgba(${r},${g},${bl},${alpha.toFixed(3)})`;
    } else {
      target.color = hex;
    }
    target.textGradientCss = undefined;
    target.textNoFill = undefined;
  }
  const gradFill = rPr.child('gradFill');
  if (gradFill.exists()) {
    const css = resolveGradientForText(gradFill, ctx);
    if (css) {
      target.textGradientCss = css;
      target.color = undefined;
      target.textNoFill = undefined;
    }
  }

  // Font family
  const latin = rPr.child('latin');
  if (latin.exists()) {
    const typeface = latin.attr('typeface');
    if (typeface) {
      target.fontFamily = resolveThemeFont(typeface, ctx);
    }
  }
  if (!target.fontFamily) {
    const ea = rPr.child('ea');
    if (ea.exists()) {
      const typeface = ea.attr('typeface');
      if (typeface) {
        target.fontFamily = resolveThemeFont(typeface, ctx);
      }
    }
  }
  if (!target.fontFamily) {
    const cs = rPr.child('cs');
    if (cs.exists()) {
      const typeface = cs.attr('typeface');
      if (typeface) {
        target.fontFamily = resolveThemeFont(typeface, ctx);
      }
    }
  }

  // Hyperlink
  const hlinkClick = rPr.child('hlinkClick');
  if (hlinkClick.exists()) {
    // The actual URL is in the slide rels, referenced by r:id
    const rId = hlinkClick.attr('id') ?? hlinkClick.attr('r:id');
    if (rId) {
      const rel = ctx.slide.rels.get(rId);
      if (rel && rel.targetMode === 'External' && isAllowedExternalUrl(rel.target)) {
        target.hlinkClick = rel.target;
      }
    }
  }

  // Character spacing (compact/tracking): rPr@spc in hundredths of a point
  const spc = rPr.numAttr('spc');
  if (spc !== undefined) target.letterSpacingPt = spc / 100;

  // Kerning: rPr@kern = minimum font size (hundredths of pt) to apply kerning; 0 = always
  const kern = rPr.numAttr('kern');
  if (kern !== undefined) target.kern = kern / 100;

  // Text capitalization: cap="all" (ALL CAPS) or cap="small" (SMALL CAPS)
  const cap = rPr.attr('cap');
  if (cap !== undefined) target.cap = cap;

  // Baseline shift: positive = superscript, negative = subscript (in 1000ths of percent)
  const baseline = rPr.numAttr('baseline');
  if (baseline !== undefined) target.baseline = baseline;

  // Text noFill: a:noFill on rPr makes text interior transparent.
  // 与 solidFill/gradFill 互斥——显式 noFill 必须把上层继承下来的颜色清掉，
  // 否则会输出 `color:#xxx;color:transparent;` 这种"既继承又透明"的样式。
  if (rPr.child('noFill').exists()) {
    target.textNoFill = true;
    target.color = undefined;
    target.textGradientCss = undefined;
  }

  // Text outline: a:ln on rPr defines text stroke/outline
  const ln = rPr.child('ln');
  if (ln.exists() && !ln.child('noFill').exists()) {
    const lnW = ln.numAttr('w');
    target.textOutlineWidth = lnW ? emuToPx(lnW) : 0.75; // default ~0.75px
    // Solid fill on outline
    const lnSolid = ln.child('solidFill');
    if (lnSolid.exists()) {
      const { color: c, alpha: a } = resolveColor(lnSolid, ctx);
      target.textOutlineColor = colorToCssLocal(c, a);
    }
    // Gradient fill on outline — build CSS gradient for mask effect
    const lnGrad = ln.child('gradFill');
    if (lnGrad.exists()) {
      target.textOutlineGradientCss = resolveGradientForText(lnGrad, ctx);
    }
  }

  // Run-level drop shadow (a:effectLst > a:outerShdw on rPr). Cover-title
  // decks rely on this for the soft halo under big chapter text — without it
  // the title looks flat versus the original PPT render.
  const textShadow = resolveTextShadowCss(rPr, ctx);
  if (textShadow) target.textShadowCss = textShadow;
}

/**
 * Resolve theme font placeholder references like "+mj-lt" or "+mn-lt".
 * For the EA (East Asian) slot we fall back to the theme's Hans script row
 * when the explicit `ea` typeface is empty — Office decks routinely leave
 * `<a:ea typeface=""/>` blank and rely on `<a:font script="Hans" .../>` to
 * pick a Chinese face. Without that fallback the literal "+mj-ea" passes
 * through unchanged and the browser substitutes a default sans, which then
 * faux-bolds and visibly mismatches the deck's intended Songti rendering.
 */
function resolveThemeFont(typeface: string, ctx: RenderContext): string {
  if (typeface === '+mj-lt' || typeface === '+mj-ea' || typeface === '+mj-cs') {
    const key = typeface.slice(4) as 'lt' | 'ea' | 'cs';
    const mapping: Record<string, 'latin' | 'ea' | 'cs'> = { lt: 'latin', ea: 'ea', cs: 'cs' };
    const slot = mapping[key] || 'latin';
    const direct = ctx.theme.majorFont[slot];
    if (direct) return direct;
    if (key === 'ea' && ctx.theme.majorFont.hans) return ctx.theme.majorFont.hans;
    return typeface;
  }
  if (typeface === '+mn-lt' || typeface === '+mn-ea' || typeface === '+mn-cs') {
    const key = typeface.slice(4) as 'lt' | 'ea' | 'cs';
    const mapping: Record<string, 'latin' | 'ea' | 'cs'> = { lt: 'latin', ea: 'ea', cs: 'cs' };
    const slot = mapping[key] || 'latin';
    const direct = ctx.theme.minorFont[slot];
    if (direct) return direct;
    if (key === 'ea' && ctx.theme.minorFont.hans) return ctx.theme.minorFont.hans;
    return typeface;
  }
  return typeface;
}

/**
 * Minimal hex-to-rgb parser for inline use.
 */
function hexToRgbInternal(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace(/^#/, '');
  const num = parseInt(
    cleaned.length === 3
      ? cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2]
      : cleaned,
    16,
  );
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
}

/**
 * Convert resolved color + alpha to CSS color string.
 */
function colorToCssLocal(color: string, alpha: number): string {
  const hex = color.startsWith('#') ? color : `#${color}`;
  if (alpha >= 1) return hex;
  const { r, g, b } = hexToRgbInternal(hex);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

/**
 * Resolve a gradient fill node into a CSS linear-gradient string.
 * Used for text outline gradient effects.
 */
function resolveGradientForText(gradFill: SafeXmlNode, ctx: RenderContext): string {
  const gsLst = gradFill.child('gsLst');
  const stops: { position: number; color: string }[] = [];
  for (const gs of gsLst.children('gs')) {
    const pos = gs.numAttr('pos') ?? 0;
    const posPercent = pctToDecimal(pos) * 100;
    const { color, alpha } = resolveColor(gs, ctx);
    stops.push({ position: posPercent, color: colorToCssLocal(color, alpha) });
  }
  if (stops.length === 0) return '';
  stops.sort((a, b) => a.position - b.position);
  const stopsStr = stops.map((s) => `${s.color} ${s.position.toFixed(1)}%`).join(', ');
  const lin = gradFill.child('lin');
  if (lin.exists()) {
    const angle = angleToDeg(lin.numAttr('ang') ?? 0);
    const cssAngle = (angle + 90) % 360;
    return `linear-gradient(${cssAngle.toFixed(1)}deg, ${stopsStr})`;
  }
  return `linear-gradient(180deg, ${stopsStr})`;
}

// ---------------------------------------------------------------------------
// Bullet Generation
// ---------------------------------------------------------------------------

function generateAutoNumber(type: string, index: number): string {
  const num = index + 1;
  switch (type) {
    case 'arabicPeriod':
      return `${num}.`;
    case 'arabicParenR':
      return `${num})`;
    case 'arabicParenBoth':
      return `(${num})`;
    case 'arabicPlain':
      return `${num}`;
    case 'romanUcPeriod':
      return `${toRoman(num)}.`;
    case 'romanLcPeriod':
      return `${toRoman(num).toLowerCase()}.`;
    case 'alphaUcPeriod':
      return `${String.fromCharCode(64 + (((num - 1) % 26) + 1))}.`;
    case 'alphaLcPeriod':
      return `${String.fromCharCode(96 + (((num - 1) % 26) + 1))}.`;
    case 'alphaUcParenR':
      return `${String.fromCharCode(64 + (((num - 1) % 26) + 1))})`;
    case 'alphaLcParenR':
      return `${String.fromCharCode(96 + (((num - 1) % 26) + 1))})`;
    default:
      return `${num}.`;
  }
}

function toRoman(num: number): string {
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let result = '';
  let remaining = num;
  for (let i = 0; i < vals.length; i++) {
    while (remaining >= vals[i]) {
      result += syms[i];
      remaining -= vals[i];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTML string output (replaces DOM container in TextRenderer)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Preserve consecutive spaces (same intent as TextRenderer innerHTML / textContent handling).
 */
function formatRunTextForHtml(raw: string): string {
  if (!raw) return '';
  if (raw.includes('\t')) {
    return escapeHtml(raw);
  }
  // PowerPoint \u91cc\u4f5c\u8005\u5e38\u7528 N \u4e2a ASCII \u7a7a\u683c\u505a\u89c6\u89c9\u7f29\u8fdb\u2014\u2014\u5728 \u7b49\u7ebf/CJK \u5b57\u4f53\u91cc
  // ASCII space \u662f\u56fa\u5b9a\u7684 half-width\uff080.5em\uff09\uff0c\u4f46\u6d4f\u89c8\u5668\u66ff\u6362\u6210 SourceHanSans
  // \u540e\u7a7a\u683c\u5bbd\u5ea6\u504f\u5bbd\uff0c\u5bfc\u81f4 "\u6388\u8bfe\u56e2\u961f\uff1a" \u4e0b\u9762\u7528\u7a7a\u683c\u5bf9\u9f50\u7684\u51e0\u884c\u88ab\u63a8\u5230\u6bd4\u6e90 PPT
  // \u6392\u7248\u610f\u56fe\u66f4\u9760\u53f3\u7684\u4f4d\u7f6e\u3002\u628a\u9996\u6bb5 >=2 \u4e2a\u8fde\u7eed\u7a7a\u683c\u6298\u7b97\u6210\u7b49\u5bbd inline-block\uff0c
  // \u7f29\u8fdb\u5c31\u548c\u5b57\u4f53\u5ea6\u91cf\u89e3\u8026\uff0c\u5339\u914d CJK half-width \u4e60\u60ef\u3002
  let leadingPrefix = '';
  let remainder = raw;
  const leadingMatch = remainder.match(/^( {2,})/);
  if (leadingMatch) {
    const count = leadingMatch[1].length;
    remainder = remainder.slice(count);
    // 0.25em/空格：自托管思源宋体/黑体实测 ASCII space advance ≈0.256em。早期用
    // 0.5em 是 fonts.css 未 import 时空格落到偏宽系统 fallback 的补偿；字体注册修复
    // 后 0.5em 反而把「图标+\t+空格+标题」窄框标题多撑约 1em 触发误换行（slide 6）。
    leadingPrefix = `<span style="display:inline-block;width:${(count * 0.25).toFixed(2)}em"></span>`;
  }
  let t = escapeHtml(remainder);
  if (/ {2}/.test(remainder)) {
    t = t.replace(/ {2}/g, ' \u00a0');
  }
  return leadingPrefix + t;
}

type SupportedTextWarp = 'textArchUp' | 'textArchDown';

function getSupportedTextWarp(textBody: TextBody): SupportedTextWarp | undefined {
  const warp = textBody.bodyProperties?.child('prstTxWarp');
  const preset = warp?.exists() ? warp.attr('prst') : undefined;
  return preset === 'textArchUp' || preset === 'textArchDown' ? preset : undefined;
}

function textRunToGlyphs(text: string): string[] {
  return Array.from(text.replace(/\s+/g, ' '));
}

function bodyTextHeightPx(textBody: TextBody, options: RenderTextBodyOptions | undefined): number {
  if (!options?.frameHeightPx || options.frameHeightPx <= 0) return 72;
  const bp = textBody.bodyProperties;
  const DEFAULT_V_INSET = 45720;
  const tIns = bp?.numAttr('tIns') ?? DEFAULT_V_INSET;
  const bIns = bp?.numAttr('bIns') ?? DEFAULT_V_INSET;
  return Math.max(24, options.frameHeightPx - emuToPx(tIns + bIns));
}

function renderTextWarp(
  textBody: TextBody,
  category: 'title' | 'body' | 'other',
  placeholder: PlaceholderInfo | undefined,
  ctx: RenderContext,
  options: RenderTextBodyOptions | undefined,
  warp: SupportedTextWarp,
): string {
  const glyphs: { text: string; style: string }[] = [];

  for (const paragraph of textBody.paragraphs) {
    const level = paragraph.level;
    const merged = buildMergedParagraphStyle(textBody, paragraph, category, placeholder, ctx);

    for (const run of paragraph.runs) {
      if (run.text === '\n' || run.ommlXml) continue;

      const runStyle: MergedRunStyle = {};
      if (merged.defRPrs) {
        for (const drp of merged.defRPrs) mergeRunProps(runStyle, drp, ctx);
      }
      if (run.properties) {
        mergeRunProps(runStyle, run.properties, ctx);
      }
      if (runStyle.color === undefined && textBody.listStyle) {
        const lstStyleLevel = findStyleAtLevel(textBody.listStyle, level);
        const lstDefRPr = lstStyleLevel.exists() ? lstStyleLevel.child('defRPr') : undefined;
        if (lstDefRPr?.exists()) {
          const fallbackStyle: MergedRunStyle = {};
          mergeRunProps(fallbackStyle, lstDefRPr, ctx);
          if (fallbackStyle.color !== undefined) runStyle.color = fallbackStyle.color;
        }
      }

      let runText = run.text ?? '';
      if (run.properties) {
        const symNode = run.properties.child('sym');
        const symTypeface = symNode.exists() ? symNode.attr('typeface') : undefined;
        if (isSymbolFont(symTypeface)) {
          runText = Array.from(runText)
            .map((ch) => symbolFontCharToUnicode(ch, symTypeface!))
            .join('');
        }
      }

      const style = runStylesToCssString(runStyle, run, options, ctx);
      for (const ch of textRunToGlyphs(runText)) {
        glyphs.push({ text: ch, style });
      }
    }
  }

  if (glyphs.length === 0) return '';

  const count = glyphs.length;
  const totalAngle = Math.min(76, Math.max(40, count * 6.5));
  const maxAngle = totalAngle / 2;
  const maxRad = (maxAngle * Math.PI) / 180;
  const xRadiusPct = Math.min(44, Math.max(30, count * 3.9));
  const yAmplitudePct = 12;
  const centerYPct = warp === 'textArchUp' ? 18 : 82;
  const heightPx = bodyTextHeightPx(textBody, options);

  let html = `<div data-pptx-text-warp="${warp}" style="position: relative;width: 100%;height: ${heightPx.toFixed(2)}px;white-space: nowrap;">`;
  for (let i = 0; i < glyphs.length; i++) {
    const ratio = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
    const angle = ratio * maxAngle;
    const rad = (angle * Math.PI) / 180;
    const curve = maxRad > 0 ? (1 - Math.cos(Math.abs(rad))) / (1 - Math.cos(maxRad)) : 0;
    const x = 50 + (maxRad > 0 ? (Math.sin(rad) / Math.sin(maxRad)) * xRadiusPct : 0);
    const y =
      warp === 'textArchUp'
        ? centerYPct + yAmplitudePct * curve
        : centerYPct - yAmplitudePct * curve;
    const rotation = warp === 'textArchUp' ? angle : -angle;
    const text = glyphs[i].text === ' ' ? '&nbsp;' : formatRunTextForHtml(glyphs[i].text);
    const style =
      `${glyphs[i].style};position: absolute;left: ${x.toFixed(2)}%;top: ${y.toFixed(2)}%;` +
      `line-height: 1;transform: translate(-50%, -50%) rotate(${rotation.toFixed(2)}deg);` +
      'transform-origin: center center;white-space: nowrap;';
    html += `<span style="${style}">${text}</span>`;
  }
  html += '</div>';
  return html;
}

// ---------------------------------------------------------------------------
// Main Render Function
// ---------------------------------------------------------------------------

/**
 * Render a text body into the provided container element.
 *
 * Implements 7-level style inheritance:
 * 1. master.defaultTextStyle
 * 2. master.textStyles[category] (titleStyle / bodyStyle / otherStyle)
 * 3. master placeholder lstStyle
 * 4. layout placeholder lstStyle
 * 5. shape lstStyle
 * 6. paragraph pPr
 * 7. run rPr
 */
/** Optional overrides when rendering text (e.g. table cell style text properties from tcTxStyle). */
export interface RenderTextBodyOptions {
  /** When set, used as text color when the run has no explicit color (e.g. table style tcTxStyle). */
  cellTextColor?: string;
  /** When set, applies bold from table style tcTxStyle (overrides inherited, yields to explicit run rPr). */
  cellTextBold?: boolean;
  /** When set, applies italic from table style tcTxStyle (overrides inherited, yields to explicit run rPr). */
  cellTextItalic?: boolean;
  /** When set, applies font family from table style tcTxStyle (overrides inherited, yields to explicit run rPr). */
  cellTextFontFamily?: string;
  /** fontRef color from shape style (e.g. SmartArt). Overrides inherited styles but yields to explicit run rPr color. */
  fontRefColor?: string;
  /**
   * When set, used as text insets (EMU) for table cells. tcPr cell margins
   * (marL/marR/marT/marB) override the bodyPr defaults — in PowerPoint table
   * cells, the tcPr margins are the source of truth for cell padding, not
   * the OOXML shape bodyPr defaults (91440/45720 EMU).
   */
  cellMargins?: { lIns: number; rIns: number; tIns: number; bIns: number };
  /**
   * Text frame width in px (shape width). Used to clamp the leading tab-fold
   * indent: a custom tab stop (a:tabLst) is an absolute column that can exceed
   * a narrow box. Without a clamp the folded `margin-left` swallows the whole
   * frame and CJK text wraps one char per line (slide 14 的三张窄卡片). When the
   * stop overshoots the box we cap the indent so a usable text column remains.
   */
  frameWidthPx?: number;
  /** Text frame height in output CSS coordinates. Used by preset text-warp layouts. */
  frameHeightPx?: number;
  /** Force paragraph text to stay on one line when PPT will grow/rotate the box instead of wrapping. */
  forceNoWrap?: boolean;
}

/**
 * Same contract as `TextRenderer.renderTextBody`, but returns an HTML string for `Shape.content` / `Text.content`
 * (types.ts / README) instead of mutating a DOM `container`.
 */
export function renderTextBody(
  textBody: TextBody | undefined,
  placeholder: PlaceholderInfo | undefined,
  ctx: RenderContext,
  options?: RenderTextBodyOptions,
): string {
  if (!textBody?.paragraphs?.length) return '';

  const category = getPlaceholderCategory(placeholder);
  let bulletCounter = 0;
  const noWrap = options?.forceNoWrap || textBody.bodyProperties?.attr('wrap') === 'none';
  // ECMA-376: 默认状态下首段的 spcBef 与末段的 spcAft 都要丢掉，只有 bodyPr@spcFirstLastPara="1"
  // 时才把它们当真。我们之前对所有段一律渲染成 margin-top，结果首段被多挤了 spcBef pt，
  // 例如 slide 4 "第一讲 / 初识清华" cell 在 cy=63pt + 17.2pt 上下内边距下只剩 46pt 排两行
  // 18pt 文字，被 6pt 的首段 spcBef 顶到溢出，最后一行被裁。
  const spcFirstLastPara =
    textBody.bodyProperties?.attr('spcFirstLastPara') === '1' ||
    textBody.bodyProperties?.attr('spcFirstLastPara') === 'true';
  const lastParaIdx = textBody.paragraphs.length - 1;

  let html = '';
  const textWarp = getSupportedTextWarp(textBody);

  if (textWarp) {
    html = renderTextWarp(textBody, category, placeholder, ctx, options, textWarp);
  } else {
    let paraIdx = 0;
    for (const paragraph of textBody.paragraphs) {
      const isFirstPara = paraIdx === 0;
      const isLastPara = paraIdx === lastParaIdx;
      paraIdx++;
      const level = paragraph.level;

      // ---- Build merged paragraph style (7-level inheritance) ----
      const merged = buildMergedParagraphStyle(textBody, paragraph, category, placeholder, ctx);

      // ---- Apply paragraph styles (equivalent to paraDiv.style.* in TextRenderer) ----
      const paraCssParts: string[] = [];
      if (merged.align) {
        const alignMap: Record<string, string> = {
          l: 'left',
          ctr: 'center',
          r: 'right',
          just: 'justify',
          dist: 'justify',
        };
        paraCssParts.push(`text-align: ${alignMap[merged.align] || 'left'}`);
      }
      // PowerPoint 的 hanging-indent 默认：`<a:pPr indent="-N">` 用于把首行
      // 拉回，但作者通常省略 marL，因为 PPT 对带 bullet 的段默认套用 marL=N
      // 让 bullet 落在元素左边沿、body 落在 +N 缩进。我们 marL 只在显式存在
      // 时设置，缺省时 first-line 跑到 element 外，bullet 会和左侧编号圆
      // (slide 3) 之类的相邻元素重叠。指标段（有 bullet 且 indent<0 且无
      // 显式 marL）按 PPT 默认补 marL = -indent。
      let effectiveMarginLeft = merged.marginLeft;
      // 标记 marL 是否为「合成」(无真实 marL、按 -indent 补)。合成意味着 bullet 紧贴
      // element 左沿、可能压住相邻形状（slide 3 编号圆）；真实 marL 则 bullet 落在
      // marL+indent 的悬挂位、不贴边。下方 bullet 槽位的 symbol padding 据此区分。
      let marginLeftSynthesized = false;
      if (
        (effectiveMarginLeft === undefined || effectiveMarginLeft === 0) &&
        merged.textIndent !== undefined &&
        merged.textIndent < 0 &&
        (merged.bulletChar || merged.bulletAutoNum)
      ) {
        effectiveMarginLeft = -merged.textIndent;
        marginLeftSynthesized = true;
      }
      // Tab stop width from a:tabLst (first stop): (firstStop − marginLeft), default
      // OOXML 96px grid. Shared by the leading-indent fold and the tab-size fallback.
      const resolveTabPx = (): number => {
        let tabPx = 96;
        const firstStop = merged.tabStopsPx?.[0];
        if (firstStop !== undefined) {
          const ml = effectiveMarginLeft ?? 0;
          const derived = firstStop - ml;
          if (derived >= 1) tabPx = derived;
        }
        return tabPx;
      };

      // ── 行首 tab/空格缩进折叠 ──────────────────────────────────────────
      // PowerPoint 用「前导 \t (+a:tabLst) 和/或前导空格」把标题/列表行推到图标右侧。
      // 裸 \t（white-space:pre + tab-size）和空格折出的空 inline-block 占位在原样吐
      // HTML 的渲染器里没问题，但 a2m 编辑画布走 ProseMirror 重新解析：绝对行高那条路
      // 产出的「外层 div + 行 wrapper div」嵌套里 text-indent 首行缩进继承不可靠（实测
      // margin-left 生效、text-indent 丢失）。因此把行首空白折进 margin-left（整块右移）
      // ——每条图标行都是单行，整块右移与首行缩进视觉等价，raw-HTML 也一致；取值复用既有
      // tabPx / 0.25em。仅在「行首含 tab」时折叠，并把已折叠的行首空白从 run 剥掉（见下 run 循环）。
      let leadingStripChars = 0;
      let leadingFoldedTabs = 0;
      let leadingFoldPx = 0;
      let leadingFoldEm = 0;
      let leadingSawTab = false;
      let leadingFirstStop: number | undefined;
      {
        let spaceCount = 0;
        let consumed = 0;
        let sawTab = false;
        let stop = false;
        for (const run of paragraph.runs) {
          if (stop) break;
          const txt = run.text ?? '';
          if (txt === '') continue;
          let i = 0;
          while (i < txt.length && (txt[i] === '\t' || txt[i] === ' ')) {
            if (txt[i] === '\t') {
              leadingFoldedTabs++;
              sawTab = true;
            } else spaceCount++;
            i++;
          }
          consumed += i;
          if (i < txt.length) stop = true;
        }
        if (sawTab) {
          // A custom a:tabLst stop is an ABSOLUTE column. A leading tab advances
          // the text to that stop; if the stop sits at/behind the paragraph marL
          // it can't move text backwards, so the tab adds nothing to marginLeft.
          // (slide 14 的窄卡片：tab pos≈35.5px < marL≈49px，旧逻辑 derived<1 退回
          // 96px 默认网格，把首段错误推到 marL+96=145px。)只有「无自定义 tabLst」用 96。
          const firstStop = merged.tabStopsPx?.[0];
          const ml = effectiveMarginLeft ?? 0;
          const tabAdvance = firstStop !== undefined ? Math.max(0, firstStop - ml) : 96;
          leadingFoldPx = leadingFoldedTabs * tabAdvance;
          leadingFoldEm = spaceCount * 0.25;
          leadingStripChars = consumed;
          leadingSawTab = true;
          leadingFirstStop = firstStop;
        }
      }

      let finalMarginLeftPx: number | undefined;
      if (effectiveMarginLeft !== undefined || leadingFoldPx > 0 || leadingFoldEm > 0) {
        if (leadingFoldPx > 0 || leadingFoldEm > 0) {
          let mlPx = (effectiveMarginLeft ?? 0) + leadingFoldPx;
          // Clamp against the frame width: a tabLst stop is an absolute column
          // that may sit past a narrow box (slide 14 的窄卡片 firstStop≈145px vs
          // 宽 123px)。不裁剪的话 margin-left 吃光整框，CJK 文本逐字竖排。保留至少
          // 半个框宽给文本列；宽框（如 388px）下不会触发，行为不变。
          const frameW = options?.frameWidthPx;
          if (frameW && frameW > 0) {
            const maxMlPx = Math.max(0, frameW - frameW * 0.5);
            if (mlPx > maxMlPx) mlPx = maxMlPx;
          }
          finalMarginLeftPx = mlPx;
          paraCssParts.push(
            `margin-left: ${leadingFoldEm > 0 ? `calc(${mlPx.toFixed(2)}px + ${leadingFoldEm.toFixed(2)}em)` : `${mlPx}px`}`,
          );
        } else {
          finalMarginLeftPx = effectiveMarginLeft;
          paraCssParts.push(`margin-left: ${effectiveMarginLeft}px`);
        }
      }
      // text-indent: when a leading tab folded but its stop is at/behind marL
      // (leadingFoldPx === 0), the tab still nudges the FIRST line forward to the
      // stop — wrapped lines stay at marL. Position the first line at the stop so
      // it clears a left-side icon (slide 14 图标与首字重叠). a2m drops text-indent
      // → first line falls back to marL(≥stop here), still clearing the icon.
      const tabStopBehindMargin =
        leadingSawTab && leadingFirstStop !== undefined && leadingFoldPx === 0;
      if (tabStopBehindMargin && finalMarginLeftPx !== undefined) {
        const firstLineIndentPx = leadingFirstStop! - finalMarginLeftPx;
        paraCssParts.push(`text-indent: ${firstLineIndentPx.toFixed(2)}px`);
      } else if (merged.textIndent !== undefined) {
        paraCssParts.push(`text-indent: ${merged.textIndent}px`);
      }
      // OOXML: when <a:lnSpc> is absent at every level of the cascade, the
      // implicit default is "single spacing" = 1.0. We fall back to that so
      // the browser doesn't take over with `line-height: normal` (~1.2 for
      // most fonts, sometimes much larger for CJK with tall typo metrics),
      // which causes multi-paragraph body text to overflow its container
      // and visibly stack/overlap.
      const effectiveLineHeight = merged.lineHeight ?? '1';
      paraCssParts.push(`line-height: ${effectiveLineHeight}`);
      // Determine effective font size for percentage-based spacing
      // Use defRPr or first run's font size, fallback to 12pt
      let effectiveFontSize = 12; // default 12pt
      if (merged.defRPrs) {
        for (const drp of merged.defRPrs) {
          const sz = drp.numAttr('sz');
          if (sz !== undefined) effectiveFontSize = sz / 100;
        }
      }
      if (paragraph.runs.length > 0 && paragraph.runs[0].properties) {
        const sz = paragraph.runs[0].properties.numAttr('sz');
        if (sz !== undefined) effectiveFontSize = sz / 100;
      }

      // Empty paragraph (no visible runs → renders as a bare <br/>): PowerPoint
      // sizes the blank line from its end-of-paragraph mark (endParaRPr). Without
      // a font-size the <br/> collapses to the container default and the blank
      // line reserves too little height — e.g. slide 27 用两行空段为下方"浮"在
      // 文本框上的独立公式预留高度，空段过矮会让后续正文上移、与公式重叠。
      // Whitespace-only paragraphs (just tabs/spaces) are pure spacers: their
      // glyphs get stripped by the leading-tab fold, so they must be sized like
      // empty paragraphs (font-size at the <p>, from the run/endParaRPr) or the
      // line-height collapses to the container default. slide 4 的绿块用一段
      // sz=3600 + 仅含 \t 的空段把编号顶到图标下方；按 .length>0 判它"非空"会丢掉
      // 36pt 行高，编号塌回去压在图标上。用 trim() 把纯空白段也当空段处理。
      const paraHasVisibleRuns = paragraph.runs.some(
        (r) => r.text != null && r.text.trim().length > 0,
      );
      if (!paraHasVisibleRuns && paragraph.endParaRPr) {
        const epSz = paragraph.endParaRPr.numAttr('sz');
        if (epSz !== undefined) effectiveFontSize = epSz / 100;
      }
      if (!paraHasVisibleRuns) {
        paraCssParts.push(`font-size: ${effectiveFontSize}pt`);
      }

      // CSS line-height places the extra leading (lineHeight − 1) × fontSize
      // half above and half below the glyph, while PowerPoint pushes ALL of it
      // above the first line — most visible on cover titles that use a large
      // lnSpc value like 220% to create a deliberate gap between chapter number
      // and the chapter title. Without the compensation, that "deliberate gap"
      // ends up half its intended size in the browser. We only top up the
      // missing half on unitless line-heights > 1; absolute spcPts already
      // encode the exact line height and shouldn't be double-counted.
      // Only top up the leading for paragraphs that actually have glyphs. An EMPTY
      // (blank) paragraph is a pure spacer — PowerPoint reserves exactly lnSpc ×
      // fontSize for it, with no extra half-leading above. Adding padding-top to
      // blank lines over-reserves height; on decks that stack several blank
      // paragraphs to push a bottom block down (slide 10 绿色提示条) the drift
      // accumulates and the bottom text slips below its box.
      if (
        paraHasVisibleRuns &&
        !merged.lineHeightAbsolute &&
        /^[\d.]+$/.test(effectiveLineHeight)
      ) {
        const lh = parseFloat(effectiveLineHeight);
        if (lh > 1) {
          const extraHalf = ((lh - 1) / 2) * effectiveFontSize;
          if (extraHalf > 0.01) {
            paraCssParts.push(`padding-top: ${extraHalf.toFixed(2)}pt`);
          }
        }
      }

      // 首段 spcBef / 末段 spcAft 仅在 bodyPr@spcFirstLastPara=1 时计入
      const applySpaceBefore = !isFirstPara || spcFirstLastPara;
      const applySpaceAfter = !isLastPara || spcFirstLastPara;
      if (applySpaceBefore && merged.spaceBefore !== undefined && merged.spaceBefore !== 0) {
        paraCssParts.push(`margin-top: ${merged.spaceBefore}pt`);
      } else if (
        applySpaceBefore &&
        merged.spaceBeforePct !== undefined &&
        merged.spaceBeforePct !== 0
      ) {
        paraCssParts.push(`margin-top: ${merged.spaceBeforePct * effectiveFontSize}pt`);
      }
      if (applySpaceAfter && merged.spaceAfter !== undefined && merged.spaceAfter !== 0) {
        paraCssParts.push(`margin-bottom: ${merged.spaceAfter}pt`);
      } else if (
        applySpaceAfter &&
        merged.spaceAfterPct !== undefined &&
        merged.spaceAfterPct !== 0
      ) {
        paraCssParts.push(`margin-bottom: ${merged.spaceAfterPct * effectiveFontSize}pt`);
      }

      // ---- Bullets ----
      // Suppress bullets for metadata placeholders (slide number, date, footer)
      // Also suppress for empty paragraphs (no visible runs) — PowerPoint never shows bullets for them
      const hasVisibleRuns = paragraph.runs.some((r) => r.text != null && r.text.length > 0);
      const suppressBullet =
        !hasVisibleRuns ||
        placeholder?.type === 'sldNum' ||
        placeholder?.type === 'dt' ||
        placeholder?.type === 'ftr' ||
        placeholder?.type === 'title' ||
        placeholder?.type === 'ctrTitle' ||
        placeholder?.type === 'subTitle';
      let bulletPrefix = '';
      if (!suppressBullet && merged.bulletNone !== true) {
        if (merged.bulletChar) {
          bulletPrefix = merged.bulletChar;
        } else if (merged.bulletAutoNum) {
          bulletPrefix = generateAutoNumber(merged.bulletAutoNum, bulletCounter);
          bulletCounter++;
        }
      }

      // When line spacing is absolute (spcPts), wrap each line in a block-level
      // div with explicit height. This ensures exact spacing regardless of font
      // metrics — CJK fonts (e.g. Microsoft YaHei) and bold faces often have
      // ascent+descent larger than the spcPts value, which causes the browser
      // to grow the line-box past the CSS line-height and silently overflow the
      // text frame. Using a fixed-height div with overflow: visible keeps each
      // line's layout footprint at exactly spcPts, matching PowerPoint behavior
      // even for single-line paragraphs.
      // tab-size 仅服务于折叠之后仍剩余的 tab（非行首 tab，少见）；行首 tab 已折进 margin-left。
      const totalTabs = paragraph.runs.reduce(
        (n, r) => n + (r.text ? (r.text.match(/\t/g)?.length ?? 0) : 0),
        0,
      );
      if (totalTabs - leadingFoldedTabs > 0) {
        paraCssParts.push(`tab-size: ${resolveTabPx().toFixed(2)}px`);
      }
      if (noWrap) {
        paraCssParts.push('white-space: nowrap');
      }
      const useLineWrappers = !!(merged.lineHeightAbsolute && merged.lineHeight);

      const paraCss = paraCssParts.join(';');
      const openTag = useLineWrappers
        ? `<div${paraCss ? ` style="${paraCss};"` : ''}>`
        : `<p${paraCss ? ` style="${paraCss};"` : ''}>`;
      const closeTag = useLineWrappers ? '</div>' : '</p>';
      html += openTag;

      // Build bullet HTML up front. We emit it AFTER opening the line wrapper
      // (when wrappers are on) so the bullet sits inline with the first line of
      // content; emitting an inline <span> before a block-level wrapper <div>
      // would push the content onto the next line and shift the whole paragraph.
      let bulletHtml = '';
      if (bulletPrefix) {
        // Compute the first-run effective style once so the bullet can inherit
        // color, font-size, AND font-family from it. Without this, auto-number
        // bullets like (1)/(2)/(3) on a dark slide rendered as tiny black text
        // because the <span> had only color set and the inherited font-size
        // from the BaseTextElement wrapper fell back to the browser default.
        const firstRunStyle: MergedRunStyle = {};
        if (merged.defRPrs) {
          for (const drp of merged.defRPrs) mergeRunProps(firstRunStyle, drp, ctx);
        }
        if (paragraph.runs.length > 0 && paragraph.runs[0].properties) {
          mergeRunProps(firstRunStyle, paragraph.runs[0].properties, ctx);
        }

        // Bullet color: 1) explicit buClr from list style, 2) first run effective color, 3) listStyle defRPr, 4) options fallback
        let bulletColor: string | undefined;
        if (merged.bulletColorNode && merged.bulletColorNode.exists()) {
          bulletColor = resolveColorToCss(merged.bulletColorNode, ctx);
        }
        if (bulletColor === undefined) {
          bulletColor = firstRunStyle.color;
        }
        if (bulletColor === undefined && textBody.listStyle) {
          const lstStyleLevel = findStyleAtLevel(textBody.listStyle, level);
          if (lstStyleLevel.exists()) {
            const lstDefRPr = lstStyleLevel.child('defRPr');
            if (lstDefRPr.exists()) {
              const fallbackStyle: MergedRunStyle = {};
              mergeRunProps(fallbackStyle, lstDefRPr, ctx);
              if (fallbackStyle.color !== undefined) {
                bulletColor = fallbackStyle.color;
              }
            }
          }
        }
        const bColor = bulletColor ?? options?.fontRefColor ?? options?.cellTextColor ?? '#000000';

        let displayChar = bulletPrefix;
        let bFontCss = '';
        const isSymbolBullet = !!(merged.bulletFont && isSymbolFont(merged.bulletFont));
        if (isSymbolBullet) {
          displayChar = symbolFontCharToUnicode(bulletPrefix, merged.bulletFont!);
        } else if (merged.bulletFont) {
          bFontCss = `font-family: ${merged.bulletFont};`;
        } else if (firstRunStyle.fontFamily) {
          // Match the first run's resolved font so the bullet doesn't fall back
          // to the browser's default serif on top of a slide that uses a sans
          // body font (or vice versa).
          bFontCss = `font-family: ${firstRunStyle.fontFamily};`;
        }

        // Bullet font-size: always emit so the bullet sizes with the paragraph
        // rather than the wrapper's inherited size. buSzPct (when present)
        // scales relative to the run font-size — same semantics as PowerPoint.
        const baseSize = firstRunStyle.fontSize ?? effectiveFontSize;
        const bulletPt =
          merged.bulletSizePct !== undefined && merged.bulletSizePct !== 1
            ? baseSize * merged.bulletSizePct
            : baseSize;
        const bSizeCss = `font-size: ${bulletPt.toFixed(1)}pt;`;

        // hanging-indent 段的 bullet 用 inline-block 占满「悬挂缩进区域」的槽位：
        // bullet 落在 marL+indent（首行起点），槽位把首行正文推到 element_x + marL，
        // 与 body 续行的左缩进对齐——这就是 PowerPoint 通过 bullet+tab 实现的视觉效果。
        // 不用 inline-block 时正文紧贴 bullet 字形右侧（例如 slide 3 row 05
        // "■" 紧挨 "传承"），与 body 续行形成台阶状错位。
        const useBulletSlot =
          effectiveMarginLeft !== undefined &&
          effectiveMarginLeft > 0 &&
          merged.textIndent !== undefined &&
          merged.textIndent < 0;
        if (useBulletSlot) {
          // 槽宽 = 悬挂缩进量 |indent|（不是 marL）。<p> 上 margin-left:marL + text-indent:indent
          // 已把首行起点定在 marL+indent；槽位只需补满到 marL，所以宽度是 |indent|。
          // 若错用 marL：当真实 marL ≫ |indent|（如 slide 2「在集体中成长」右框 marL=78/indent=-30）
          // 时，过宽的槽把正文推到 marL+|indent| 之外、bullet 离正文很远。slide 3 那种「无显式 marL、
          // 由 -indent 合成 marL」的情形 marL==|indent|，取值不变、不受影响。
          const slotWidthPx = -(merged.textIndent ?? 0);
          // symbol bullet 的字形对齐：
          // - 合成 marL（无真实 marL、bullet 紧贴 element 左沿、可能压住相邻形状，如 slide 3 编号圆）：
          //   在槽内补 padding-left:16px 把 ■ 往右推、避开相邻形状光晕；body 位置不变。
          // - 真实 marL：bullet 落在 marL+indent 的悬挂位（左对齐，无 padding），与 PPT 一致
          //   （slide 2 右框 ■ 实测落在 marL+indent，加 padding 反而把 ■ 顶到正文上）。
          const symbolSlotPad = marginLeftSynthesized
            ? 'padding-left:16px;box-sizing:border-box;'
            : 'box-sizing:border-box;';
          // 普通 list bullet（•/◦ 等非 symbol-font 字形）在槽位内靠右、贴近正文，
          // 留一个 0.4em 的小间距，续行左缩进不变、仍与首行正文对齐。
          const slotPad = isSymbolBullet
            ? symbolSlotPad
            : 'text-align:right;padding-right:0.4em;box-sizing:border-box;';
          // text-indent:0 — hanging-indent 段在 <p> 上带 `text-indent:-N`，而 CSS text-indent
          // 会被 display:inline-block 的槽位 span 当作块级容器继承，把槽内 bullet 字形再左移 N，
          // 落到 element 左外（slide 3 的 ■ 飞到左侧编号圆上）。在槽位上显式归零切断继承，bullet
          // 字形稳定落在 padding 处，body 与续行仍由 <p> 的 margin-left/text-indent 控制不受影响。
          bulletHtml = `<span style="display:inline-block;width:${slotWidthPx}px;text-indent:0;${slotPad}${bFontCss}${bSizeCss}color: ${bColor};">${escapeHtml(displayChar)}</span>`;
        } else {
          bulletHtml = `<span style="${bFontCss}${bSizeCss}color: ${bColor};">${escapeHtml(displayChar)} </span>`;
        }
      }

      let currentLineDivOpen = false;
      const openLineWrapper = () => {
        if (!useLineWrappers || !merged.lineHeight) return;
        // Fixed `height` (not min-height) pins each line to exactly spcPts — the
        // PowerPoint line pitch — regardless of the font's content area. CJK faces
        // (self-hosted SourceHanSerif/Sans) report a content area noticeably taller
        // than spcPts (e.g. 15pt glyphs ≈ 30px vs a 19.15pt≈25.5px pitch); with
        // `min-height` Chrome grows the line box to that content area, so every
        // absolute-spaced line is a few px too tall. Stacked over a column the drift
        // pushes bottom blocks down — e.g. 后勤 slide 10/11 绿色提示框文字下溢/未居中。
        // Trade-off: a single logical paragraph whose text SOFT-wraps to >1 visual
        // line will overflow this fixed-height box (overlapping the next paragraph),
        // since one wrapper == one logical line. Explicit line breaks are safe (each
        // `\n` opens its own wrapper). Acceptable here: absolute-spaced paragraphs in
        // these decks are single-line; matching the line pitch matters more.
        // min-height(而非 height)：固定 height 能精确还原 PPT 行距，但被就地编辑(增删行)后
        // 无法 reflow——多出的行 overflow 到盒外，且"实时编辑态"与"保存→重解析态"对不齐。
        // a2m 是编辑器，编辑一致性优先：改用 min-height，编辑增删行时盒子能撑高、两态一致。
        // 代价：CJK 字体内容区略高于 spcPts 时单行可能高几 px（行距漂移），由回归把关。
        html += `<div style="min-height: ${merged.lineHeight};overflow: visible">`;
        currentLineDivOpen = true;
      };
      const closeLineWrapper = () => {
        if (currentLineDivOpen) {
          html += '</div>';
          currentLineDivOpen = false;
        }
      };

      if (useLineWrappers) {
        // wrapper mode: open wrapper then emit bullet inside, so the inline
        // bullet shares the first line baseline with the run content. Empty
        // paragraphs need no <br/> — the wrapper <div> already has a fixed line
        // height, and an extra <br/> would double the empty paragraph's footprint.
        openLineWrapper();
        html += bulletHtml;
      } else {
        // legacy <p> path: bullet first, then a blank-line filler for an otherwise
        // empty paragraph. Use &nbsp; (NOT <br/>): a trailing <br/> renders as 1 line
        // in raw-HTML renderers, but a2m 的 ProseMirror 会在末尾 hard_break 后再补一个
        // trailingBreak（<br><br>）→ 空段变成 2 行，累积把下方正文/图标整体压下去
        // （图标与行错位、绿框文字被挤出）。&nbsp; 在两端都恰好是 1 行
        // （高度 = font-size × line-height），不会被 ProseMirror 加倍。
        html += bulletHtml;
        // Blank-line filler: an empty <p> reserves NO height (height 0) regardless
        // of font-size/line-height — it needs an inline box. Emit &nbsp; whenever
        // the paragraph has no VISIBLE runs, which now also covers whitespace-only
        // spacer paragraphs whose tab/space runs get stripped by the leading fold
        // (slide 4 绿块的 sz=3600 空段：少了 &nbsp; 就塌成 0 高，编号顶回图标上)。
        if (!paraHasVisibleRuns) {
          html += '&nbsp;';
        }
      }

      // Merge consecutive runs with identical style strings into a single <span>,
      // matching pptxtojson's compact HTML output for better pptist compatibility.
      let prevStyleStr: string | null = null;
      let prevIsLink = false;
      let accumulatedText = '';

      const flushAccumulatedRun = () => {
        if (!accumulatedText || prevStyleStr === null) return;
        html += `<span style="${prevStyleStr}">${accumulatedText}</span>`;
        accumulatedText = '';
      };

      for (const run of paragraph.runs) {
        // Inline formula run (公式与正文混排): render as inline KaTeX so the
        // surrounding 中文 isn't lost and the formula isn't pulled out into its
        // own stacked block. Falls back to the formula's plain text on failure.
        if (run.ommlXml) {
          flushAccumulatedRun();
          prevStyleStr = null;
          const mStyle: MergedRunStyle = {};
          if (merged.defRPrs) {
            for (const drp of merged.defRPrs) mergeRunProps(mStyle, drp, ctx);
          }
          if (run.properties) mergeRunProps(mStyle, run.properties, ctx);
          const mSizePt = mStyle.fontSize ?? effectiveFontSize;
          // OMML run color (a:rPr>solidFill) is dropped by the latex conversion, so
          // when the inline formula is one color, resolve it from the captured node.
          const mathColorNode = (run as { mathColorNode?: SafeXmlNode }).mathColorNode;
          const mColor =
            mathColorNode && mathColorNode.exists()
              ? resolveColorToCss(mathColorNode, ctx)
              : (mStyle.color ?? options?.fontRefColor ?? '#000000');
          const latex = ommlToLatex(run.ommlXml);
          let mathHtml = '';
          if (latex) {
            try {
              // throwOnError:true so invalid LaTeX throws → we fall back to the
              // formula's plain text below, instead of KaTeX printing the raw
              // source in red (the "红色 LaTeX 乱码" reviewers flagged).
              mathHtml = katex.renderToString(latex, {
                displayMode: false,
                throwOnError: true,
              });
            } catch {
              mathHtml = '';
            }
          }
          const inlineBody = mathHtml || formatRunTextForHtml(run.text ?? '');
          if (inlineBody) {
            html += `<span style="font-size: ${mSizePt.toFixed(1)}pt;color: ${mColor};">${inlineBody}</span>`;
          }
          prevIsLink = false;
          continue;
        }
        if (run.text === '\n') {
          flushAccumulatedRun();
          prevStyleStr = null;
          if (useLineWrappers) {
            closeLineWrapper();
            openLineWrapper();
          } else {
            html += '<br/>';
          }
          continue;
        }

        // Build merged run style
        const runStyle: MergedRunStyle = {};

        // Apply default run properties from all inherited defRPr nodes
        if (merged.defRPrs) {
          for (const drp of merged.defRPrs) mergeRunProps(runStyle, drp, ctx);
        }

        // Level 7: run rPr
        if (run.properties) {
          mergeRunProps(runStyle, run.properties, ctx);
        }

        // Fallback: if no color resolved yet, check the shape's lstStyle defRPr.
        if (runStyle.color === undefined && textBody.listStyle) {
          const lstStyleLevel = findStyleAtLevel(textBody.listStyle, level);
          if (lstStyleLevel.exists()) {
            const lstDefRPr = lstStyleLevel.child('defRPr');
            if (lstDefRPr.exists()) {
              const fallbackStyle: MergedRunStyle = {};
              mergeRunProps(fallbackStyle, lstDefRPr, ctx);
              if (fallbackStyle.color !== undefined) {
                runStyle.color = fallbackStyle.color;
              }
            }
          }
        }

        let runText = run.text ?? '';
        // 剥掉已折叠进段落 text-indent 的行首空白（见上「行首缩进折叠」）；
        // 完全由空白构成的行首 run 折叠后为空，直接跳过不再输出。
        if (leadingStripChars > 0 && runText) {
          let k = 0;
          while (
            k < runText.length &&
            leadingStripChars > 0 &&
            (runText[k] === '\t' || runText[k] === ' ')
          ) {
            k++;
            leadingStripChars--;
          }
          if (k > 0) runText = runText.slice(k);
          if (runText === '') continue;
        }
        // <a:fld type="..."> 动态字段——OOXML 里 fld 节点常没有 <a:t> 子节点
        // (PPT 在显示时算出来塞进去)，导致 parser 拿到空字符串。常见的几种：
        //   - slidenum: 当前页码（1-based）
        //   - datetime / datetime1..n: 当前日期，先用占位 mm/dd/yyyy 跑通；
        //     真要精确格式化交给上层
        // 其它没识别的 fld 类型保留 parser 的原文本（多半也是空的）。
        if ((run as { fldType?: string }).fldType) {
          const type = (run as { fldType?: string }).fldType;
          if (type === 'slidenum') {
            if (!runText) runText = String(ctx.slide.index + 1);
          }
        }
        if (run.properties) {
          const symNode = run.properties.child('sym');
          if (symNode.exists()) {
            const symTypeface = symNode.attr('typeface');
            if (isSymbolFont(symTypeface)) {
              runText = Array.from(runText)
                .map((ch) => symbolFontCharToUnicode(ch, symTypeface!))
                .join('');
            }
          }
        }
        const inner = formatRunTextForHtml(runText);
        const tabStyleSuffix = runText.includes('\t') ? ';white-space: pre' : '';

        const styleStr = runStylesToCssString(runStyle, run, options, ctx) + tabStyleSuffix;
        const isLink = !!runStyle.hlinkClick;

        if (isLink) {
          flushAccumulatedRun();
          prevStyleStr = null;
          const href = escapeHtmlAttr(runStyle.hlinkClick!);
          html += `<a href="${href}" target="_blank" rel="noopener noreferrer" style="${styleStr}">${inner}</a>`;
        } else if (prevStyleStr === styleStr && !prevIsLink) {
          accumulatedText += inner;
        } else {
          flushAccumulatedRun();
          prevStyleStr = styleStr;
          accumulatedText = inner;
        }
        prevIsLink = isLink;
      }
      flushAccumulatedRun();

      if (useLineWrappers) {
        closeLineWrapper();
      }

      // endParaRPr: when the paragraph ends with a line break (trailing \n),
      // the end-of-paragraph mark (endParaRPr) defines the font size for the
      // trailing blank line. Without this, bottom-anchored text boxes render
      // content too low because the trailing space is too small.
      if (paragraph.endParaRPr) {
        const lastRun = paragraph.runs[paragraph.runs.length - 1];
        if (lastRun?.text === '\n') {
          const epSz = paragraph.endParaRPr.numAttr('sz');
          if (epSz !== undefined) {
            html += `<span style="font-size: ${(epSz / 100).toFixed(4)}pt">&#x200B;</span>`;
          }
        }
      }

      html += closeTag;
    }
  }

  // Apply bodyPr text insets (lIns/rIns/tIns/bIns) as a wrapping div with padding.
  // OOXML defaults: lIns=91440, tIns=45720, rIns=91440, bIns=45720 (EMU).
  // Always emit the padding wrapper so the consumer doesn't need to know defaults.
  // For table cells, `cellMargins` (from tcPr marL/marR/marT/marB) takes
  // precedence — PowerPoint uses cell margins, not bodyPr defaults, for the
  // padding inside table cells. Explicit bodyPr insets on the cell's txBody
  // still win (rare but spec-allowed override).
  const bp = textBody.bodyProperties;
  if (bp?.exists()) {
    const cm = options?.cellMargins;
    const DEFAULT_H_INSET = 91440;
    const DEFAULT_V_INSET = 45720;
    const lIns = bp.numAttr('lIns') ?? cm?.lIns ?? DEFAULT_H_INSET;
    const rIns = bp.numAttr('rIns') ?? cm?.rIns ?? DEFAULT_H_INSET;
    const tIns = bp.numAttr('tIns') ?? cm?.tIns ?? DEFAULT_V_INSET;
    const bIns = bp.numAttr('bIns') ?? cm?.bIns ?? DEFAULT_V_INSET;
    const pt = (emu: number) => parseFloat((emu / 12700).toFixed(2));
    html = `<div style="padding: ${pt(tIns)}pt ${pt(rIns)}pt ${pt(bIns)}pt ${pt(lIns)}pt;">${html}</div>`;
  }

  return html;
}

/** Maps TextRenderer run loop (element.style) to a single `style=""` string. */
function runStylesToCssString(
  runStyle: MergedRunStyle,
  run: TextRun,
  options: RenderTextBodyOptions | undefined,
  ctx: RenderContext,
): string {
  const fontSize = runStyle.fontSize || 12;
  const parts: string[] = [];
  parts.push(`font-size: ${fontSize}pt`);

  // Bold: explicit run rPr > cellTextBold (table style tcTxStyle) > inherited styles
  const hasExplicitRunBold = run.properties?.attr('b') !== undefined;
  if (hasExplicitRunBold ? runStyle.bold : (options?.cellTextBold ?? runStyle.bold)) {
    parts.push('font-weight: bold');
  }
  // Italic: explicit run rPr > cellTextItalic (table style tcTxStyle) > inherited styles
  const hasExplicitRunItalic = run.properties?.attr('i') !== undefined;
  if (hasExplicitRunItalic ? runStyle.italic : (options?.cellTextItalic ?? runStyle.italic)) {
    parts.push('font-style: italic');
  }

  const decorations: string[] = [];
  if (runStyle.underline) decorations.push('underline');
  if (runStyle.strikethrough) decorations.push('line-through');
  if (decorations.length > 0) {
    parts.push(`text-decoration: ${decorations.join(' ')}`);
  }

  // Color priority: explicit run rPr > hlink theme color > cellTextColor (table style tcTxStyle) > fontRef (shape style) > inherited styles > black default
  // cellTextColor from table style overrides inherited cascade colors but yields to explicit run/paragraph solidFill/gradFill.
  // fontRefColor overrides inherited styles but yields to explicit run solidFill/gradFill.
  const hasExplicitRunColor =
    run.properties?.child('solidFill').exists() || run.properties?.child('gradFill').exists();
  let effectiveColor: string | undefined;
  if (options?.fontRefColor) {
    effectiveColor = hasExplicitRunColor ? runStyle.color : options.fontRefColor;
  } else if (options?.cellTextColor && !hasExplicitRunColor) {
    effectiveColor = options.cellTextColor;
  } else {
    effectiveColor = runStyle.color;
  }

  // Hyperlink default color: when the run is a hyperlink and has no explicit
  // solidFill on its own rPr, use the theme's hlink color.  This matches
  // PowerPoint behaviour where hyperlink text defaults to the hlink scheme color.
  if (runStyle.hlinkClick && !hasExplicitRunColor) {
    const hlinkHex = ctx.theme.colorScheme.get('hlink');
    if (hlinkHex) {
      effectiveColor = hlinkHex.startsWith('#') ? hlinkHex : `#${hlinkHex}`;
    }
  }

  if (effectiveColor) {
    parts.push(`color: ${effectiveColor}`);
  } else {
    // No explicit color from run/paragraph/style: use black so text does not inherit page CSS (e.g. body { color: #e0e0e0 })
    parts.push('color: #000000');
  }

  // Gradient text fill: use background-clip to paint text with gradient
  if (runStyle.textGradientCss) {
    parts.push(`background: ${runStyle.textGradientCss}`);
    parts.push('-webkit-background-clip: text');
    parts.push('background-clip: text');
    parts.push('color: transparent');
  }

  // Text outline (a:ln on rPr) and noFill handling
  if (runStyle.textNoFill || runStyle.textOutlineWidth) {
    const strokeW = runStyle.textOutlineWidth ?? 0.75;
    if (runStyle.textNoFill && runStyle.textOutlineGradientCss) {
      // Ghost text: no fill + gradient outline → show outline fading via mask
      const outlineColor = '#ffffff'; // base stroke color (gradient applied via mask)
      parts.push('color: transparent');
      parts.push(`-webkit-text-stroke-width: ${strokeW}px`);
      parts.push(`-webkit-text-stroke-color: ${outlineColor}`);
      parts.push('paint-order: stroke fill');
      const maskGrad = runStyle.textOutlineGradientCss;
      parts.push(`mask-image: ${maskGrad}`);
      parts.push(`-webkit-mask-image: ${maskGrad}`);
    } else if (runStyle.textNoFill && runStyle.textOutlineColor) {
      // Ghost text with solid outline
      parts.push('color: transparent');
      parts.push(`-webkit-text-stroke-width: ${strokeW}px`);
      parts.push(`-webkit-text-stroke-color: ${runStyle.textOutlineColor}`);
      parts.push('paint-order: stroke fill');
    } else if (runStyle.textNoFill) {
      // noFill with no outline — invisible text (but keep space)
      parts.push('color: transparent');
    } else if (runStyle.textOutlineColor) {
      // Outline with normal fill
      parts.push(`-webkit-text-stroke-width: ${strokeW}px`);
      parts.push(`-webkit-text-stroke-color: ${runStyle.textOutlineColor}`);
      parts.push('paint-order: stroke fill');
    }
  }

  // Font family: explicit run rPr > cellTextFontFamily (table style) > inherited > theme fallback
  const hasExplicitRunFont =
    run.properties?.child('latin').exists() ||
    run.properties?.child('ea').exists() ||
    run.properties?.child('cs').exists();
  const effectiveFont = hasExplicitRunFont
    ? runStyle.fontFamily
    : (options?.cellTextFontFamily ?? runStyle.fontFamily);
  if (effectiveFont) {
    parts.push(`font-family: ${effectiveFont}`);
  } else {
    // Fallback to theme minor font
    const fallback = ctx.theme.minorFont.latin || ctx.theme.minorFont.ea;
    if (fallback) {
      parts.push(`font-family: ${fallback}`);
    }
  }

  // Character spacing (a:spc) — compact/tracking in points
  if (runStyle.letterSpacingPt !== undefined) {
    parts.push(`letter-spacing: ${runStyle.letterSpacingPt}pt`);
  }
  // Kerning (a:kern): val = min font size (pt) to kern; 0 = always kern
  if (runStyle.kern !== undefined) {
    const effectivePt = runStyle.fontSize || 12;
    parts.push(`font-kerning: ${effectivePt >= runStyle.kern ? 'normal' : 'none'}`);
  }

  // Text capitalization (a:rPr@cap)
  if (runStyle.cap === 'all') {
    parts.push('text-transform: uppercase');
  } else if (runStyle.cap === 'small') {
    parts.push('font-variant: small-caps');
  }

  // Baseline shift (superscript/subscript)
  if (runStyle.baseline !== undefined && runStyle.baseline !== 0) {
    // OOXML baseline is in 1000ths of percent; positive = superscript, negative = subscript
    const shiftPct = runStyle.baseline / 1000;
    parts.push(`vertical-align: ${shiftPct}%`);
    // PowerPoint renders ANY baseline-shifted (super/subscript) run at a reduced
    // size, regardless of how small the shift is. Some decks abuse a tiny shift
    // (e.g. baseline=5000 → 5%) together with an inflated sz to fake normal text
    // (slide 14 的标题首段 sz=2000+baseline=5000，PPT 实际按 ~0.65 缩到 13pt =
    // 正文字号)。之前只在 |shift|≥20% 时缩，导致这类首段被放大成 20pt。
    parts.push(`font-size: ${fontSize * 0.65}pt`);
  }

  if (runStyle.textShadowCss) {
    parts.push(`text-shadow: ${runStyle.textShadowCss}`);
  }

  return parts.join(';') + (parts.length ? ';' : '');
}
