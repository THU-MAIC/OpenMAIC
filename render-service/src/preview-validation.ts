/** Pure semantic checks that keep previews faithful and drawable. */
import { slideMediaSlotDescriptors } from '@openmaic/dsl';
import { parse } from 'parse5';
import type { PreviewScene } from './preview-renderer.js';

interface HtmlNode {
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  value?: string;
}

interface CanvasElementShape {
  type: string;
}

export const MAX_INTERACTIVE_HTML_DEPTH = 256;
export const MAX_INTERACTIVE_HTML_ELEMENTS = 10_000;

class InteractiveHtmlLimitError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanvasElementShape(value: unknown): value is CanvasElementShape {
  return isRecord(value) && typeof value.type === 'string' && value.type.trim().length > 0;
}

/** Return a structural scene error the upstream DSL validator does not yet catch. */
export function invalidSlideCanvasElementError(scene: unknown): string | undefined {
  if (!isRecord(scene) || scene.type !== 'slide') return undefined;
  const content = scene.content;
  if (!isRecord(content)) return undefined;
  const canvas = content.canvas;
  if (!isRecord(canvas) || !Array.isArray(canvas.elements)) return undefined;

  const invalidIndex = canvas.elements.findIndex((element) => !isCanvasElementShape(element));
  return invalidIndex === -1
    ? undefined
    : `Invalid scene at /content/canvas/elements/${invalidIndex}: canvas element must be an object with a non-empty type`;
}

function isDataUrl(value: string | undefined): boolean {
  return /^data:/i.test(value?.trim() ?? '');
}

function isSelfContainedCssUrl(value: string): boolean {
  const trimmed = value.trim();
  return isDataUrl(trimmed) || trimmed.startsWith('#');
}

/** Count slide media slots that cannot load inside the isolated preview page. */
export function countNonSelfContainedSlideMediaReferences(
  scene: Extract<PreviewScene, { type: 'slide' }>,
): number {
  // previewabilityError reports malformed entries. Keep this exported counter
  // total and non-throwing as defense in depth for direct callers.
  if (
    !Array.isArray(scene.content.canvas.elements) ||
    !scene.content.canvas.elements.every(isCanvasElementShape)
  ) {
    return 0;
  }

  let count = 0;
  for (const slot of slideMediaSlotDescriptors(scene.content.canvas)) {
    if (slot.ref === undefined) continue;
    if (slot.kind === 'video-media-ref' && slot.elementIndex !== undefined) {
      const element = scene.content.canvas.elements[slot.elementIndex];
      if (element?.type === 'video' && isDataUrl(element.src)) continue;
    }
    if (!isDataUrl(slot.ref)) count += 1;
  }
  return count;
}

