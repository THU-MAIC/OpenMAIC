/**
 * Inline an extraction's remote images: a document extractor may answer its
 * images as URLs instead of bytes (a MinerU gateway that hosts the images
 * returns `https://…` links where a self-hosted MinerU returns bare base64).
 * A stored extraction keeps each image's bytes (it is read long after the
 * provider's links may have expired), so the remote ones are downloaded here.
 *
 * The URLs come from the provider's response, so they are fetched as any
 * provider result is (`fetchProviderResultUrl`): HTTPS only, public addresses
 * only, every redirect hop re-validated, connect-time DNS pinned. Each body is
 * read under a per-image limit and a shared byte budget, at most `maxImages`
 * remote images are fetched, a few at a time, each within `perImageTimeoutMs`.
 * Once the byte budget is spent (nothing left, or an image did not fit in what
 * was left) no download starts and the ones running are stopped: a budget of
 * nothing makes no request at all. An image that cannot be inlined (refused,
 * failed, too large, not an image, a `data:` URL that is not base64 as it
 * says, or a source that is neither a `data:` nor an `http(s)` URL) is
 * dropped and counted, never failing the extraction it
 * belongs to; an abort of `signal` does fail it. A `deadline` bounds the
 * downloads without failing them: once it fires, the downloads still running
 * are stopped and every image not yet downloaded is dropped and counted.
 *
 * A dropped image is retryable when another attempt may download it (the
 * request failed, timed out or ran past the deadline), and not when the same
 * answer drops it again (over the image limit or the byte budget, too large,
 * not an image, or a source with no bytes and no URL).
 */
import sharp from 'sharp';

import { MAX_DERIVED_IMAGES } from '@/lib/document/extractors/images';
import { createLogger } from '@/lib/logger';
import {
  DownloadByteBudget,
  DownloadSizeLimitError,
  MAX_REMOTE_IMAGE_BATCH_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  readResponseBodyWithLimit,
} from '@/lib/server/bounded-download';
import { fetchProviderResultUrl } from '@/lib/server/provider-result-fetch';
import { isBase64Image } from '@/lib/utils/base64';

const log = createLogger('InlineImages');

/** Remote images downloaded at once. */
export const INLINE_IMAGE_CONCURRENCY = 4;

/** The longest one image's download (request and body) may take. */
export const INLINE_IMAGE_TIMEOUT_MS = 30_000;

/** Formats a downloaded image may be stored as, when its response does not say. */
const SNIFFED_IMAGE_TYPES: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

export interface InlineImagesOptions {
  /** Stops the downloads; an abort fails the call with the signal's reason. */
  signal?: AbortSignal;
  /** Stops the downloads; the images not downloaded by then are dropped. */
  deadline?: AbortSignal;
  /** The largest one image may be (default {@link MAX_REMOTE_IMAGE_BYTES}). */
  maxImageBytes?: number;
  /** The most all downloaded images may take together (default {@link MAX_REMOTE_IMAGE_BATCH_BYTES}). */
  maxTotalBytes?: number;
  /** The most remote images downloaded; the rest are dropped (default {@link MAX_DERIVED_IMAGES}). */
  maxImages?: number;
  concurrency?: number;
  /** The longest one download may take (default {@link INLINE_IMAGE_TIMEOUT_MS}). */
  perImageTimeoutMs?: number;
}

export interface InlinedImages<T> {
  /** The images that carry their bytes inline, in their original order. */
  images: T[];
  /** How many images were dropped. */
  skipped: number;
  /** The ids of the dropped images another attempt may download (a subset of `skipped`). */
  retryable: string[];
}

/**
 * A download answered something other than an image. MinerU's images are
 * images, so such a body is most likely a transient login, firewall or
 * rate-limit page: another attempt may get the image.
 */
class NotAnImageError extends Error {
  constructor() {
    super('the response is not an image');
    this.name = 'NotAnImageError';
  }
}

/**
 * The URL an image source names, if it is one this module would download: an
 * `http(s)` URL, or one an earlier parser wrapped as if it were base64
 * (`data:image/png;base64,https://…`), which decodes to garbage, not an image.
 */
