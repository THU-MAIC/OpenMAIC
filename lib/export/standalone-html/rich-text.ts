/**
 * Slide rich text for the standalone HTML export: sanitized with the
 * persistence policy, without losing what that policy cannot express.
 *
 * - Inline formulas. The editor stores an inline formula as rendered KaTeX
 *   (`<span class="katex" data-inline-math="…">`, with SVG and positioned
 *   spans) inside prose HTML, which the prose policy would flatten. Each
 *   formula element is replaced by an empty `<span data-inline-math>` carrying
 *   only its LaTeX source, the result is sanitized (with that one attribute
 *   allowed), and the sanitized spans are then filled with a fresh KaTeX
 *   render of the source read back from the sanitized DOM. KaTeX's generated
 *   markup is the only markup added after sanitizing; nothing authored is
 *   ever re-inserted, and no authored text is spliced into strings.
 * - Resources the policy drops. Images (`src`, `srcset`, posters) and CSS
 *   `url(...)` / `image-set(...)` / `@import` references cannot be shown
 *   offline once removed; they are inventoried over the whole authored tree
 *   first, formula subtrees included, and reported as unresolved media.
 *
 * Runs where a DOM is available (the browser export; jsdom in tests).
 */
import katex from 'katex';
import { safeKatexOptions } from '@openmaic/dsl';
import parseSrcset from 'parse-srcset';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { sanitizeSceneContent } from '@/lib/sanitize/scene-content';
import type { SlideContent } from '@/lib/types/stage';

const INLINE_MATH_ATTRIBUTE = 'data-inline-math';

/** Element attributes that load a resource, per tag. */
const RESOURCE_ATTRIBUTES: Record<string, readonly string[]> = {
  img: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  source: ['src'],
  track: ['src'],
  embed: ['src'],
  iframe: ['src'],
  object: ['data'],
  input: ['src'],
  image: ['href', 'xlink:href'],
};
const SRCSET_TAGS = new Set(['img', 'source']);

/**
 * Decode CSS escapes (`\72`, `\(`) so an escaped `url` or URL is recognized.
 * Follows CSS Syntax: a hex escape is 1-6 digits plus one optional whitespace
 * (CRLF counts as one); zero, surrogates and values above U+10FFFF become
 * U+FFFD; an escaped newline is a line continuation and decodes to nothing.
 */
function decodeCssEscapes(value: string): string {
  return value.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S])|$)/g,
    (_, hex: string | undefined, newline: string | undefined, char: string | undefined) => {
      if (hex) {
        const code = Number.parseInt(hex, 16);
        const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
        return String.fromCodePoint(valid ? code : 0xfffd);
      }
      if (newline) return '';
      return char ?? '';
    },
  );
}

/** Resource URLs referenced by one CSS value (comments ignored, strings respected). */
function cssValueResources(value: string): string[] {
  const found: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type !== 'function') return;
    const name = decodeCssEscapes(node.value).toLowerCase();
    if (name === 'url') {
      // A quoted URL is one string node; an unquoted one is raw text, which the
      // parser only keeps whole for a literal `url(`, so take its source.
      const [first] = node.nodes;
      const raw =
        node.nodes.length === 1 && first.type === 'string'
          ? first.value
          : valueParser.stringify(node.nodes);
      found.push(decodeCssEscapes(raw).trim());
      return false;
    } else if (name === 'image-set' || name === '-webkit-image-set') {
      for (const child of node.nodes) {
        if (child.type === 'string') found.push(decodeCssEscapes(child.value).trim());
      }
    }
  });
  return found.filter(Boolean);
}

/** Resource URLs referenced by a style sheet: declarations and `@import`. */
function styleSheetResources(css: string): string[] {
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    // Unparseable as a sheet: still scan it as one value list.
    return cssValueResources(css);
  }
  const found: string[] = [];
  root.walkDecls((declaration) => {
    found.push(...cssValueResources(declaration.value));
  });
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() !== 'import') return;
    const [first] = valueParser(rule.params).nodes;
    if (first?.type === 'string') found.push(decodeCssEscapes(first.value).trim());
    else found.push(...cssValueResources(rule.params));
  });
  return found.filter(Boolean);
}

/** A report-friendly name for a discarded resource; data URIs are shortened. */
function resourceLabel(url: string): string {
  if (!/^data:/i.test(url)) return url;
  const comma = url.indexOf(',');
  return `${url.slice(0, comma >= 0 ? comma + 1 : 48)}…`;
}

/**
 * The fragment and the contents of every `<template>` inside it, nested ones
 * included: template contents live in their own fragments, which
 * `querySelectorAll` does not descend into, yet serialize back into the HTML.
 */
function fragmentsOf(root: DocumentFragment): DocumentFragment[] {
  const fragments = [root];
  for (let index = 0; index < fragments.length; index += 1) {
    for (const element of fragments[index].querySelectorAll('template')) {
      fragments.push((element as HTMLTemplateElement).content);
    }
  }
  return fragments;
}

/** The resources one element references. */
function elementResources(element: Element): string[] {
  const found: string[] = [];
  const tag = element.localName;
  for (const name of RESOURCE_ATTRIBUTES[tag] ?? []) {
    const value = element.getAttribute(name)?.trim();
    if (value) found.push(value);
  }
  if (SRCSET_TAGS.has(tag)) {
    const srcset = element.getAttribute('srcset');
    if (srcset) found.push(...parseSrcset(srcset).map((candidate) => candidate.url));
  }
  const style = element.getAttribute('style');
  if (style) found.push(...cssValueResources(style));
  if (tag === 'style') found.push(...styleSheetResources(element.textContent ?? ''));
  return found;
}

