/**
 * Images embedded in a document, for owner-level extraction (RFC #1716 §2).
 *
 * A document provider returns the document's text and, separately, the
 * images it found. Owner extraction keeps both: each image becomes an image
 * derivative of the source (its own pool entry, rooted under its own id), and
 * every reference in the text that names one of them is rewritten to name the
 * derivative instead of a file only the provider knew.
 *
 * ## What the providers give
 *
 * - MinerU (self-hosted and cloud) writes markdown that names images by file,
 *   `![](images/<file>)`; the parser records that file on each image
 *   (`metadata.path`), so a reference can be matched to its image. The
 *   markdown is parsed, not pattern-matched ({@link ownerDocumentOutcome}).
 * - The built-in PDF parser and AliDocMind return images beside text that
 *   names none of them: the images are kept, there is nothing to rewrite.
 * - Plain text and markdown uploads return no images and keep their own text.
 *
 * ## References that do not depend on the source
 *
 * A source that reuses another source's result shares its text entry (see
 * `owner-extraction.ts`), but gets derivatives of its own, with ids of its
 * own. So the stored text cannot name derivative ids. It names each kept
 * image by a key instead (`openmaic-derivative:<key>`), and each source's
 * result maps keys to its own derivatives; a reader resolves the keys of the
 * result it read ({@link resolveDerivativeRefsAsync}).
 *
 * ## Bounds
 *
 * The same as media keyframes (`lib/document/extractors/images.ts`): at most
 * `MAX_DERIVED_IMAGES` images, in provider order, each downsampled to a WebP
 * within `MAX_DERIVED_IMAGE_BYTES`. A reference to an image that was not kept
 * -- past the limit, unreadable, or unknown to the provider -- becomes its
 * alt text. When the input exceeds the parser budget, keep the provider's
 * text unchanged and record the skipped rewriting; kept images remain
 * derivatives, even though their references are not rewritten.
 */
import { applyImagePlan, type ImagePlan, type ImageReference } from './document-image-apply.mjs';
import { DocumentImageInputBudgetError, runDocumentImageWorker } from './document-image-parser';
import { normalizePath, basename, type ImagePathIndex } from './document-image-paths.mjs';
export type { ImagePathIndex } from './document-image-paths.mjs';

import { MAX_DERIVED_IMAGES, prepareDerivedImage } from '@/lib/document/extractors/images';
import type { DocumentArtifact, DocumentExtractorProvider } from '@/lib/document/types';

import {
  decodeMediaAssetData,
  documentOutcome,
  type ExtractedSourceImage,
  type SourceExtractionOutcome,
} from './extract';

/** The link target a stored text uses for a kept image. */
export const DERIVATIVE_REF_PREFIX = 'openmaic-derivative:';
/** The link target a reader sees for one: the derivative's own material id. */
export const MATERIAL_REF_PREFIX = 'material:';

/** One kept image: the derivative to store and the key the text names it by. */
interface KeptImage {
  key: string;
  image: ExtractedSourceImage;
}

/**
 * The document's images to keep, in provider order and within the bounds,
 * each prepared as WebP, keyed `img-<n>`. An image that cannot be decoded or
 * prepared is skipped.
 */
async function keptImages(
  artifact: DocumentArtifact,
): Promise<{ kept: Array<KeptImage & { path?: string }>; skipped: number }> {
  const candidates = artifact.assets.filter((asset) => asset.type === 'image' && asset.data);
  const kept: Array<KeptImage & { path?: string }> = [];
  let skipped = 0;
  for (const asset of candidates) {
    if (kept.length >= MAX_DERIVED_IMAGES) {
      skipped += 1;
      continue;
    }
    let prepared;
    try {
      prepared = await prepareDerivedImage(decodeMediaAssetData(asset.data!));
    } catch {
      prepared = null;
    }
    if (!prepared) {
      skipped += 1;
      continue;
    }
    const key = `img-${kept.length + 1}`;
    const path = typeof asset.metadata?.path === 'string' ? asset.metadata.path : undefined;
    kept.push({
      key,
      ...(path ? { path } : {}),
      image: {
        data: prepared.buffer.toString('base64'),
        mimeType: prepared.mime,
        title: asset.description ?? key,
        key,
        ...(asset.pageNumber ? { pageNumber: asset.pageNumber } : {}),
      },
    });
  }
  return { kept, skipped };
}

