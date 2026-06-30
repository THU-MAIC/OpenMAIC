/**
 * Math serializer — converts MathNodeData into a Math element with LaTeX.
 *
 * Pipeline: OMML XML → normalizeOmmlXml (surrogate-safe Unicode normalization)
 *         → omml2mathml (MathML DOM) → mathml-to-latex (LaTeX string)
 *         → postProcessLatex (clean up remaining Unicode / HTML entities)
 */

import type { MathNodeData } from '../model/nodes/MathNode';
import type { RenderContext } from './RenderContext';
import type { Math as MathElement } from '../adapter/types';
import { resolveMediaToUrl } from '../utils/mediaWebConvert';
import { resolveMediaPath } from '../utils/media';
import { resolveColorToCss } from './StyleResolver';
import { DOMParser } from '@xmldom/xmldom';
import { parseDocxMathContent } from '../utils/eqFieldParser';
import JSZip from 'jszip';

// @ts-expect-error — omml2mathml has no type declarations
import omml2mathml from 'omml2mathml';
import mathmlToLatex from 'mathml-to-latex';
const MathMLToLaTeX = mathmlToLatex.MathMLToLaTeX ?? mathmlToLatex;

const PX_TO_PT = 0.75;

function pxToPt(px: number): number {
  return Number((px * PX_TO_PT).toFixed(4));
}

// ---------------------------------------------------------------------------
// Unicode Mathematical Alphanumeric Symbols normalization
// ---------------------------------------------------------------------------
// PPTX stores math variables using Unicode Mathematical Italic/Bold codepoints
// (e.g. U+1D465 "𝑥" instead of "x", U+1D6FC "𝛼" instead of "α").
//
// Two-stage normalization:
//   1. normalizeOmmlXml (pre-omml2mathml): converts to plain Unicode only
//      (ASCII for Latin, basic Greek for Greek). No LaTeX commands — those
//      would corrupt the XML structure and get split into separate elements.
//   2. postProcessLatex (post-mathml-to-latex): converts remaining basic
//      Greek Unicode to LaTeX commands (\alpha, \beta, etc.) and cleans up
//      HTML entities / invisible operators.

// --- Greek LaTeX command tables (used in stage 2) ---

const GREEK_LOWER_LATEX: Record<number, string> = {
  0x03b1: '\\alpha',
  0x03b2: '\\beta',
  0x03b3: '\\gamma',
  0x03b4: '\\delta',
  0x03b5: '\\epsilon',
  0x03b6: '\\zeta',
  0x03b7: '\\eta',
  0x03b8: '\\theta',
  0x03b9: '\\iota',
  0x03ba: '\\kappa',
  0x03bb: '\\lambda',
  0x03bc: '\\mu',
  0x03bd: '\\nu',
  0x03be: '\\xi',
  0x03c0: '\\pi',
  0x03c1: '\\rho',
  0x03c2: '\\varsigma',
  0x03c3: '\\sigma',
  0x03c4: '\\tau',
  0x03c5: '\\upsilon',
  0x03c6: '\\varphi',
  0x03c7: '\\chi',
  0x03c8: '\\psi',
  0x03c9: '\\omega',
};
const GREEK_UPPER_LATEX: Record<number, string> = {
  0x0391: 'A',
  0x0392: 'B',
  0x0393: '\\Gamma',
  0x0394: '\\Delta',
  0x0395: 'E',
  0x0396: 'Z',
  0x0397: 'H',
  0x0398: '\\Theta',
  0x0399: 'I',
  0x039a: 'K',
  0x039b: '\\Lambda',
  0x039c: 'M',
  0x039d: 'N',
  0x039e: '\\Xi',
  0x039f: 'O',
  0x03a0: '\\Pi',
  0x03a1: 'P',
  0x03a3: '\\Sigma',
  0x03a4: 'T',
  0x03a5: '\\Upsilon',
  0x03a6: '\\Phi',
  0x03a7: 'X',
  0x03a8: '\\Psi',
  0x03a9: '\\Omega',
};

