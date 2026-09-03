/** Pure semantic checks that keep previews faithful and drawable. */
import { slideMediaSlotDescriptors } from '@openmaic/dsl';
import { parse } from 'parse5';
import type { PreviewScene } from './preview-renderer.js';

interface HtmlNode {
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
}

/**
 * Mirrors the app-side `isConcreteMediaAddress` decision used by
 * `components/slide-renderer/use-resolved-slide.ts`. Render-service cannot
 * import app code, but it must distinguish allocated asset ids from addresses
 * the renderer can consume directly.
 */
export function isConcreteMediaAddress(value: string | undefined): boolean {
  const candidate = value?.trimStart();
  if (!candidate || /\s/.test(candidate)) return false;
  if (/^(https?:|data:|blob:|\/|\.\.?\/)/i.test(candidate)) return true;
  return (
    /^(?:[^:?#]+\/)+[^?#]*(?:[?#].*)?$/.test(candidate) ||
    /^[^:?#]+[?#].*$/.test(candidate) ||
    /^(?:[^:?#]+\/)?[^/:?#]+\.[a-z0-9]{1,12}(?:[?#].*)?$/i.test(candidate)
  );
}

/** Count media slots whose opaque asset ids still need caller-side resolution. */
export function countUnresolvedSlideAssetReferences(
  scene: Extract<PreviewScene, { type: 'slide' }>,
): number {
  let count = 0;
  for (const slot of slideMediaSlotDescriptors(scene.content.canvas)) {
    if (slot.ref && !isConcreteMediaAddress(slot.ref)) count += 1;
  }
  return count;
}

const SOURCE_TAGS = new Set(['script', 'img', 'audio', 'video', 'source']);

/** Find hard HTTP(S) dependencies that cannot load under the container egress lock. */
export function findExternalInteractiveDependencies(html: string): string[] {
  const external: string[] = [];
  const visit = (node: HtmlNode): void => {
    const attribute =
      node.tagName === 'link' ? 'href' : SOURCE_TAGS.has(node.tagName ?? '') ? 'src' : undefined;
    if (attribute) {
      const value = node.attrs?.find((item) => item.name.toLowerCase() === attribute)?.value.trim();
      if (value && /^https?:\/\//i.test(value)) external.push(value);
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  };

  visit(parse(html, { scriptingEnabled: true }) as unknown as HtmlNode);
  return external;
}

/** Return an actionable 422 message when a valid scene cannot be faithfully previewed. */
export function previewabilityError(scene: PreviewScene): string | undefined {
  if (scene.type === 'slide') {
    if (
      !Array.isArray(scene.content.canvas.elements) ||
      scene.content.canvas.elements.length === 0
    ) {
      return 'Slide canvas has no renderable elements';
    }
    const unresolved = countUnresolvedSlideAssetReferences(scene);
    if (unresolved > 0) {
      return `Scene contains ${unresolved} unresolved asset reference(s); resolve assets to URLs before previewing`;
    }
  }

  if (scene.type === 'interactive') {
    const html = scene.content.html;
    if (typeof html !== 'string' || !html.trim()) {
      return 'Interactive scene requires non-empty embedded HTML for previewing';
    }
    const external = findExternalInteractiveDependencies(html);
    if (external.length > 0) {
      return `Interactive HTML contains ${external.length} external HTTP(S) dependency reference(s); inline or remove them before previewing`;
    }
  }

  return undefined;
}