const RESOURCE_TAGS = new Set([
  'script',
  'img',
  'video',
  'audio',
  'source',
  'iframe',
  'embed',
  'object',
]);
const RESOURCE_ATTRIBUTES = new Set(['src', 'href', 'srcset', 'poster']);
const RESOURCE_LINK_RELS = new Set(['stylesheet', 'preload', 'modulepreload', 'prefetch']);
const CSS_URL_PATTERN = /url\(\s*(['"]?)(.*?)\1\s*\)/gis;

function attributes(node: HtmlNode): Map<string, string> {
  return new Map(node.attrs?.map((attribute) => [attribute.name.toLowerCase(), attribute.value]));
}

function linkLoadsResource(attrs: Map<string, string>): boolean {
  const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return rels.some(
    (rel) => RESOURCE_LINK_RELS.has(rel) || rel.includes('icon') || rel.includes('font'),
  );
}

/** Parse the URLs in a srcset without splitting the comma inside a data URL. */
function srcsetUrls(srcset: string): string[] {
  const urls: string[] = [];
  let position = 0;
  while (position < srcset.length) {
    while (position < srcset.length && /[\s,]/.test(srcset[position] ?? '')) position += 1;
    if (position >= srcset.length) break;

    const start = position;
    while (position < srcset.length && !/\s/.test(srcset[position] ?? '')) position += 1;
    let url = srcset.slice(start, position);
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
      if (url) urls.push(url);
      continue;
    }

    while (position < srcset.length && srcset[position] !== ',') position += 1;
    if (srcset[position] === ',') position += 1;
    if (url) urls.push(url);
  }
  return urls;
}

function cssUrls(css: string): string[] {
  return Array.from(css.matchAll(CSS_URL_PATTERN), (match) => (match[2] ?? '').trim());
}

/** Find interactive resource references that are neither inline nor data URLs. */
export function findNonSelfContainedInteractiveReferences(html: string): string[] {
  const rejected: string[] = [];
  const rejectUnlessData = (value: string) => {
    if (!isDataUrl(value)) rejected.push(value.trim());
  };
  const rejectUnlessSelfContainedCssUrl = (value: string) => {
    if (!isSelfContainedCssUrl(value)) rejected.push(value.trim());
  };

  const visit = (node: HtmlNode): void => {
    const tagName = node.tagName?.toLowerCase();
    const attrs = attributes(node);

    const style = attrs.get('style');
    if (style !== undefined) cssUrls(style).forEach(rejectUnlessSelfContainedCssUrl);

    if (tagName === 'style') {
      for (const child of node.childNodes ?? []) {
        if (typeof child.value === 'string') {
          cssUrls(child.value).forEach(rejectUnlessSelfContainedCssUrl);
        }
      }
    } else if (tagName === 'link') {
      const href = attrs.get('href');
      if (href !== undefined && linkLoadsResource(attrs)) rejectUnlessData(href);
    } else if (tagName && RESOURCE_TAGS.has(tagName)) {
      for (const [name, value] of attrs) {
        if (!RESOURCE_ATTRIBUTES.has(name)) continue;
        if (name === 'srcset') srcsetUrls(value).forEach(rejectUnlessData);
        else rejectUnlessData(value);
      }
    }
  };

  const root = parse(html, { scriptingEnabled: true }) as unknown as HtmlNode;
  const pending: Array<{ node: HtmlNode; ancestorElementDepth: number }> = [
    { node: root, ancestorElementDepth: 0 },
  ];
  let elementCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    const isElement = current.node.tagName !== undefined;
    const elementDepth = current.ancestorElementDepth + (isElement ? 1 : 0);
    if (isElement) {
      if (elementDepth > MAX_INTERACTIVE_HTML_DEPTH) {
        throw new InteractiveHtmlLimitError(
          `Interactive HTML exceeds the maximum DOM depth of ${MAX_INTERACTIVE_HTML_DEPTH}`,
        );
      }
      elementCount += 1;
      if (elementCount > MAX_INTERACTIVE_HTML_ELEMENTS) {
        throw new InteractiveHtmlLimitError(
          `Interactive HTML exceeds the maximum element count of ${MAX_INTERACTIVE_HTML_ELEMENTS}`,
        );
      }
    }

    visit(current.node);

    // Preserve the recursive walk's child-before-template-content order without
    // spreading an adversarially wide child list into function arguments.
    if (current.node.content) {
      pending.push({ node: current.node.content, ancestorElementDepth: elementDepth });
    }
    const children = current.node.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) pending.push({ node: child, ancestorElementDepth: elementDepth });
    }
  }

  return rejected;
}

/** Return an actionable 422 message when a valid scene cannot be faithfully previewed. */
export function previewabilityError(scene: PreviewScene): string | undefined {
  if (scene.type === 'slide') {
    const invalidElement = invalidSlideCanvasElementError(scene);
    if (invalidElement) return invalidElement;
    if (
      !Array.isArray(scene.content.canvas.elements) ||
      (scene.content.canvas.elements.length === 0 && !scene.content.canvas.background)
    ) {
      return 'Slide canvas has no renderable elements';
    }
    const rejected = countNonSelfContainedSlideMediaReferences(scene);
    if (rejected > 0) {
      return `Scene is not self-contained: ${rejected} slide media reference(s) must use data: URLs`;
    }
  }

  if (scene.type === 'interactive') {
    const html = scene.content.html;
    if (typeof html !== 'string' || !html.trim()) {
      return 'Interactive scene requires non-empty embedded HTML for previewing';
    }
    let rejected: string[];
    try {
      rejected = findNonSelfContainedInteractiveReferences(html);
    } catch (error) {
      if (error instanceof InteractiveHtmlLimitError) return error.message;
      throw error;
    }
    if (rejected.length > 0) {
      return `Interactive HTML is not self-contained: ${rejected.length} resource reference(s) must be inline or use data: URLs`;
    }
  }

  return undefined;
}
