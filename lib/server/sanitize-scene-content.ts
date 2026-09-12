/**
 * Scene-content HTML sanitization for the classroom persistence boundary.
 *
 * INVARIANT: stored slide HTML is restricted to the formatting vocabulary the
 * renderer produces. Slide element content is authored as ProseMirror HTML and
 * is later injected into the DOM verbatim (`dangerouslySetInnerHTML` on the
 * `ProseMirror-static` containers), so anything allowed through here must be
 * exactly the set of tags / classes / inline styles the editor schemas and the
 * KaTeX renderer emit — nothing more. Everything executable (script tags,
 * event-handler attributes, `javascript:` URLs, embedded-object tags) is
 * outside that vocabulary and is removed here, once, at the boundary where
 * classroom content enters or leaves storage, instead of at each render sink.
 *
 * The allowlists below were derived empirically:
 *   - the ProseMirror schemas in `lib/prosemirror/schema` and in
 *     `@openmaic/editor`'s text schema (marks/nodes → their `toDOM` output),
 *   - the renderer text/shape/table element components,
 *   - real stage/scene fixtures in `eval/`, `tests/` and the
 *     `@openmaic/editor` round-trip tests,
 *   - actual KaTeX HTML snapshots rendered with the repo's `katex`.
 *
 * LaTeX elements persist a `html` snapshot produced by
 * `katex.renderToString(..., { output: 'html' })` (see
 * `lib/edit/slide-edit-elements.ts`); that output is spans + layout SVGs and
 * needs its own policy so formulas are not flattened.
 */
import sanitizeHtml, { type IOptions } from 'sanitize-html';

// ---------------------------------------------------------------------------
// Allowlist primitives
// ---------------------------------------------------------------------------

/**
 * Inline styles are kept by *property* (colors, sizes, font families,
 * alignment, indentation, list markers, …) rather than wholesale. Values are
 * constrained to plain CSS tokens: no `url(...)`, no `expression(...)`, no
 * `@`-rules, no CSS-embedded script schemes. The individual properties a
 * renderer may emit are enumerated below — a property not in the list is
 * dropped, so a stray `background: url(...)` or `behavior: url(...)` cannot
 * ride in through the `style` attribute.
 */
