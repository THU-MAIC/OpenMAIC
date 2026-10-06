/**
 * Slide rich text for the standalone HTML export: sanitized with the
 * persistence policy, without losing what that policy cannot express.
 *
 * - Inline formulas. The editor stores an inline formula as rendered KaTeX
 *   (`<span class="katex" data-inline-math="…">`, with SVG and positioned
 *   spans) inside prose HTML, which the prose policy would flatten. Each
 *   formula's LaTeX source is lifted out before sanitizing (from
 *   `data-inline-math`, else KaTeX's `application/x-tex` annotation) and a
 *   fresh KaTeX render is put back afterwards, so the embedded markup is
 *   generated from the source rather than taken from the document.
 * - Resources the policy drops. Images and CSS `url(...)` values in rich text
 *   cannot be shown offline once removed; they are inventoried first and
 *   reported as unresolved media instead of vanishing silently.
 */
import katex from 'katex';
import { parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { sanitizeSceneContent } from '@/lib/sanitize/scene-content';
import type { SlideContent } from '@/lib/types/stage';

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

/** Only markup carrying one of these needs the parse below; anything else goes straight through. */
const NEEDS_PARSE = /katex|data-inline-math|<img|<style|url\s*\(/i;
const CSS_URL = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

function isElement(node: ChildNode): node is Element {
  return !node.nodeName.startsWith('#');
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

function textOf(node: ChildNode): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  return 'childNodes' in node ? node.childNodes.map(textOf).join('') : '';
}

function findTexAnnotation(element: Element): string | undefined {
  for (const child of element.childNodes) {
    if (!isElement(child)) continue;
    if (child.tagName === 'annotation' && attr(child, 'encoding') === 'application/x-tex') {
      return textOf(child);
    }
    const nested = findTexAnnotation(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** The LaTeX source of an inline-formula element, or `undefined` for anything else. */
function inlineMathSource(element: Element): string | undefined {
  const source = attr(element, 'data-inline-math');
  if (source !== undefined) return source;
  const classes = (attr(element, 'class') ?? '').split(/\s+/);
  return classes.includes('katex') ? findTexAnnotation(element) : undefined;
}

function cssUrls(css: string): string[] {
  return [...css.matchAll(CSS_URL)].map((match) => match[2].trim()).filter(Boolean);
}

/** A report-friendly name for a discarded resource; data URIs are shortened. */
function resourceLabel(url: string): string {
  return /^data:/i.test(url) ? `${url.slice(0, url.indexOf(',') + 1 || 48)}…` : url;
}

interface RichTextScan {
  /** LaTeX source per formula, indexed by placeholder number. */
  formulas: string[];
  /** Resources the sanitizer will drop. */
  discarded: string[];
  marker: (index: number) => string;
}

function walk(parent: ParentNode, scan: RichTextScan) {
  parent.childNodes = parent.childNodes.map((node) => {
    if (!isElement(node)) return node;
    const latex = inlineMathSource(node);
    if (latex !== undefined) {
      scan.formulas.push(latex);
      const text: DefaultTreeAdapterTypes.TextNode = {
        nodeName: '#text',
        value: scan.marker(scan.formulas.length - 1),
        parentNode: parent,
      };
      return text;
    }
    if (node.tagName === 'img') {
      const src = attr(node, 'src')?.trim();
      if (src) scan.discarded.push(resourceLabel(src));
    }
    const style = attr(node, 'style');
    if (style) scan.discarded.push(...cssUrls(style).map(resourceLabel));
    if (node.tagName === 'style') scan.discarded.push(...cssUrls(textOf(node)).map(resourceLabel));
    walk(node, scan);
    return node;
  });
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** A fresh, inert KaTeX render of one inline formula, as the editor would store it. */
function renderInlineMath(latex: string): string {
  if (!latex.trim()) return '';
  try {
    const html = katex.renderToString(latex, {
      displayMode: false,
      output: 'html',
      throwOnError: false,
      trust: false,
    });
    return html.replace(
      /^<span class="katex"/,
      `<span class="katex" data-inline-math="${escapeAttribute(latex)}"`,
    );
  } catch {
    return escapeAttribute(latex);
  }
}

/**
 * Lift inline formulas out of one prose string (replacing each with a text
 * marker) and inventory the resources it will lose. Markup that needs no
 * parsing, or holds no formula, is returned unchanged.
 */
function protect(html: string, scan: RichTextScan): string {
  if (!NEEDS_PARSE.test(html)) return html;
  const before = scan.formulas.length;
  const fragment = parseFragment(html);
  walk(fragment, scan);
  return scan.formulas.length > before ? serialize(fragment) : html;
}

/**
 * Sanitize a slide's rich text for the player document. Returns the
 * sanitized content and the resources the sanitizer had to drop.
 */
export function sanitizeSlideRichText(content: SlideContent): {
  content: SlideContent;
  discarded: string[];
} {
  // One marker family for the whole slide, chosen so it cannot collide with
  // authored text; markers are plain text, which the sanitizer keeps.
  let nonce = 0;
  const source = JSON.stringify(content.canvas);
  while (source.includes(`openmaicmath${nonce}x`)) nonce += 1;
  const scan: RichTextScan = {
    formulas: [],
    discarded: [],
    marker: (index) => `openmaicmath${nonce}x${index}x`,
  };
  const guard = (html: string) => protect(html, scan);
  const pattern = new RegExp(`openmaicmath${nonce}x(\\d+)x`, 'g');
  const restore = (html: string) =>
    scan.formulas.length === 0
      ? html
      : html.replace(pattern, (_, index: string) =>
          renderInlineMath(scan.formulas[Number(index)] ?? ''),
        );
  const elements = content.canvas.elements ?? [];

  // Pass 1: protect formulas in every prose field the sanitizer rewrites.
  const guarded = elements.map((element) => {
    if (element.type === 'text' && typeof element.content === 'string') {
      return { ...element, content: guard(element.content) };
    }
    if (element.type === 'shape' && typeof element.text?.content === 'string') {
      return { ...element, text: { ...element.text, content: guard(element.text.content) } };
    }
    if (element.type === 'table' && Array.isArray(element.data)) {
      return {
        ...element,
        data: element.data.map((row) =>
          Array.isArray(row)
            ? row.map((cell) =>
                typeof cell?.text === 'string' ? { ...cell, text: guard(cell.text) } : cell,
              )
            : row,
        ),
      };
    }
    return element;
  });

  // Pass 2: sanitize with the persistence policy.
  const sanitized = sanitizeSceneContent<SlideContent>({
    ...content,
    canvas: { ...content.canvas, elements: guarded },
  });

  // Pass 3: put fresh renders back where the markers survived.
  const restored = (sanitized.canvas.elements ?? []).map((element) => {
    if (element.type === 'text' && typeof element.content === 'string') {
      return { ...element, content: restore(element.content) };
    }
    if (element.type === 'shape' && typeof element.text?.content === 'string') {
      return { ...element, text: { ...element.text, content: restore(element.text.content) } };
    }
    if (element.type === 'table' && Array.isArray(element.data)) {
      return {
        ...element,
        data: element.data.map((row) =>
          Array.isArray(row)
            ? row.map((cell) =>
                typeof cell?.text === 'string' ? { ...cell, text: restore(cell.text) } : cell,
              )
            : row,
        ),
      };
    }
    return element;
  });

  return {
    content: { ...sanitized, canvas: { ...sanitized.canvas, elements: restored } },
    discarded: scan.discarded,
  };
}