export function remoteImageUrl(src: string | undefined): string | undefined {
  if (typeof src !== 'string') return undefined;
  const value = src.trim();
  if (/^https?:\/\//i.test(value)) return value;
  const wrapped = /^data:[^,]*;base64,\s*(https?:\/\/\S+)$/i.exec(value);
  return wrapped?.[1];
}

/**
 * Whether an image source carries its bytes: a `data:` URL whose payload, if
 * it says base64, is base64 of an image (a wrapped URL or path is not).
 */
function isInlineImageSource(src: string | undefined): boolean {
  if (typeof src !== 'string' || !src.startsWith('data:')) return false;
  const comma = src.indexOf(',');
  if (comma === -1) return false;
  return !/;base64$/i.test(src.slice(5, comma)) || isBase64Image(src.slice(comma + 1));
}

/** Whether every image already carries its bytes inline. */
export function imagesAreInline(images: ReadonlyArray<{ src?: string }>): boolean {
  return images.every((image) => isInlineImageSource(image.src));
}

/** The image type of downloaded bytes: what the response declares, else what the bytes are. */
async function imageMimeType(response: Response, bytes: Buffer): Promise<string | null> {
  const declared = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (declared?.startsWith('image/')) return declared;
  try {
    const { format } = await sharp(bytes, { failOn: 'none' }).metadata();
    return (format && SNIFFED_IMAGE_TYPES[format]) || null;
  } catch {
    return null;
  }
}

/** The pixel size of image bytes, when they can be read. */
async function pixelSize(bytes: Buffer): Promise<{ width?: number; height?: number }> {
  try {
    const { width, height } = await sharp(bytes, { failOn: 'none' }).metadata();
    return width && height ? { width, height } : {};
  } catch {
    return {};
  }
}

async function downloadAsDataUrl(
  url: string,
  options: { signal: AbortSignal; maxImageBytes: number; budget: DownloadByteBudget },
): Promise<{ src: string; bytes: Buffer }> {
  const response = await fetchProviderResultUrl(url, {
    maxBytes: options.maxImageBytes,
    signal: options.signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const bytes = await readResponseBodyWithLimit(response, {
    maxBytes: options.maxImageBytes,
    aggregateBudget: options.budget,
  });
  if (bytes.byteLength === 0) throw new Error('empty body');
  const mimeType = await imageMimeType(response, bytes);
  if (!mimeType) throw new NotAnImageError();
  return { src: `data:${mimeType};base64,${bytes.toString('base64')}`, bytes };
}

/**
 * `work`, or the abort of `signal` if that comes first: a body that drips or
 * a transport that ignores the signal cannot outlast it.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** A short form of an image URL for the log (no query string: it may carry a signature). */
function loggedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 120);
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * Answer `images` with every remote source replaced by its downloaded bytes
 * as a `data:` URL, and every image that cannot carry its bytes dropped.
 * A downloaded image's `width`/`height` become its real pixel size when the
 * bytes can be read (an extractor's own values may be page coordinates).
 * Images already inline are kept as they are.
 */
export async function inlineRemoteImages<
  T extends { id: string; src: string; width?: number; height?: number },
>(images: readonly T[], options: InlineImagesOptions = {}): Promise<InlinedImages<T>> {
  const maxImages = options.maxImages ?? MAX_DERIVED_IMAGES;
  const maxImageBytes = options.maxImageBytes ?? MAX_REMOTE_IMAGE_BYTES;
  const budget = new DownloadByteBudget(options.maxTotalBytes ?? MAX_REMOTE_IMAGE_BATCH_BYTES);
  const concurrency = Math.max(1, options.concurrency ?? INLINE_IMAGE_CONCURRENCY);
  const perImageTimeoutMs = options.perImageTimeoutMs ?? INLINE_IMAGE_TIMEOUT_MS;
  const signal = options.signal;
  // The byte budget is spent: nothing more can be stored.
  const spent = new AbortController();
  const stops = [signal, options.deadline, spent.signal].filter(
    (entry): entry is AbortSignal => !!entry,
  );
  const stopped = AbortSignal.any(stops);
  const spend = () => {
    if (!spent.signal.aborted) spent.abort(new Error('image byte budget spent'));
  };

  const results: Array<T | null> = images.map((image) =>
    isInlineImageSource(image.src) ? image : null,
  );
  const remote: Array<{ index: number; url: string }> = [];
  const retryable = new Set<number>();
  images.forEach((image, index) => {
    if (results[index]) return;
    const url = remoteImageUrl(image.src);
    if (url && remote.length < maxImages) remote.push({ index, url });
    else if (url) log.warn(`image ${image.id}: over the ${maxImages}-image limit; dropped`);
    else log.warn(`image ${image.id}: no usable source; dropped`);
  });

  let next = 0;
  const worker = async () => {
    while (next < remote.length) {
      signal?.throwIfAborted();
      if (budget.remainingBytes <= 0) spend();
      // Out of time or out of room: what is left stays out, unrequested.
      if (stopped.aborted) return;
      const { index, url } = remote[next++]!;
      const image = images[index]!;
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new Error(`no answer within ${perImageTimeoutMs} ms`)),
        perImageTimeoutMs,
      );
      timer.unref?.();
      const downloadSignal = AbortSignal.any([stopped, timeout.signal]);
      try {
        const download = downloadAsDataUrl(url, { signal: downloadSignal, maxImageBytes, budget });
        const { src, bytes } = await untilAborted(download, downloadSignal);
        // Read the size only once the download is in: a budget spent by another
        // download meanwhile must not drop an image that already arrived.
        results[index] = { ...image, src, ...(await pixelSize(bytes)) };
        if (budget.remainingBytes <= 0) spend();
      } catch (error) {
        // The caller stopped: not this image's fault.
        signal?.throwIfAborted();
        // It did not fit in what is left: the downloads still running stop too.
        if (error instanceof DownloadSizeLimitError && error.scope === 'aggregate') spend();
        // Too large, or stopped once the budget was spent: the same answer
        // drops it again. Anything else (an error status, a body that is not an
        // image, a transport failure, a timeout, the deadline) may not recur.
        const permanent =
          error instanceof DownloadSizeLimitError ||
          (spent.signal.aborted && !options.deadline?.aborted && !timeout.signal.aborted);
        if (!permanent) retryable.add(index);
        log.warn(
          `image ${image.id}: download of ${loggedUrl(url)} failed; dropped`,
          error instanceof Error ? error.message : error,
        );
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, remote.length) }, worker));
  signal?.throwIfAborted();
  if (next < remote.length) {
    const why = spent.signal.aborted ? 'once the byte budget was spent' : 'before the deadline';
    log.warn(`${remote.length - next} image(s) not requested ${why}; dropped`);
    // Out of room is the same next time; out of time may not be.
    if (!spent.signal.aborted) {
      for (const { index } of remote.slice(next)) retryable.add(index);
    }
  }

  const inlined = results.filter((image): image is T => image !== null);
  return {
    images: inlined,
    skipped: images.length - inlined.length,
    retryable: [...retryable].sort((a, b) => a - b).map((index) => images[index]!.id),
  };
}