// ---------------------------------------------------------------------------
// Stage 1: Unicode → plain Unicode (for XML pre-processing)
// ---------------------------------------------------------------------------
// Maps Mathematical Alphanumeric variants to BMP equivalents.
// This avoids surrogate-pair splitting in jsdom AND keeps the output
// as single Unicode characters (no multi-char LaTeX commands in XML).

function normalizeMathCharToUnicode(cp: number): string | undefined {
  // Mathematical Bold A-Z / a-z
  if (cp >= 0x1d400 && cp <= 0x1d419) return String.fromCharCode(cp - 0x1d400 + 0x41);
  if (cp >= 0x1d41a && cp <= 0x1d433) return String.fromCharCode(cp - 0x1d41a + 0x61);
  // Mathematical Italic A-Z / a-z (h = U+210E is a gap)
  if (cp >= 0x1d434 && cp <= 0x1d44d) return String.fromCharCode(cp - 0x1d434 + 0x41);
  if (cp === 0x210e) return 'h';
  if (cp >= 0x1d44e && cp <= 0x1d467) return String.fromCharCode(cp - 0x1d44e + 0x61);
  // Mathematical Bold Italic A-Z / a-z
  if (cp >= 0x1d468 && cp <= 0x1d481) return String.fromCharCode(cp - 0x1d468 + 0x41);
  if (cp >= 0x1d482 && cp <= 0x1d49b) return String.fromCharCode(cp - 0x1d482 + 0x61);
  // Mathematical Sans-Serif / Bold Sans-Serif / Monospace (0x1D5A0–0x1D6A3)
  if (cp >= 0x1d5a0 && cp <= 0x1d5b9) return String.fromCharCode(cp - 0x1d5a0 + 0x41);
  if (cp >= 0x1d5ba && cp <= 0x1d5d3) return String.fromCharCode(cp - 0x1d5ba + 0x61);
  if (cp >= 0x1d5d4 && cp <= 0x1d5ed) return String.fromCharCode(cp - 0x1d5d4 + 0x41);
  if (cp >= 0x1d5ee && cp <= 0x1d607) return String.fromCharCode(cp - 0x1d5ee + 0x61);
  if (cp >= 0x1d670 && cp <= 0x1d689) return String.fromCharCode(cp - 0x1d670 + 0x41);
  if (cp >= 0x1d68a && cp <= 0x1d6a3) return String.fromCharCode(cp - 0x1d68a + 0x61);

  // Mathematical Bold / Italic / Bold-Italic Greek → basic Greek Unicode
  // Bold Greek Capitals (Α-Ω): U+1D6A8–U+1D6C0 → U+0391+
  if (cp >= 0x1d6a8 && cp <= 0x1d6c0) return String.fromCodePoint(cp - 0x1d6a8 + 0x0391);
  // Bold Greek Small (α-ω): U+1D6C2–U+1D6DA → U+03B1+
  if (cp >= 0x1d6c2 && cp <= 0x1d6da) return String.fromCodePoint(cp - 0x1d6c2 + 0x03b1);
  // Italic Greek Capitals: U+1D6E2–U+1D6FA → U+0391+
  if (cp >= 0x1d6e2 && cp <= 0x1d6fa) return String.fromCodePoint(cp - 0x1d6e2 + 0x0391);
  // Italic Greek Small: U+1D6FC–U+1D714 → U+03B1+
  if (cp >= 0x1d6fc && cp <= 0x1d714) return String.fromCodePoint(cp - 0x1d6fc + 0x03b1);
  // Bold Italic Greek Capitals: U+1D71C–U+1D734 → U+0391+
  if (cp >= 0x1d71c && cp <= 0x1d734) return String.fromCodePoint(cp - 0x1d71c + 0x0391);
  // Bold Italic Greek Small: U+1D736–U+1D74E → U+03B1+
  if (cp >= 0x1d736 && cp <= 0x1d74e) return String.fromCodePoint(cp - 0x1d736 + 0x03b1);

  // Mathematical Bold Digits 0-9: U+1D7CE–U+1D7D7
  if (cp >= 0x1d7ce && cp <= 0x1d7d7) return String.fromCharCode(cp - 0x1d7ce + 0x30);

  // --- Math Greek "extra" symbols that sit right after each style's letter run ---
  // Each of the 4 styled Greek blocks (Bold/Italic/BoldItalic/SansBold) appends
  // ∇ (before the caps), ∂ (after the small letters) and 6 variant glyphs
  // (ϵ ϑ ϰ ϕ ϱ ϖ). These are OUTSIDE the α–ω ranges above, so without this they
  // leak into the LaTeX as lone surrogates and KaTeX rejects them — breaks every
  // ∂L/∂w gradient formula (反向传播页全中招).
  if (cp === 0x1d6c1 || cp === 0x1d6fb || cp === 0x1d735 || cp === 0x1d76f) return '\u2207'; // ∇
  if (cp === 0x1d6db || cp === 0x1d715 || cp === 0x1d74f || cp === 0x1d789) return '\u2202'; // ∂
  // ϵ ϑ ϰ ϕ ϱ ϖ (variant Greek) → BMP equivalents
  const VARIANT_GREEK = [0x03f5, 0x03d1, 0x03f0, 0x03d5, 0x03f1, 0x03d6];
  for (const start of [0x1d6dc, 0x1d716, 0x1d750, 0x1d78a]) {
    if (cp >= start && cp <= start + 5) return String.fromCodePoint(VARIANT_GREEK[cp - start]);
  }

  return undefined;
}