/**
 * Where each kept image's references may point: the provider's own path for
 * it first, then -- only when exactly one kept image has that file name -- its
 * bare file name, so one image's alias can never take another's path.
 */

export function imagePathIndex(
  images: ReadonlyArray<{ key: string; path?: string }>,
): ImagePathIndex {
  const exact = new Map<string, string>();
  const basenames = new Map<string, Set<string>>();
  for (const { key, path } of images) {
    if (!path) continue;
    const normalized = normalizePath(path);
    if (!exact.has(normalized)) exact.set(normalized, key);
    const name = basename(normalized);
    basenames.set(name, (basenames.get(name) ?? new Set()).add(key));
  }
  // MinerU's markdown names an image `images/<file>` where its dictionary
  // says `<file>`. Add aliases only after every real path has its place.
  for (const { key, path } of images) {
    if (!path) continue;
    const normalized = normalizePath(path);
    const alias = `images/${normalized}`;
    if (!normalized.includes('/') && !exact.has(alias)) exact.set(alias, key);
  }
  const byBasename = new Map<string, string>();
  for (const [name, keys] of basenames) {
    if (keys.size === 1) byBasename.set(name, [...keys][0]!);
  }
  return { exact, byBasename };
}

// A cache of derived reference positions, not owner text or derivative ids.
// Callers supply an immutable text-entry/revision identity after resolving its
// bytes. Every reader still applies its own result's mapping, including reuse.
const MAX_IMAGE_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PLAN_ENTRIES = 16;
const imagePlans = new Map<string, { plan: ImagePlan; bytes: number }>();
let imagePlanBytes = 0;
function cachedImagePlan(cacheKey?: string): ImagePlan | undefined {
  const cached = cacheKey === undefined ? undefined : imagePlans.get(cacheKey);
  if (cached) {
    imagePlans.delete(cacheKey!);
    imagePlans.set(cacheKey!, cached);
    return cached.plan;
  }
}

function cacheImagePlan(plan: ImagePlan, cacheKey?: string): void {
  const size = [...plan.markdown, ...plan.html].reduce(
    (bytes, image) =>
      bytes +
      256 +
      2 *
        (image.target.length +
          image.alt.length +
          ('title' in image ? (image.title?.length ?? 0) : 0) +
          ('attributePrefix' in image ? image.attributePrefix.length : 0)),
    0,
  );
  if (cacheKey !== undefined && size <= MAX_IMAGE_PLAN_BYTES) {
    // Two cold reads may finish together; replacement must not double-count
    // the same cached plan against the byte limit.
    const previous = imagePlans.get(cacheKey);
    if (previous) {
      imagePlanBytes -= previous.bytes;
      imagePlans.delete(cacheKey);
    }
    while (
      imagePlans.size >= MAX_IMAGE_PLAN_ENTRIES ||
      imagePlanBytes + size > MAX_IMAGE_PLAN_BYTES
    ) {
      const oldest = imagePlans.keys().next().value!;
      imagePlanBytes -= imagePlans.get(oldest)!.bytes;
      imagePlans.delete(oldest);
    }
    // Copy the small plan so cached substrings cannot retain a large input's
    // backing storage after its parsed tree has been discarded.
    imagePlans.set(cacheKey, { plan: structuredClone(plan), bytes: size });
    imagePlanBytes += size;
  }
}

/**
 * A document provider's artifact as owner extraction keeps it: the text with
 * its references rewritten, and the kept images as derivatives. The session
 * chain keeps using {@link documentOutcome}, which keeps text only.
 */