/**
 * Every resource the authored tree references, formula subtrees and template
 * contents included.
 *
 * Best-effort, for reporting only: the result only feeds the partial-export
 * warning. Every such resource is removed by the sanitizer and blocked by the
 * file's CSP whether or not it is found here, so exotic CSS spellings this
 * scan misses are under-reported, never shipped. For the same reason it is
 * fail-safe: an element that cannot be scanned is skipped, and nothing here
 * can abort or change the export.
 */
function inventoryResources(root: DocumentFragment): string[] {
  const found: string[] = [];
  try {
    for (const fragment of fragmentsOf(root)) {
      for (const element of fragment.querySelectorAll('*')) {
        try {
          found.push(...elementResources(element));
        } catch {
          // Skip what cannot be scanned; reporting only.
        }
      }
    }
  } catch {
    // Reporting only: keep whatever was found.
  }
  return found.map(resourceLabel);
}

/** The LaTeX source of an inline-formula element, or `null` for anything else. */
function inlineMathSource(element: Element): string | null {
  const source = element.getAttribute(INLINE_MATH_ATTRIBUTE);
  if (source !== null) return source;
  if (!element.classList.contains('katex')) return null;
  const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
  return annotation ? (annotation.textContent ?? '') : null;
}

function parseFragment(doc: Document, html: string): HTMLTemplateElement {
  // A template parses in place: leading <style>/<meta> stay in the fragment.
  const template = doc.createElement('template');
  template.innerHTML = html;
  return template;
}

/**
 * Pre-sanitize pass for one prose string: inventory resources, then replace
 * every formula element with an empty source-only span.
 */
function stripFormulas(doc: Document, html: string): { html: string; discarded: string[] } {
  // Without markup there is no element to inventory or replace.
  if (!html.includes('<')) return { html, discarded: [] };
  const template = parseFragment(doc, html);
  const fragment = template.content;
  const discarded = inventoryResources(fragment);
  // Formulas inside template contents too: the sanitizer drops the template
  // tag but keeps its permitted children.
  for (const root of fragmentsOf(fragment)) {
    for (const element of root.querySelectorAll(`[${INLINE_MATH_ATTRIBUTE}], .katex`)) {
      // Skip descendants of a formula already replaced.
      if (!root.contains(element)) continue;
      const latex = inlineMathSource(element);
      if (latex === null) continue;
      const placeholder = doc.createElement('span');
      placeholder.setAttribute(INLINE_MATH_ATTRIBUTE, latex);
      element.replaceWith(placeholder);
    }
  }
  return { html: template.innerHTML, discarded };
}

/** A fresh, inert KaTeX render of one inline formula, as an element. */
function renderFormula(doc: Document, latex: string): Element | null {
  if (!latex.trim()) return null;
  const host = doc.createElement('template');
  host.innerHTML = katex.renderToString(
    latex,
    safeKatexOptions({
      displayMode: false,
      output: 'html',
      throwOnError: false,
    }),
  );
  return host.content.firstElementChild;
}

/** Post-sanitize pass: fill each source-only span with a generated render. */
function renderFormulas(doc: Document, html: string): string {
  if (!html.includes(INLINE_MATH_ATTRIBUTE)) return html;
  const template = parseFragment(doc, html);
  for (const span of template.content.querySelectorAll(`span[${INLINE_MATH_ATTRIBUTE}]`)) {
    const latex = span.getAttribute(INLINE_MATH_ATTRIBUTE) ?? '';
    const formula = renderFormula(doc, latex);
    if (!formula) continue;
    // The editor's storage shape: the KaTeX root carries the source.
    formula.setAttribute(INLINE_MATH_ATTRIBUTE, latex);
    span.replaceWith(formula);
  }
  return template.innerHTML;
}

/** Apply a rewrite to every prose field the sanitizer treats as HTML. */
function mapProse(content: SlideContent, rewrite: (html: string) => string): SlideContent {
  const elements = (content.canvas.elements ?? []).map((element) => {
    if (element.type === 'text' && typeof element.content === 'string') {
      return { ...element, content: rewrite(element.content) };
    }
    if (element.type === 'shape' && typeof element.text?.content === 'string') {
      return { ...element, text: { ...element.text, content: rewrite(element.text.content) } };
    }
    if (element.type === 'table' && Array.isArray(element.data)) {
      return {
        ...element,
        data: element.data.map((row) =>
          Array.isArray(row)
            ? row.map((cell) =>
                typeof cell?.text === 'string' ? { ...cell, text: rewrite(cell.text) } : cell,
              )
            : row,
        ),
      };
    }
    return element;
  });
  return { ...content, canvas: { ...content.canvas, elements } };
}

/**
 * Sanitize a slide's rich text for the player document. Returns the
 * sanitized content and the resources that cannot be shown offline.
 */
export function sanitizeSlideRichText(
  content: SlideContent,
  doc: Document = globalThis.document,
): { content: SlideContent; discarded: string[] } {
  const discarded: string[] = [];
  const stripped = mapProse(content, (html) => {
    const prepared = stripFormulas(doc, html);
    discarded.push(...prepared.discarded);
    return prepared.html;
  });
  const sanitized = sanitizeSceneContent(stripped, { keepInlineMathSource: true });
  return { content: mapProse(sanitized, (html) => renderFormulas(doc, html)), discarded };
}