/**
 * Pre-process OMML XML: normalize Unicode Mathematical Alphanumeric chars
 * to BMP equivalents BEFORE passing to omml2mathml.
 * This avoids surrogate-pair splitting in jsdom (used by omml2mathml in Node).
 * Only produces single Unicode characters — never multi-char LaTeX commands.
 */
function normalizeOmmlXml(xml: string): string {
  return Array.from(xml)
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      return normalizeMathCharToUnicode(cp) ?? ch;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Stage 2: LaTeX post-processing
// ---------------------------------------------------------------------------
// After mathml-to-latex, the output may still contain:
//   - Basic Greek Unicode (α, β, π…) that should be \alpha, \beta, \pi…
//   - HTML entities (&nbsp;) from MathML serialization
//   - Invisible Unicode operators (U+2061 Function Application, etc.)
//   - Mathematical Bold Digits or other leftover Unicode

function postProcessLatex(latex: string): string {
  // Replace HTML entities and known wrong ASCII expansions from mathml-to-latex
  const result = latex
    .replace(/&nbsp;/g, '\\,')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\+-/g, '\\mp ');

  // Replace Unicode characters
  const chars = Array.from(result);
  const out: string[] = [];
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;

    // Invisible operators — remove
    if (cp === 0x2061 || cp === 0x2062 || cp === 0x2063 || cp === 0x2064) continue;
    // Non-breaking space → LaTeX thin space
    if (cp === 0x00a0) {
      out.push('\\,');
      continue;
    }

    // Basic Greek → LaTeX commands
    const greekLower = GREEK_LOWER_LATEX[cp];
    if (greekLower) {
      if (out.length > 0) out.push(' ');
      out.push(greekLower);
      out.push(' ');
      continue;
    }
    const greekUpper = GREEK_UPPER_LATEX[cp];
    if (greekUpper) {
      if (greekUpper.startsWith('\\')) {
        if (out.length > 0) out.push(' ');
        out.push(greekUpper);
        out.push(' ');
      } else {
        out.push(greekUpper);
      }
      continue;
    }

    // Mathematical variant Latin/digits that survived (shouldn't happen often)
    const mapped = normalizeMathCharToUnicode(cp);
    if (mapped !== undefined) {
      out.push(mapped);
      continue;
    }

    // Common math Unicode → LaTeX
    if (cp === 0x2212) {
      out.push('-');
      continue;
    } // minus sign
    if (cp === 0x00b1) {
      out.push('\\pm ');
      continue;
    } // ±
    if (cp === 0x2213) {
      out.push('\\mp ');
      continue;
    } // ∓
    if (cp === 0x00d7) {
      out.push('\\times ');
      continue;
    } // ×
    if (cp === 0x2026) {
      out.push('\\ldots ');
      continue;
    } // …
    if (cp === 0x221e) {
      out.push('\\infty ');
      continue;
    } // ∞
    if (cp === 0x2202) {
      out.push('\\partial ');
      continue;
    } // ∂
    if (cp === 0x2207) {
      out.push('\\nabla ');
      continue;
    } // ∇

    // Catch-all: any Mathematical Alphanumeric Symbol that slipped through
    // (script/fraktur/double-struck etc. we don't special-case) → its base
    // ASCII letter/digit, so KaTeX never receives a lone surrogate.
    const mathAlnum = normalizeMathCharToUnicode(cp);
    if (mathAlnum !== undefined) {
      out.push(mathAlnum);
      continue;
    }
    if (cp >= 0x1d400 && cp <= 0x1d7ff) {
      // Unhandled math-alnum (e.g. script/fraktur): fold to base by block math.
      const base = (cp - 0x1d400) % 52;
      out.push(String.fromCharCode(base < 26 ? 0x41 + base : 0x61 + (base - 26)));
      continue;
    }

    out.push(ch);
  }

  return out.join('').replace(/ {2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Core conversion
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// texmath cache (server-side high-fidelity OMML→LaTeX)
// ---------------------------------------------------------------------------
// The in-browser JS path (omml2mathml + mathml-to-latex) is the fallback. When
// available we prefer texmath via the app's /api/texmath endpoint (Pandoc's
// math engine — much better structure/coverage). `prefetchTexmath` is an async
// pre-pass that fills this cache BEFORE the (synchronous) serializer runs, so
// `ommlToLatex` stays a sync cache lookup. In environments without the endpoint
// (e.g. `transvert` in plain node) the fetch fails and we transparently fall
// back to the JS conversion.

const texmathCache = new Map<string, string>();

function texmathEndpoint(): string {
  if (typeof process !== 'undefined' && process.env && process.env.TEXMATH_ENDPOINT) {
    return process.env.TEXMATH_ENDPOINT;
  }
  return '/api/texmath';
}

/**
 * Pre-convert a batch of OMML strings via /api/texmath and cache the results.
 * Best-effort: any failure (no endpoint, texmath error) leaves that entry
 * uncached so `ommlToLatex` falls back to the JS pipeline.
 */
export async function prefetchTexmath(ommlList: string[]): Promise<void> {
  const endpoint = texmathEndpoint();
  const uniq = [...new Set(ommlList)].filter((o) => o && !texmathCache.has(o));
  if (uniq.length === 0) return;
  const CONCURRENCY = 8;
  const queue = [...uniq];
  const worker = async () => {
    while (queue.length) {
      const omml = queue.shift();
      if (omml === undefined) return;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: omml, from: 'omml', to: 'tex', inline: true }),
        });
        if (res.ok) {
          const json = (await res.json()) as { result?: string };
          if (typeof json.result === 'string' && json.result.trim()) {
            texmathCache.set(omml, json.result.trim());
          }
        }
      } catch {
        // no endpoint / network error → leave uncached, JS fallback applies
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}

