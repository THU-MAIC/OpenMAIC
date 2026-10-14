/**
 * Slide prose helpers for the PPTX export.
 *
 * An inline formula reaches the export in one of two shapes: the stored form
 * `<span data-inline-math="LATEX">LATEX</span>` (see `lib/sanitize/inline-math`)
 * or, for content not yet saved, the editor's rendered KaTeX tree carrying the
 * same attribute (or, from a PPTX import, only a TeX annotation). Either way
 * the export writes the formula as its LaTeX source in one run: walking a
 * KaTeX tree's text would emit the MathML text, the annotation and every
 * layout glyph one after another ("E=mc2E=mc^2E=mc2").
 */
import { type AST, toAST } from '@/lib/export/html-parser';

const INLINE_MATH_ATTRIBUTE = 'data-inline-math';
const TEX_ENCODING = 'application/x-tex';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode the character references sanitizers and serializers emit. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      return code === 0xa0 ? ' ' : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function attribute(item: AST, key: string): string | null {
  if (item.type !== 'element') return null;
  return item.attributes.find((attr) => attr.key === key)?.value ?? null;
}

function textOf(items: AST[]): string {
  return items
    .map((item) =>
      item.type === 'text' ? item.content : item.type === 'element' ? textOf(item.children) : '',
    )
    .join('');
}

function findTexAnnotation(items: AST[]): string | null {
  for (const item of items) {
    if (item.type !== 'element') continue;
    if (item.tagName === 'annotation' && attribute(item, 'encoding') === TEX_ENCODING) {
      return textOf(item.children);
    }
    const nested = findTexAnnotation(item.children);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * The LaTeX source when `item` is an inline formula, else `null`. Follows the
 * editor's parse rules: `span[data-inline-math]`, else a `span.katex` with a
 * non-empty TeX annotation.
 */
export function inlineMathSource(item: AST): string | null {
  if (item.type !== 'element' || item.tagName !== 'span') return null;
  const source = attribute(item, INLINE_MATH_ATTRIBUTE);
  if (source !== null) return decodeHtmlEntities(source);
  const classes = (attribute(item, 'class') ?? '').split(/\s+/);
  if (!classes.includes('katex')) return null;
  const annotation = findTexAnnotation(item.children);
  return annotation ? decodeHtmlEntities(annotation) : null;
}

const BLOCK_TAGS = new Set(['p', 'div', 'li']);

/** A tag or comment; a bare `<` or `&` in plain text is not markup. */
const MARKUP = /<\/?[a-z][^>]*>|<!--/i;

/**
 * Plain text of a table cell for the PPTX table, which takes one string per
 * cell. Cell text is stored as prose HTML: tags are dropped, character
 * references decoded, and inline formulas become their LaTeX source. Lines
 * follow what the slide renderer shows: a newline in the text (the renderer
 * turns it into a line break), a `<br>`, and each paragraph, empty ones
 * included, start a new line. Text without markup only has its character
 * references decoded.
 */
export function proseToPlainText(html: string): string {
  if (!MARKUP.test(html)) return html.includes('&') ? decodeHtmlEntities(html) : html;
  const lines: string[] = [];
  let line = '';
  const breakLine = () => {
    lines.push(line);
    line = '';
  };
  const walk = (items: AST[]) => {
    for (const item of items) {
      if (item.type === 'text') {
        const [first, ...rest] = decodeHtmlEntities(item.content).split('\n');
        line += first;
        for (const next of rest) {
          breakLine();
          line += next;
        }
        continue;
      }
      if (item.type !== 'element') continue;
      if (item.tagName === 'br') {
        breakLine();
        continue;
      }
      const source = inlineMathSource(item);
      if (source !== null) {
        line += source;
        continue;
      }
      if (!BLOCK_TAGS.has(item.tagName)) {
        walk(item.children);
        continue;
      }
      if (line) breakLine();
      const linesBefore = lines.length;
      walk(item.children);
      // End the paragraph. One that produced nothing is an empty line; one
      // that already ended on a break (a trailing <br>, a nested block) adds
      // no further line.
      if (line) breakLine();
      else if (lines.length === linesBefore) lines.push('');
    }
  };
  walk(toAST(html));
  if (line) lines.push(line);
  return lines.join('\n');
}
