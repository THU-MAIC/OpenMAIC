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
 *   markdown is parsed, not pattern-matched ({@link rewriteImageReferences}).
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
 * result it read ({@link resolveDerivativeRefs}).
 *
 * ## Bounds
 *
 * The same as media keyframes (`lib/document/extractors/images.ts`): at most
 * `MAX_DERIVED_IMAGES` images, in provider order, each downsampled to a WebP
 * within `MAX_DERIVED_IMAGE_BYTES`. A reference to an image that was not kept
 * -- past the limit, unreadable, or unknown to the provider -- becomes its
 * alt text, so the stored text never names a file nothing holds.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';

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

/** `<img ... src="target" ...>`, inside a raw HTML node (MinerU's tables carry them). */
const HTML_IMAGE =
  /(<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*?\ssrc\s*=\s*)(?:"([^"]+)"|'([^']+)')((?:[^"'<>]|"[^"]*"|'[^']*')*>)/gi;
const DERIVATIVE_REF = /openmaic-derivative:([A-Za-z0-9_-]+)/g;

/** A target the provider resolved against its own files: no scheme, not absolute. */
function isProviderPath(target: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('/');
}

function normalizePath(target: string): string {
  let path = target.replace(/^\.\//, '');
  try {
    path = decodeURI(path);
  } catch {
    // Keep it as written.
  }
  return path;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

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
export interface ImagePathIndex {
  exact: ReadonlyMap<string, string>;
  byBasename: ReadonlyMap<string, string>;
}

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

function keyOf(index: ImagePathIndex, target: string): string | undefined {
  const path = normalizePath(target);
  return index.exact.get(path) ?? index.byBasename.get(basename(path));
}

/** `[`, `]` and `\\` escaped, so alt text stays alt text inside `![...]`. */
function escapeAlt(alt: string): string {
  return alt.replace(/[[\]\\]/g, (character) => `\\${character}`);
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface MarkdownNode {
  type: string;
  url?: string;
  alt?: string | null;
  value?: string;
  identifier?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function span(node: MarkdownNode): { start: number; end: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
}

/**
 * Rewrite the image references of one markdown text. The text is parsed as
 * CommonMark, so only real image references change: an image (`![alt](x)`,
 * destinations with balanced parentheses or `<...>` included), an image
 * reference (`![alt][label]`, `![alt][]`, `![alt]`) through its definition,
 * and an `<img>` inside raw HTML. Code blocks, inline code and escaped text
 * are not image references and are left exactly as written.
 *
 * A reference to a kept image names its key; one to any other file of the
 * provider becomes its alt text. A reference image is written inline, and a
 * definition of a provider file that only images use is removed, so no
 * provider path is left behind. Remote, inline (`data:`) and absolute
 * references are kept.
 */
export function rewriteImageReferences(markdown: string, index: ImagePathIndex): string {
  // CommonMark offsets exclude an initial BOM; edit that same input, then
  // restore the prefix so surrounding characters retain their positions.
  const prefix = markdown.startsWith('\uFEFF') ? '\uFEFF' : '';
  const input = prefix ? markdown.slice(1) : markdown;
  const tree = fromMarkdown(input) as unknown as MarkdownNode;
  const definitions = new Map<string, MarkdownNode>();
  const linkLabels = new Set<string>();
  walk(tree, (node) => {
    if (node.type === 'definition' && node.identifier && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if (node.type === 'linkReference' && node.identifier) linkLabels.add(node.identifier);
  });

  const edits: Edit[] = [];
  const imageFor = (alt: string, target: string): string | null => {
    if (!isProviderPath(target)) return null;
    const key = keyOf(index, target);
    return key
      ? `![${escapeAlt(alt)}](${DERIVATIVE_REF_PREFIX}${key})`
      : `\\[image${alt ? `: ${escapeAlt(alt)}` : ''}\\]`;
  };
  const usedDefinitions = new Set<string>();
  walk(tree, (node) => {
    const at = span(node);
    if (!at) return;
    if (node.type === 'image' && node.url !== undefined) {
      const text = imageFor(node.alt ?? '', node.url);
      if (text !== null) edits.push({ ...at, text });
    } else if (node.type === 'imageReference' && node.identifier) {
      const definition = definitions.get(node.identifier);
      if (!definition?.url) return;
      const text = imageFor(node.alt ?? '', definition.url);
      if (text === null) return;
      edits.push({ ...at, text });
      usedDefinitions.add(node.identifier);
    } else if (node.type === 'html' && node.value) {
      const value = node.value.replace(
        HTML_IMAGE,
        (
          whole,
          before: string,
          doubleQuoted: string | undefined,
          singleQuoted: string | undefined,
          after: string,
        ) => {
          const target = doubleQuoted ?? singleQuoted!;
          if (!isProviderPath(target)) return whole;
          const key = keyOf(index, target);
          const quote = doubleQuoted === undefined ? "'" : '"';
          return key
            ? `${before}${quote}${DERIVATIVE_REF_PREFIX}${key}${quote}${after}`
            : '\\[image\\]';
        },
      );
      if (value !== node.value) edits.push({ ...at, text: value });
    }
  });
  for (const identifier of usedDefinitions) {
    if (linkLabels.has(identifier)) continue;
    const at = span(definitions.get(identifier)!);
    if (at) edits.push({ ...at, text: '' });
  }

  let out = input;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return prefix + out;
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
  const rewritten: DocumentArtifact = {
    ...artifact,
    blocks: artifact.blocks.map((block) =>
      provider.id !== 'plain-text' && block.type === 'markdown' && block.text
        ? { ...block, text: rewriteImageReferences(block.text, index) }
        : block,
    ),
  };
  const base = documentOutcome(rewritten, provider);
  const diagnostics = [
    ...(base.stats.diagnostics ?? []),
    ...(skipped > 0
      ? [`${skipped} document image(s) not kept (limit ${MAX_DERIVED_IMAGES}, or unreadable)`]
      : []),
  ];
  return {
    ...base,
    images: kept.map(({ image }) => image),
    stats: {
      ...base.stats,
      imageCount: kept.length,
      ...(diagnostics.length ? { diagnostics } : {}),
    },
  };
}

/**
 * Resolve a stored text's keys to the derivatives of the result being read:
 * `openmaic-derivative:<key>` becomes `material:<derivative id>`. A key the
 * result does not have (it cannot happen for a text and result published
 * together) is left as it is.
 */
export function resolveDerivativeRefs(
  text: string,
  derivatives: ReadonlyArray<{ id: string; key?: string }>,
): string {
  const idByKey = new Map(
    derivatives.flatMap((derivative) => (derivative.key ? [[derivative.key, derivative.id]] : [])),
  );
  if (idByKey.size === 0) return text;
  return text.replace(DERIVATIVE_REF, (whole, key: string) => {
    const id = idByKey.get(key);
    return id ? `${MATERIAL_REF_PREFIX}${id}` : whole;
  });
}