/**
 * Convert OMML XML string to LaTeX. Prefers a cached texmath result (filled by
 * {@link prefetchTexmath}); otherwise uses the in-browser omml2mathml +
 * mathml-to-latex pipeline.
 * Exported so textSerializer can render inline `m:oMath` runs (公式与正文混排)
 * without going through the standalone Math element path.
 */
export function ommlToLatex(ommlXml: string): string {
  const cached = texmathCache.get(ommlXml);
  if (cached !== undefined) return cached;
  return ommlToLatexJs(ommlXml);
}

function ommlToLatexJs(ommlXml: string): string {
  try {
    const normalized = normalizeOmmlXml(ommlXml);
    const parser = new DOMParser();
    const doc = parser.parseFromString(normalized, 'application/xml');
    const mathmlNode = omml2mathml(doc);
    if (!mathmlNode) return '';
    const mathmlStr: string = mathmlNode.outerHTML ?? mathmlNode.toString();
    const rawLatex = MathMLToLaTeX.convert(mathmlStr);
    return postProcessLatex(rawLatex);
  } catch (err) {
    console.warn('[mathSerializer] OMML→LaTeX conversion failed:', err);
    return '';
  }
}

/**
 * Resolve fallback image from the mc:Fallback branch blipFill embed.
 */
