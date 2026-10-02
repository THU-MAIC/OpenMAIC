/**
 * Neutralize scripting in untrusted, non-HTML same-origin documents.
 *
 * The producer serves `.svg` as `image/svg+xml`, and a document loaded through
 * `<iframe src>` does **not** inherit the parent's `<meta>` CSP. An SVG is a
 * scriptable document with no `http-equiv` CSP mechanism, so a project that can
 * frame one (`frame-src 'self'`) would otherwise reach the network freely.
 * `.xhtml` is covered the same way because the producer's current octet-stream
 * MIME is an accident, not a guarantee.
 *
 * Both transforms parse with the package's existing `parse5` dependency and
 * re-serialize the tree, so no hand-written pattern can re-form markup into
 * script. A document that cannot be parsed fails closed to an inert empty
 * document.
 */
import { parse, serialize, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5';

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/** `<script>`, nested frames and plugin embeds can run code or fetch. */
const FORBIDDEN_ELEMENTS = new Set(['script', 'iframe', 'embed', 'object', 'foreignobject']);

/** `href` and its SVG `xlink:href` spelling (parse5 stores the prefix apart). */
const URL_ATTRIBUTES = new Set(['href', 'xlink:href']);

/** Inert replacement for an SVG that cannot be safely parsed. */
export const EMPTY_SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

/** Inert replacement for an XHTML document that cannot be safely parsed. */
export const EMPTY_SAFE_XHTML =
  '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body></body></html>';

function attributeName(attribute: Element['attrs'][number]): string {
  return attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
}

/**
 * Browsers strip ASCII control characters and spaces, including tab/newline/CR,
 * before parsing a URL scheme, so `java\nscript:` and `jav&#x09;ascript:` are
 * as dangerous as `javascript:`. Entity references are already decoded by
 * parse5 when this runs.
 */
function isJavascriptUrl(value: string): boolean {
  const stripped = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  return stripped.slice(0, 'javascript:'.length) === 'javascript:';
}

function isElementNode(node: DefaultTreeAdapterTypes.ChildNode): node is Element {
  return !node.nodeName.startsWith('#');
}

/** Strip every dangerous attribute from one element and recurse into it. */
function sanitizeElement(element: Element): void {
  element.attrs = element.attrs.filter((attribute) => {
    const name = attributeName(attribute).toLowerCase();
    if (name.startsWith('on')) return false;
    if (URL_ATTRIBUTES.has(name) && isJavascriptUrl(attribute.value)) return false;
    return true;
  });
  sanitizeChildren(element);
  const template = (element as DefaultTreeAdapterTypes.Template).content;
  if (template) sanitizeChildren(template);
}

/** Remove forbidden subtrees from `node`'s children in place. */
function sanitizeChildren(node: ParentNode): void {
  const children = node.childNodes;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    if (!isElementNode(child)) continue;
    if (FORBIDDEN_ELEMENTS.has(child.tagName.toLowerCase())) {
      children.splice(index, 1);
      continue;
    }
    sanitizeElement(child);
  }
}

function findFirstSvg(node: ParentNode): Element | undefined {
  for (const child of node.childNodes) {
    if (!isElementNode(child)) continue;
    if (child.tagName.toLowerCase() === 'svg') return child;
    const nested = findFirstSvg(child);
    if (nested) return nested;
  }
  return undefined;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Sanitize one extracted `.svg`. The SVG root is re-serialized on its own so
 * the surrounding HTML wrapper `parse()` synthesizes is not written back.
 * A file with no SVG root, or one `parse5` cannot process, becomes
 * {@link EMPTY_SAFE_SVG}: removing the image entirely would change layout, and
 * an empty SVG is inert.
 */
export function sanitizeSvgDocument(bytes: Uint8Array): Uint8Array {
  let output = EMPTY_SAFE_SVG;
  try {
    const document = parse(new TextDecoder().decode(bytes));
    const svg = findFirstSvg(document);
    if (svg) {
      sanitizeElement(svg);
      output = serializeOuter(svg);
    }
  } catch {
    output = EMPTY_SAFE_SVG;
  }
  return encode(output);
}

/**
 * Sanitize one extracted `.xhtml`. Chromium does enforce a `<meta
 * http-equiv=Content-Security-Policy>` inside an `application/xhtml+xml`
 * document (verified in Chromium 151), but injecting one only restricts where
 * the script may connect; sanitizing removes the script so it cannot run at
 * all, and it also holds if the producer's MIME map changes.
 */
export function sanitizeXhtmlDocument(bytes: Uint8Array): Uint8Array {
  let output = EMPTY_SAFE_XHTML;
  try {
    const document = parse(new TextDecoder().decode(bytes));
    sanitizeChildren(document);
    output = serialize(document);
  } catch {
    output = EMPTY_SAFE_XHTML;
  }
  return encode(output);
}
