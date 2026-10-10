/**
 * Inline formulas in prose HTML, stored as LaTeX source only.
 *
 * The slide text editor emits an inline formula as a rendered KaTeX tree
 * (`<span class="katex" data-inline-math="LATEX">`, with hidden MathML, layout
 * SVG and positioned spans) inside the prose HTML. The prose policy cannot
 * allow that markup without allowing far more than prose needs, and the
 * server does not render math, so a stored formula is reduced to its source:
 *
 *   <span data-inline-math="LATEX">LATEX</span>
 *
 * The source doubles as the span's text so consumers that do not render math
 * (summaries, PPTX text, plain-text views) still show the LaTeX. Clients that
 * display slides render the formula from the attribute with KaTeX; the editor
 * parses the span back into its inline-math node.
 *
 * `liftInlineMath` runs before the prose policy and replaces each formula
 * subtree with that source-only span. It uses the same streaming parser as
 * `sanitize-html` (htmlparser2), so it is linear in the input and sees the
 * same element boundaries the sanitizer will. It is capture, not a security
 * boundary: its output still goes through the sanitizer, which only lets
 * `data-inline-math` through on `span`.
 */
import { Parser } from 'htmlparser2';

export const INLINE_MATH_ATTRIBUTE = 'data-inline-math';

/**
 * Cheap pre-check: a formula is a `data-inline-math` attribute or a KaTeX
 * root with an `<annotation>` element. Element and attribute names cannot be
 * written as character references (unlike the `katex` class value), so prose
 * without either word holds no formula. Case-insensitive because the parser
 * lowercases names.
 */
const MAY_CONTAIN_INLINE_MATH = /data-inline-math|annotation/i;

const TEX_ENCODING = 'application/x-tex';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The stored form of one formula. */
function storedFormula(latex: string): string {
  // Any length is kept as a formula. Typesetting is bounded where it happens
  // (`MAX_INLINE_MATH_SOURCE` in @openmaic/renderer, shared by the editor):
  // a longer source is shown as its LaTeX text there, and the stored form
  // keeps the marker so the formula is never lost.
  const escaped = escapeHtml(latex);
  return `<span ${INLINE_MATH_ATTRIBUTE}="${escaped}">${escaped}</span>`;
}

interface OpenFormula {
  /** Offset of the formula's opening `<`. */
  readonly start: number;
  /** Offset of the `>` that ends its opening tag. */
  readonly openEnd: number;
  /** Element depth of the formula element. */
  readonly depth: number;
  /** Known source (`data-inline-math`), or the TeX annotation once seen. */
  source: string | null;
  /** True for `span[data-inline-math]`: its contents never matter. */
  readonly fromAttribute: boolean;
}

interface Replacement {
  readonly start: number;
  /** Offset of the formula's last character (inclusive). */
  readonly end: number;
  readonly source: string;
}

/**
 * Replace every inline formula with its source-only span. Mirrors the
 * editor's parse rules: `span[data-inline-math]`, else a `span.katex` with a
 * non-empty TeX annotation. Returns `null` when the prose holds no formula, so
 * the caller can sanitize the original string unchanged.
 */
export function liftInlineMath(html: string): string | null {
  if (!MAY_CONTAIN_INLINE_MATH.test(html)) return null;

  const replacements: Replacement[] = [];
  const open: OpenFormula[] = [];
  let depth = 0;
  let ending = false;
  /** Depth of the TeX annotation being read, or -1. */
  let annotationDepth = -1;
  let annotationText = '';

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        depth += 1;
        const top = open[open.length - 1];
        // Inside a formula known from its attribute nothing else matters.
        if (top?.fromAttribute) return;
        if (name === 'span') {
          const source = attribs[INLINE_MATH_ATTRIBUTE];
          if (source !== undefined) {
            open.push({
              start: parser.startIndex,
              openEnd: parser.endIndex,
              depth,
              source,
              fromAttribute: true,
            });
            return;
          }
          if ((attribs.class ?? '').split(/[\t\n\f\r ]+/).includes('katex')) {
            open.push({
              start: parser.startIndex,
              openEnd: parser.endIndex,
              depth,
              source: null,
              fromAttribute: false,
            });
            return;
          }
        }
        if (
          name === 'annotation' &&
          top &&
          top.source === null &&
          annotationDepth < 0 &&
          attribs.encoding === TEX_ENCODING
        ) {
          annotationDepth = depth;
          annotationText = '';
        }
      },
      ontext(text) {
        if (annotationDepth >= 0) annotationText += text;
      },
      onclosetag(_name, isImplied) {
        if (depth === annotationDepth) {
          const top = open[open.length - 1];
          if (top && top.source === null && annotationText) top.source = annotationText;
          annotationDepth = -1;
        }
        const top = open[open.length - 1];
        if (top && top.depth === depth) {
          open.pop();
          if (top.source !== null) {
            // An explicit close ends at its `>`; an implied one just before
            // the token that closed it (or at the end of the input). A
            // self-closing tag in SVG/MathML is also reported as implied,
            // while still on its own token: it ends with that token.
            const end = Math.max(
              top.openEnd,
              ending ? html.length - 1 : isImplied ? parser.startIndex - 1 : parser.endIndex,
            );
            // Formulas nested inside this one are covered by it.
            while (replacements.length && replacements[replacements.length - 1].start > top.start) {
              replacements.pop();
            }
            replacements.push({ start: top.start, end, source: top.source });
          }
        }
        depth -= 1;
      },
    },
    // The options `sanitize-html` parses with, so element boundaries match.
    { decodeEntities: true },
  );
  parser.write(html);
  ending = true;
  parser.end();

  if (!replacements.length) return null;
  let out = '';
  let cursor = 0;
  for (const { start, end, source } of replacements) {
    out += html.slice(cursor, start) + storedFormula(source);
    cursor = end + 1;
  }
  return out + html.slice(cursor);
}