async function resolveFallbackImage(
  embed: string | undefined,
  ctx: RenderContext,
): Promise<string> {
  if (!embed) return '';
  const rel = ctx.slide.rels.get(embed);
  if (!rel) return '';
  const mediaPath = resolveMediaPath(rel.target);
  const data = ctx.presentation.media.get(mediaPath);
  if (!data) return '';
  return resolveMediaToUrl(mediaPath, data, ctx.mediaMode, ctx.mediaUrlCache);
}

/**
 * Resolve an embedded .docx package from the slide's rels + presentation embeddings.
 * Returns the word/document.xml content string, or null.
 */
async function resolveOleDocxContent(rId: string, ctx: RenderContext): Promise<string | null> {
  const rel = ctx.slide.rels.get(rId);
  if (!rel) return null;

  const fileName = rel.target.split('/').pop() || '';
  const embeddingPath = `ppt/embeddings/${fileName}`;
  const data = ctx.presentation.embeddings.get(embeddingPath);
  if (!data) return null;

  try {
    const zip = await JSZip.loadAsync(data);
    const docXml = await zip.file('word/document.xml')?.async('string');
    return docXml ?? null;
  } catch {
    return null;
  }
}

/**
 * Serialize a math node to a Math element.
 */
export async function mathToElement(
  node: MathNodeData,
  ctx: RenderContext,
  _order: number,
): Promise<MathElement> {
  const order = node.xmlOrder;
  const left = pxToPt(node.position.x);
  const top = pxToPt(node.position.y);
  const width = pxToPt(node.size.w);
  const height = pxToPt(node.size.h);

  let latex = '';
  let plainText = node.plainText || '';

  if (node.oleDocxRId) {
    // OLE Word.Document with EQ field math
    const docXml = await resolveOleDocxContent(node.oleDocxRId, ctx);
    if (docXml) {
      const content = parseDocxMathContent(docXml);
      latex = content.latex;
      plainText = content.plainText || plainText;
    }
  } else {
    // One OMML node per paragraph. Convert each to LaTeX; when a box holds
    // several (slide 29 输入框 4 行 / 推理框多行), stack them as multiple
    // display lines via KaTeX's `gathered` env so every line survives — the
    // old code only kept the first.
    const xmls =
      node.ommlXmls && node.ommlXmls.length > 0
        ? node.ommlXmls
        : node.ommlXml
          ? [node.ommlXml]
          : [];
    const lines = xmls
      .map(ommlToLatex)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 1) {
      latex = lines[0];
    } else if (lines.length > 1) {
      latex = `\\begin{gathered}${lines.join(' \\\\ ')}\\end{gathered}`;
    }
  }

  const picBase64 = await resolveFallbackImage(node.fallbackBlipEmbed, ctx);

  // OMML→LaTeX drops drawingML run color; when the whole formula is one color
  // (e.g. 蓝色权重), resolve it here so the renderer can apply it.
  const color =
    node.colorNode && node.colorNode.exists() ? resolveColorToCss(node.colorNode, ctx) : undefined;

  return {
    type: 'math',
    color,
    left,
    top,
    width,
    height,
    latex,
    picBase64,
    order,
    text: plainText || undefined,
  };
}