export async function ownerDocumentOutcome(
  artifact: DocumentArtifact,
  provider: DocumentExtractorProvider,
): Promise<SourceExtractionOutcome> {
  const { kept, skipped } = await keptImages(artifact);
  const index = imagePathIndex(kept);
  // Uploads decoded by plain-text have no provider-owned image paths. MinerU
  // output still needs rewriting when all of its images are missing.
  const base = documentOutcome(artifact, provider);
  const diagnostics = [
    ...(base.stats.diagnostics ?? []),
    ...(skipped > 0
      ? [`${skipped} document image(s) not kept (limit ${MAX_DERIVED_IMAGES}, or unreadable)`]
      : []),
  ];
  let rewritten = { text: base.text, refs: [] as ImageReference[] };
  if (provider.id !== 'plain-text') {
    try {
      rewritten = await runDocumentImageWorker({
        kind: 'rewrite',
        blocks: artifact.blocks
          .filter((block) => block.type === 'text' || block.type === 'markdown')
          .map((block) => ({ type: block.type, ...(block.text ? { text: block.text } : {}) })),
        index,
      });
    } catch (error) {
      if (!(error instanceof DocumentImageInputBudgetError)) throw error;
      diagnostics.push('Document image rewriting skipped: input exceeds parser budget');
    }
  }
  return {
    ...base,
    text: rewritten.text,
    imageRefs: rewritten.refs,
    images: kept.map(({ image }) => image),
    stats: {
      ...base.stats,
      chars: rewritten.text.length,
      imageCount: kept.length,
      ...(diagnostics.length ? { diagnostics } : {}),
    },
  };
}

/**
 * Production reads splice positions published with the text. Old results
 * lacking positions parse in the worker once and use the existing bounded
 * position cache. Over-budget legacy text is returned without resolving keys.
 * Neither path caches a reader's derivative ids.
 */
export async function resolveDerivativeRefsAsync(
  text: string,
  derivatives: ReadonlyArray<{ id: string; key?: string }>,
  cacheKey: string,
  refs?: readonly ImageReference[],
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error('aborted');
  const ids = new Map(derivatives.flatMap((image) => (image.key ? [[image.key, image.id]] : [])));
  if (ids.size === 0) return text;
  if (refs !== undefined) {
    let end = 0;
    const parts: string[] = [];
    let valid = true;
    for (const ref of refs) {
      if (
        !Number.isInteger(ref.start) ||
        !Number.isInteger(ref.end) ||
        ref.start < end ||
        ref.end > text.length ||
        text.slice(ref.start, ref.end) !== DERIVATIVE_REF_PREFIX + ref.key
      ) {
        valid = false;
        break;
      }
      parts.push(
        text.slice(end, ref.start),
        ids.has(ref.key) ? MATERIAL_REF_PREFIX + ids.get(ref.key) : text.slice(ref.start, ref.end),
      );
      end = ref.end;
    }
    if (valid) {
      parts.push(text.slice(end));
      return parts.join('');
    }
    console.warn('[document-images] Invalid published image positions; parsing current bytes');
  }
  const prefix = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const input = prefix ? text.slice(1) : text;
  let plan = cachedImagePlan(cacheKey);
  if (!plan) {
    try {
      plan = await runDocumentImageWorker({ kind: 'plan', text: input }, cacheKey, signal);
    } catch (error) {
      if (signal?.aborted || !(error instanceof DocumentImageInputBudgetError)) throw error;
      return text;
    }
    if (signal?.aborted) throw new Error('aborted');
    cacheImagePlan(plan, cacheKey);
  }
  return (
    prefix +
    applyImagePlan(input, plan, (target) => {
      const id = ids.get(target.slice(DERIVATIVE_REF_PREFIX.length));
      return id ? MATERIAL_REF_PREFIX + id : undefined;
    })
  );
}
