import type { OssUpload } from '@openmaic/importer';

import type { Slide } from '@openmaic/dsl';

/**
 * Placeholder-media handling for the `import_pptx` tool, built on the
 * importer's own primitives (`isPlaceholderDataUrl` / `isPlaceholderPngBytes`
 * from `@openmaic/importer` ≥ 0.1.5).
 *
 * Unconvertible media — WMF previews of Equation.3 OLE formulas, vector-only
 * EMF, failed TIFF/WDP decodes — arrives from the importer as hardcoded 1×1
 * placeholder images. The guard keeps those bytes out of remote storage
 * (refused blobs keep their data URL, which is exactly what the strip then
 * matches), and the strip removes placeholder-referencing media from the
 * parsed slides while reporting page order + geometry so the agent can
 * restore the content (formulas via `patch_stage` latex elements).
 *
 * The importer package is loaded lazily: its bundle needs DOM/XHR shims that
 * only exist after the host installs them (see import-pptx-worker.mjs), so a
 * static value import here would break Node-side consumers and tests.
 */

interface PlaceholderPrimitives {
  isPlaceholderDataUrl(src: string | undefined | null): boolean;
  isPlaceholderPngBytes(bytes: Uint8Array): boolean;
}

let primitives: PlaceholderPrimitives | null = null;

/**
 * The importer bundle (pdfjs-dist legacy) probes `XMLHttpRequest` and
 * `location` at module init. The worker installs those shims before its own
 * dynamic import; this module is the only main-thread importer consumer, so
 * it installs the same minimal host shims before loading the primitives.
 */
function ensureImporterHostShims(): void {
  const g = globalThis as typeof globalThis & { location?: unknown };
  if (typeof g.location === 'undefined') {
    Object.defineProperty(globalThis, 'location', {
      value: { host: 'localhost' },
      configurable: true,
    });
  }
}

async function loadPrimitives(): Promise<PlaceholderPrimitives> {
  if (!primitives) {
    ensureImporterHostShims();
    const { installNodeXmlHttpRequest } = await import('./node-xhr');
    installNodeXmlHttpRequest();
    const mod = await import('@openmaic/importer');
    primitives = {
      isPlaceholderDataUrl: mod.isPlaceholderDataUrl,
      isPlaceholderPngBytes: mod.isPlaceholderPngBytes,
    };
  }
  return primitives;
}

/** Wrap the final upload (default or injected): placeholder bytes never reach storage. */
export function guardOssUpload(inner: OssUpload): { upload: OssUpload; refusals: () => number } {
  let refused = 0;
  const upload: OssUpload = async (blob, filename) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { isPlaceholderPngBytes } = await loadPrimitives();
    if (isPlaceholderPngBytes(bytes)) {
      refused++;
      return `data:${blob.type || 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`;
    }
    return inner(blob, filename);
  };
  return { upload, refusals: () => refused };
}

/** Where a stripped placeholder came from, for agent-facing repair hints. */
export interface UnconvertibleMediaRecord {
  /** Final page order the slide lands at (firstOrder + slideIndex). */
  order: number;
  kind: 'image' | 'background' | 'pattern';
  elementId?: string;
  box?: { left: number; top: number; width: number; height: number };
}

interface SlideWithElements {
  elements?: Array<Record<string, unknown>>;
  background?: { type?: string; image?: { src?: string } | null; color?: string };
}

/**
 * Remove placeholder-referencing media from parsed slides: drop image
 * elements, degrade placeholder-image backgrounds to plain white, and clear
 * placeholder shape/text pattern fills. Detection is the importer's
 * `isPlaceholderDataUrl` — the OSS guard keeps refused placeholders in data
 * URL form precisely so this single matcher covers every path.
 */
export async function stripUnconvertibleMedia(
  slides: Slide[],
  firstOrder: number,
): Promise<{ slides: Slide[]; removed: UnconvertibleMediaRecord[] }> {
  const { isPlaceholderDataUrl } = await loadPrimitives();
  const removed: UnconvertibleMediaRecord[] = [];
  const cleaned = slides.map((slide, index) => {
    const s = slide as unknown as SlideWithElements;
    const order = firstOrder + index;

    let background = s.background;
    if (background?.type === 'image' && isPlaceholderDataUrl(background.image?.src)) {
      background = { type: 'solid', color: '#ffffff' };
      removed.push({ order, kind: 'background' });
    }

    const elements = (s.elements ?? [])
      .filter((element) => {
        if (element.type === 'image' && isPlaceholderDataUrl(element.src as string)) {
          removed.push({
            order,
            kind: 'image',
            elementId: element.id as string | undefined,
            box: geometryOf(element),
          });
          return false;
        }
        return true;
      })
      .map((element) => {
        if (isPlaceholderDataUrl(element.pattern as string | undefined)) {
          removed.push({
            order,
            kind: 'pattern',
            elementId: element.id as string | undefined,
            box: geometryOf(element),
          });
          const { pattern: _pattern, ...rest } = element;
          return rest;
        }
        return element;
      });

    return { ...slide, background, elements } as unknown as Slide;
  });
  return { slides: cleaned, removed };
}

function geometryOf(element: Record<string, unknown>): UnconvertibleMediaRecord['box'] {
  return {
    left: Number(element.left ?? 0),
    top: Number(element.top ?? 0),
    width: Number(element.width ?? 0),
    height: Number(element.height ?? 0),
  };
}