const SAFE_CSS_VALUE =
  /^(?!.*(?:url\s*\(|expression\s*\(|@|behavior\s*:|-moz-binding\s*:|vbscript:|javascript:))[^<>{};]{0,240}$/i;

/**
 * Every CSS property the ProseMirror schemas, the PPTX text importer and the
 * KaTeX HTML snapshot emit inline. KaTeX additionally lays out spans with
 * `position`/`top`/`left`/`bottom`/`right`; prose content never does, so those
 * stay out of the prose policy.
 */
const STYLE_PROPERTIES = [
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'text-align',
  'text-indent',
  'text-decoration',
  'text-decoration-line',
  'text-decoration-style',
  'text-transform',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'vertical-align',
  'display',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'white-space',
  'box-sizing',
  'list-style-type',
  'word-break',
  'word-wrap',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-style',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
] as const;

/** Positioning geometry: used only by KaTeX layout spans, never by prose. */
const LAYOUT_STYLE_PROPERTIES = ['top', 'bottom', 'left', 'right', 'position'] as const;

const LATEX_STYLE_PROPERTIES: readonly string[] = [...STYLE_PROPERTIES, ...LAYOUT_STYLE_PROPERTIES];

function styleRules(properties: readonly string[]): Record<string, RegExp[]> {
  const rules: Record<string, RegExp[]> = {};
  for (const property of properties) {
    rules[property] = [SAFE_CSS_VALUE];
  }
  return rules;
}

/** `allowedStyles` shape: per-tag style maps; `'*'` applies the rules to every tag. */
function allowedStylesByTag(
  properties: readonly string[],
): Record<string, Record<string, RegExp[]>> {
  return { '*': styleRules(properties) };
}

// ---------------------------------------------------------------------------
// Prose policy — text elements, shape text and table cell text
// ---------------------------------------------------------------------------

/**
 * HTML vocabulary of text-element content (ProseMirror serialized HTML plus
 * the legacy/imported constructs the renderer still understands).
 */
export const PROSE_ALLOWED_TAGS = [
  'p',
  'br',
  'div',
  'blockquote',
  'ol',
  'ul',
  'li',
  'a',
  'span',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'strike',
  'sub',
  'sup',
  'code',
  'mark',
  // Structural table tags: keep legacy cell markup that a stored cell/body may
  // still carry so a nested table renders instead of being flattened.
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
] as const;

const PROSE_ATTRIBUTES: Record<string, string[]> = {
  '*': ['class', 'style'],
  a: ['href', 'title', 'target', 'rel', 'name'],
  p: ['align', 'data-indent'],
  ol: ['start'],
  mark: ['data-index'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
};

const PROSE_OPTIONS: IOptions = {
  allowedTags: [...PROSE_ALLOWED_TAGS],
  allowedAttributes: PROSE_ATTRIBUTES,
  allowedStyles: allowedStylesByTag(STYLE_PROPERTIES),
};

/**
 * Sanitize one prose-HTML string (a text element's `content`, a shape's
 * `text.content`, or a table cell's `text`).
 */
export function sanitizeProseHtml(html: string): string {
  return sanitizeHtml(html, PROSE_OPTIONS);
}

// ---------------------------------------------------------------------------
// LaTeX policy — KaTeX-rendered `html` snapshots on latex elements
// ---------------------------------------------------------------------------

/**
 * KaTeX `output: 'html'` emits nested `<span class="…" style="…">` nodes plus
 * layout `<svg>/<path>/<line>` fragments (radicals, stretchy delimiters,
 * cancel rules). Keep exactly that vocabulary; classes and presentation
 * attributes are inert, so handlers/scripts cannot ride in through them.
 *
 * sanitize-html lowercases attribute names, and KaTeX's layout SVG relies on
 * the camelCase `viewBox` / `preserveAspectRatio` attributes, so after
 * sanitization those two names are restored to their authored case (the only
 * place they can appear is a layout SVG, where they are inert geometry).
 */
const LATEX_ALLOWED_TAGS = ['span', 'svg', 'path', 'line'] as const;

const LATEX_ATTRIBUTES: Record<string, string[]> = {
  '*': ['class', 'style'],
  span: ['aria-hidden'],
  svg: ['xmlns', 'width', 'height', 'viewbox', 'preserveaspectratio', 'aria-hidden'],
  path: ['d'],
  line: ['x1', 'y1', 'x2', 'y2', 'stroke-width'],
};

const LATEX_OPTIONS: IOptions = {
  allowedTags: [...LATEX_ALLOWED_TAGS],
  allowedAttributes: LATEX_ATTRIBUTES,
  allowedStyles: allowedStylesByTag(LATEX_STYLE_PROPERTIES),
};

/**
 * Sanitize the KaTeX HTML snapshot stored on a latex element. This strips
 * anything the renderer could not have produced (scripts, event handlers,
 * embedded frames) while keeping the spans / layout SVG that make a formula
 * render.
 */
export function sanitizeLatexHtml(html: string): string {
  return sanitizeHtml(html, LATEX_OPTIONS)
    .replace(/viewbox=/g, 'viewBox=')
    .replace(/preserveaspectratio=/g, 'preserveAspectRatio=');
}

// ---------------------------------------------------------------------------
// Payload walker — sanitize every HTML-bearing string in a stage/scene payload
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeCell(row: unknown): unknown {
  if (!Array.isArray(row)) return row;
  return row.map((cell) => {
    if (!isRecord(cell) || typeof cell.text !== 'string') return cell;
    return { ...cell, text: sanitizeProseHtml(cell.text) };
  });
}

/**
 * Apply the prose/LaTeX policies to the HTML-bearing fields of one slide
 * element object (by its DSL `type` discriminant), then recurse into the
 * remaining fields. Text, shape and table cells use the prose vocabulary;
 * latex uses the KaTeX snapshot policy. Code elements store plain text lines —
 * deliberately NOT treated as HTML, so code like `a < b` is never escaped.
 */
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!isRecord(value)) return value;

  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = sanitizeValue(child);
  }

  if (typeof out.type !== 'string') return out;

  if (out.type === 'text' && typeof out.content === 'string') {
    out.content = sanitizeProseHtml(out.content);
  } else if (out.type === 'shape') {
    if (isRecord(out.text) && typeof out.text.content === 'string') {
      out.text = { ...out.text, content: sanitizeProseHtml(out.text.content) };
    }
  } else if (out.type === 'table' && Array.isArray(out.data)) {
    out.data = out.data.map(sanitizeCell);
  } else if (out.type === 'latex' && typeof out.html === 'string') {
    out.html = sanitizeLatexHtml(out.html);
  }

  return out;
}

/**
 * Return a copy of a classroom stage/scene payload with every HTML-bearing
 * string sanitized to the renderer's formatting vocabulary. Safe to run twice
 * (idempotent): the read path applies it over content stored before this
 * change existed, and the write path applies it to new payloads.
 */
export function sanitizeSceneContent<T>(payload: T): T {
  return sanitizeValue(payload) as T;
}
