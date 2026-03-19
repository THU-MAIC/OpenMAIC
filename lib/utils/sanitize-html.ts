/**
 * Lightweight HTML sanitizer for LLM-generated slide/whiteboard content.
 *
 * Strips all tags except a strict allowlist and removes dangerous
 * attributes (event handlers, javascript: URIs, data: URIs in non-image
 * contexts). No external dependency required.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'sub',
  'sup',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'a',
  'div',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'colgroup',
  'col',
  'blockquote',
  'pre',
  'code',
  'hr',
  'img',
]);

const ALLOWED_ATTRS = new Set([
  'style',
  'class',
  'id',
  'href',
  'target',
  'rel',
  'src',
  'alt',
  'width',
  'height',
  'colspan',
  'rowspan',
  'align',
  'valign',
]);

const EVENT_ATTR_RE = /^on/i;
const DANGEROUS_URI_RE = /^\s*(javascript|vbscript|data):/i;

/**
 * Sanitize an HTML string by stripping disallowed tags and attributes.
 *
 * Uses regex-based rewriting which is sufficient for the ProseMirror-subset
 * HTML that the generation pipeline produces. For arbitrary internet HTML
 * a DOM-based sanitizer (DOMPurify) would be needed, but that dependency
 * is unnecessary here because the input is always server-generated.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return '';

  // Strip <script>, <style>, <iframe>, <object>, <embed>, <form>, <input>,
  // <textarea>, <select>, <button>, <link>, <meta>, <base>, <svg> blocks entirely
  let result = html.replace(
    /<(script|style|iframe|object|embed|form|input|textarea|select|button|link|meta|base|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  );
  // Also strip self-closing / void variants of the same tags
  result = result.replace(
    /<(script|style|iframe|object|embed|form|input|textarea|select|button|link|meta|base|svg)\b[^>]*\/?>/gi,
    '',
  );

  // Process remaining tags: keep allowed ones but strip dangerous attributes
  result = result.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tag, attrsStr) => {
    const tagLower = tag.toLowerCase();

    // Strip disallowed tags entirely (keep their text content)
    if (!ALLOWED_TAGS.has(tagLower)) {
      return '';
    }

    // Closing tag — no attributes to worry about
    if (match.startsWith('</')) {
      return `</${tagLower}>`;
    }

    // Filter attributes
    const cleanAttrs = sanitizeAttributes(attrsStr, tagLower);
    const selfClose = match.trimEnd().endsWith('/>') ? ' /' : '';
    return `<${tagLower}${cleanAttrs}${selfClose}>`;
  });

  return result;
}

function sanitizeAttributes(attrsStr: string, tag: string): string {
  if (!attrsStr || !attrsStr.trim()) return '';

  const attrs: string[] = [];
  // Match attribute = "value" | 'value' | bare-value patterns
  const attrRe = /([a-zA-Z_][\w-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;

  while ((m = attrRe.exec(attrsStr)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';

    if (EVENT_ATTR_RE.test(name)) continue;
    if (!ALLOWED_ATTRS.has(name)) continue;

    if ((name === 'href' || name === 'src') && DANGEROUS_URI_RE.test(value)) {
      // Allow data: URIs only for <img> src (base64 images from PDF extraction)
      if (!(tag === 'img' && name === 'src' && value.trimStart().startsWith('data:image/'))) {
        continue;
      }
    }

    attrs.push(` ${name}="${escapeAttrValue(value)}"`);
  }

  return attrs.join('');
}

function escapeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Escape a plain-text string for safe insertion as innerHTML.
 * Converts special characters to HTML entities.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
