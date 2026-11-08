/**
 * Make one persisted scene self-contained for the render service's `/preview`.
 *
 * The render service draws a scene in an isolated page that can load nothing
 * from the network, so it refuses (HTTP 422) a slide whose media slots are not
 * `data:` URLs and an interactive page that references any resource that is
 * neither inline nor a `data:` URL. Persisted courses reference media by
 * asset-pool id (`ast_…`) and interactive pages load the deployment-hosted
 * libraries, so both have to be inlined first. This module does that on a copy
 * of the scene; the stored document is never touched.
 *
 * Slide media slots are the DSL's own slot set (`slideMediaSlotDescriptors`),
 * the same set the render service validates. An asset id is resolved through
 * the session owner's asset pool. A slot that cannot be inlined (a remote URL,
 * a missing asset, or bytes over the request budget) gets a visible placeholder
 * of the same size, and the caller reports it to the agent as a note.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isConcreteMediaAddress,
  slideMediaSlotDescriptors,
  type SlideMediaSlotKind,
} from '@openmaic/dsl';
import {
  INTERACTIVE_ASSET_PATH,
  INTERACTIVE_LIBRARIES,
  interactiveAssetBaseUrl,
} from '@openmaic/generation/browser';

import { inlineHtmlAssets, type FetchAsset } from '@/lib/export/inline-assets';
import type { Scene } from '@/lib/types/stage';

/**
 * Upper bound on the serialized `/preview` request. The render service refuses
 * a body over `RENDER_PREVIEW_MAX_JSON_BYTES` (32 MiB by default); staying at
 * three quarters of that default leaves headroom for the envelope and a
 * service configured slightly lower.
 */
export const PREVIEW_REQUEST_BUDGET_BYTES = 24 * 1024 * 1024;

export type PreviewAssetResolution =
  | { status: 'resolved'; buffer: Buffer; mimeType: string }
  | { status: 'missing' }
  | { status: 'too_large' };

/** Read one asset as the session owner may read it, refusing more than `maxByteLength`. */
export type PreviewAssetReader = (
  assetId: string,
  maxByteLength: number,
  signal?: AbortSignal,
) => Promise<PreviewAssetResolution>;

/** Read one file of a deployment-hosted interactive library (`<package>@<version>`, file). */
export type InteractiveLibraryFileReader = (
  libraryDirectory: string,
  file: string,
  signal?: AbortSignal,
) => Promise<Uint8Array | null>;

export interface PreparePreviewOptions {
  readAsset: PreviewAssetReader;
  readLibraryFile?: InteractiveLibraryFileReader;
  /** Bytes the scene may occupy once serialized; defaults to {@link PREVIEW_REQUEST_BUDGET_BYTES}. */
  budgetBytes?: number;
  /**
   * Stops preparation: checked between reads, and every read is raced against
   * it, so a stuck or slow read cannot outlive a cancel or the deadline.
   */
  signal?: AbortSignal;
}

/** Settle with `work`, or reject with the signal's reason as soon as it aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export type PreparedPreviewScene =
  | { ok: true; scene: Scene; notes: string[] }
  | { ok: false; reason: string };

/**
 * Origin the hosted library URLs are resolved against while inlining. It is
 * never fetched: {@link libraryFetcher} answers hosted-library URLs from disk.
 */
const PREVIEW_ASSET_ORIGIN = 'https://openmaic-preview.invalid';

const PLACEHOLDER_LABEL = 'Media not shown in preview';

/** A neutral box that keeps the slot's layout and says why it is empty. */
const MEDIA_PLACEHOLDER = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180" preserveAspectRatio="none"><rect width="320" height="180" fill="#e5e7eb"/><rect x="4" y="4" width="312" height="172" fill="none" stroke="#9ca3af" stroke-width="2" stroke-dasharray="8 6"/><text x="160" y="96" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#4b5563">${PLACEHOLDER_LABEL}</text></svg>`,
).toString('base64')}`;

/** Visual slots first, so a tight budget is spent on what the still image shows. */
const SLOT_PRIORITY: Record<SlideMediaSlotKind, number> = {
  'background-image': 0,
  'image-src': 0,
  'video-poster': 0,
  'video-src': 1,
  'video-media-ref': 1,
  'audio-src': 2,
};

const SLOT_LABEL: Record<SlideMediaSlotKind, string> = {
  'background-image': 'background image',
  'image-src': 'image',
  'video-poster': 'video poster',
  'video-src': 'video',
  'video-media-ref': 'video',
  'audio-src': 'audio',
};

function isDataUrl(value: string): boolean {
  return /^data:/i.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function shortRef(ref: string): string {
  const trimmed = ref.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

/** The deployment's `public/vendor/interactive`, as the app serves it. */
export const readHostedInteractiveLibraryFile: InteractiveLibraryFileReader = async (
  libraryDirectory,
  file,
  signal,
) => {
  const root = path.join(process.cwd(), 'public', 'vendor', 'interactive', libraryDirectory);
  const target = path.resolve(root, file);
  if (!target.startsWith(`${root}${path.sep}`)) return null;
  try {
    return new Uint8Array(await readFile(target, { signal }));
  } catch {
    return null;
  }
};

const LIBRARY_CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * Serve the hosted interactive libraries from disk and nothing else: every
 * other URL is a miss, so the preview never fetches over the network.
 */
function libraryFetcher(read: InteractiveLibraryFileReader, signal?: AbortSignal): FetchAsset {
  const libraryDirectories = new Set<string>(
    INTERACTIVE_LIBRARIES.map((library) => `${library.package}@${library.version}`),
  );
  // Relative bases are resolved against the preview origin; a configured
  // absolute base (a CDN mirror of the same files) is served from disk too.
  const bases = [
    ...new Set(
      [INTERACTIVE_ASSET_PATH, interactiveAssetBaseUrl()].map(
        (base) => new URL(`${base.replace(/\/$/, '')}/`, PREVIEW_ASSET_ORIGIN).href,
      ),
    ),
  ];
  return async (url) => {
    // Once aborted, every remaining fetch the inliner makes ends at once.
    if (signal?.aborted) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.search || parsed.hash) return null;
    const href = parsed.href;
    const base = bases.find((candidate) => href.startsWith(candidate));
    if (!base) return null;
    const match = /^((?:@[^/]+\/)?[^/@]+@[^/]+)\/(.+)$/.exec(
      decodeURIComponent(href.slice(base.length)),
    );
    if (!match || !libraryDirectories.has(match[1]!)) return null;
    const bytes = await untilAborted(read(match[1]!, match[2]!, signal), signal).catch(() => null);
    if (!bytes) return null;
    const contentType =
      LIBRARY_CONTENT_TYPES[path.extname(match[2]!).toLowerCase()] ?? 'application/octet-stream';
    return { bytes, contentType };
  };
}

/**
 * The ref a video actually plays, with the app's precedence
 * (`resolveVideoMediaForElement` in `lib/media/media-task-resolution.ts`): a
 * concrete `src` wins, then a non-empty `mediaRef`, then `src` as stored. That
 * module is browser-side, so its precedence is restated here.
 */
function effectiveVideoSource(video: Record<string, unknown>): string | undefined {
  const src = typeof video.src === 'string' ? video.src : undefined;
  const mediaRef = typeof video.mediaRef === 'string' ? video.mediaRef : undefined;
  if (src && isConcreteMediaAddress(src)) return src;
  return mediaRef || src;
}

/**
 * The renderer draws a video from `src` and `poster` only, so the effective
 * source moves into `src` and `mediaRef` is dropped from the preview copy.
 */
function normalizeVideoSources(elements: readonly unknown[]): void {
  for (const element of elements) {
    if (!isRecord(element) || element.type !== 'video') continue;
    const source = effectiveVideoSource(element);
    delete element.mediaRef;
    if (source === undefined) delete element.src;
    else element.src = source;
  }
}

async function prepareSlide(
  scene: Scene,
  options: PreparePreviewOptions,
  budget: number,
): Promise<PreparedPreviewScene> {
  const copy = structuredClone(scene);
  const content = copy.content as unknown;
  const canvas = isRecord(content) ? content.canvas : undefined;
  if (!isRecord(canvas) || !Array.isArray(canvas.elements)) {
    return { ok: true, scene: copy, notes: [] };
  }
  // The render service reports malformed elements itself; enumerate only a
  // canvas the slot classifier can walk.
  if (!canvas.elements.every((element) => isRecord(element) && typeof element.type === 'string')) {
    return { ok: true, scene: copy, notes: [] };
  }
  normalizeVideoSources(canvas.elements);
  const slide = canvas as unknown as Parameters<typeof slideMediaSlotDescriptors>[0];
  const slots = [...slideMediaSlotDescriptors(slide)]
    .filter((slot) => slot.ref !== undefined && !isDataUrl(slot.ref))
    .sort((a, b) => SLOT_PRIORITY[a.kind] - SLOT_PRIORITY[b.kind]);
  if (slots.length === 0) return { ok: true, scene: copy, notes: [] };

  const write = (slot: (typeof slots)[number], value: string) => {
    const target =
      slot.elementIndex === undefined
        ? (slide.background as unknown as { image: Record<string, unknown> }).image
        : (slide.elements[slot.elementIndex] as unknown as Record<string, unknown>);
    target[slot.property] = value;
  };
  const elementOf = (slot: (typeof slots)[number]) =>
    slot.elementIndex === undefined
      ? undefined
      : (slide.elements[slot.elementIndex] as unknown as Record<string, unknown>);

  let used = jsonBytes(copy);
  const notes: string[] = [];
  const placeholders = new Map<string, string[]>();
  const placehold = (slot: (typeof slots)[number], why: string) => {
    const label = `${SLOT_LABEL[slot.kind]} ${shortRef(slot.ref!)}`;
    placeholders.set(why, [...(placeholders.get(why) ?? []), label]);
    write(slot, MEDIA_PLACEHOLDER);
    used += MEDIA_PLACEHOLDER.length - slot.ref!.length;
    // A video that will not play still needs a frame to show.
    const element = elementOf(slot);
    if (
      slot.kind === 'video-src' &&
      element &&
      !(typeof element.poster === 'string' && isDataUrl(element.poster))
    ) {
      const before = typeof element.poster === 'string' ? element.poster.length : 0;
      element.poster = MEDIA_PLACEHOLDER;
      used += MEDIA_PLACEHOLDER.length - before;
    }
  };

  // Every await in this loop is an asset read raced against the signal, so a
  // cancel or the deadline ends the loop at the read it interrupts.
  for (const slot of slots) {
    const ref = slot.ref!.trim();
    if (slot.kind === 'video-poster') {
      const element = elementOf(slot);
      if (typeof element?.poster === 'string' && isDataUrl(element.poster)) continue;
    }
    if (!ref) {
      placehold(slot, 'it is empty');
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('/')) {
      placehold(slot, 'it is a URL, not a course asset (the preview loads nothing remote)');
      continue;
    }
    // A data URL costs about 4/3 of the bytes plus its short header.
    const headroom = budget - used + ref.length - 128;
    const maxByteLength = Math.max(0, Math.floor((headroom * 3) / 4));
    const resolution = await untilAborted(
      options.readAsset(ref, maxByteLength, options.signal),
      options.signal,
    );
    if (resolution.status === 'missing') {
      placehold(slot, 'the asset does not exist or is not readable by this user');
      continue;
    }
    if (resolution.status === 'too_large') {
      placehold(slot, 'it would exceed the preview request size limit');
      continue;
    }
    const dataUrl = `data:${resolution.mimeType || 'application/octet-stream'};base64,${resolution.buffer.toString('base64')}`;
    if (used + dataUrl.length - ref.length > budget) {
      placehold(slot, 'it would exceed the preview request size limit');
      continue;
    }
    write(slot, dataUrl);
    used += dataUrl.length - ref.length;
  }

  for (const [why, labels] of placeholders) {
    notes.push(
      `${labels.length} media reference(s) drawn as a "${PLACEHOLDER_LABEL}" placeholder because ${why}: ${labels.slice(0, 5).join(', ')}${labels.length > 5 ? ` (+${labels.length - 5} more)` : ''}. The page itself is unchanged.`,
    );
  }
  return { ok: true, scene: copy, notes };
}

async function prepareInteractive(
  scene: Scene,
  options: PreparePreviewOptions,
  budget: number,
): Promise<PreparedPreviewScene> {
  const content = scene.content as unknown;
  const html = isRecord(content) ? content.html : undefined;
  // The render service explains an empty page itself.
  if (typeof html !== 'string' || !html.trim()) return { ok: true, scene, notes: [] };

  const {
    html: inlined,
    report,
    unresolved,
  } = await inlineHtmlAssets(html, {
    baseUrl: PREVIEW_ASSET_ORIGIN,
    fetcher: libraryFetcher(
      options.readLibraryFile ?? readHostedInteractiveLibraryFile,
      options.signal,
    ),
    keepImportmapFallbacks: false,
  });
  // The inliner treats a refused fetch as a missing asset; an abort must not
  // leave a half-inlined page to send.
  options.signal?.throwIfAborted();
  const copy = structuredClone(scene);
  (copy.content as unknown as Record<string, unknown>).html = inlined;
  if (jsonBytes(copy) > budget) {
    return {
      ok: false,
      reason: `the interactive page is too large to preview once its libraries are inlined (over ${budget} bytes)`,
    };
  }
  const residual = [
    ...new Set([
      ...report.failed.map((failure) => failure.url).filter((url) => !/^about:/i.test(url)),
      ...unresolved,
    ]),
  ];
  const notes = residual.length
    ? [
        `${residual.length} resource reference(s) in the interactive HTML are not deployment-hosted libraries and were left as written: ${residual
          .slice(0, 5)
          .map(shortRef)
          .join(', ')}${residual.length > 5 ? ` (+${residual.length - 5} more)` : ''}.`,
      ]
    : [];
  return { ok: true, scene: copy, notes };
}

/** A copy of `scene` the render service can draw without loading anything. */
export async function prepareScenePreview(
  scene: Scene,
  options: PreparePreviewOptions,
): Promise<PreparedPreviewScene> {
  const budget = options.budgetBytes ?? PREVIEW_REQUEST_BUDGET_BYTES;
  options.signal?.throwIfAborted();
  if (scene.type === 'slide') return prepareSlide(scene, options, budget);
  if (scene.type === 'interactive') return prepareInteractive(scene, options, budget);
  return { ok: true, scene, notes: [] };
}
