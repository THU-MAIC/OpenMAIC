/**
 * Inline base64 image converter (RFC #1153 part 4).
 *
 * Pre-part-2 documents carry source-document images as inline base64 data URLs
 * in `PPTImageElement.src` (written by `resolveImageIds` before the
 * id-addressed mode existed) — the same image on five slides is stored five
 * times, and every document load/save moves those bytes through the document
 * store instead of the byte layer. This module is a lazy converter in the
 * #1101 mold: given a loaded document it rewrites every inline `data:image/*`
 * slot value into a pool-backed allocated asset id, ingesting each unique
 * image exactly once per pass (memoized by sha256 of the decoded bytes, so
 * identical base64 on N slides collapses to ONE registry entry referenced N
 * times).
 *
 * No DSL version bump: the slot's type already admits both shapes — data URLs
 * are concrete addresses, allocated ids resolve through the pool (part 2
 * established this) — so an unconverted document remains fully valid and the
 * converter is a pure slimming pass over documents the id-addressed mode
 * predates.
 *
 * Conversion rules, per reference:
 *
 * - Only `data:image/*` values convert. Every other shape (allocated ids,
 *   `gen_*` placeholders, http(s), classroom-media transport URLs) is left
 *   untouched — the #1101 converter owns those.
 * - Payload decoding follows the fetch spec's data-URL grammar: the body is
 *   base64 exactly when the mediatype ends with `;` + zero or more SPACE +
 *   an ASCII case-insensitive `base64` (the marker must be the FINAL
 *   parameter). The converter is CONSERVATIVE by design — when the grammar
 *   is anything but unambiguous it leaves the slot inline (`kept`) and never
 *   guesses a decode path. A non-final `;base64` is not a broken image: the
 *   browser still renders it (it percent-decodes the body and ignores the
 *   stray parameter), so the slot stays inline because this converter never
 *   guesses a decode path, not because the image is broken. The other kept
 *   shapes have concrete reasons: zero decoded bytes are not an image, and a
 *   payload whose ESTIMATED DECODED size exceeds the 50 MB decode bound is
 *   pathological, not the target corpus.
 * - One allocation per unique decoded content, shared across every slot that
 *   names identical bytes. Two different encodings of the same bytes (base64
 *   vs percent-encoded, different MIME casing) also collapse: the memo key is
 *   the digest of the DECODED bytes.
 * - The rewritten slot holds the allocated id; the bytes live in the pool
 *   under that id, and a Dexie `mediaFiles` compatibility row is mirrored
 *   under the compound key (the part-2 double-write discipline), so stage
 *   deletion reclaims converted images and export resolves them exactly like
 *   part-2's id-addressed images. The original data URL is retained on
 *   `placeholderRef` for reload reconciliation, like #1101 does.
 * - Budgeted and partial-safe: an aggregate wall-clock budget bounds the pass
 *   (the 15 s constant family — the same family the ingest path uses). When
 *   it expires, the conversions made so far are kept and the rest stay inline;
 *   idempotency makes the partial progress safe — the next open continues.
 * - Bounded concurrency: whiteboard slides convert through the part-1
 *   `mapWithConcurrency` at batch 4, so the decoded buffers of N slides never
 *   coexist.
 * - A failed ingest (undecodable value, pool failure, compatibility-write
 *   failure) leaves that slot inline and releases what the failed attempt
 *   allocated, then continues with the next slot. Allocations a caller ends
 *   up discarding are released through the shared ledger/rollback accounting
 *   (the same `rollbackConvertedAllocations` the #1101 pass uses).
 * - A content digest that is unavailable (a non-secure context or older
 *   webview lacks `crypto.subtle`) degrades the whole pass to a no-op: the
 *   document is returned unchanged and every inline slot is kept, with one
 *   warn — a load that succeeded before this converter existed must keep
 *   succeeding. A digest that fails mid-run on one image keeps that slot
 *   inline and continues, exactly like a failed ingest.
 *
 * Idempotent: a converted document holds pool-backed allocated ids and no
 * `data:image/*` values, so re-running is a no-op that returns the input by
 * identity.
 *
 * The pure DSL migration ladder deliberately does none of this: it cannot
 * decode local bytes. It covers only documents this converter never reached.
 */

import type { AssetMeta, Slide, Whiteboard } from '@openmaic/dsl';
import { createLogger } from '@/lib/logger';
import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';
import { DEFAULT_INGEST_AWAIT_TIMEOUT_MS } from '@/lib/document/extract-source';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import type { AppScene, Stage } from '@/lib/types/stage';
import { makeScene } from '@/lib/types/stage';
import type { MediaFileRecord } from '@/lib/utils/database';
import { mapWithConcurrency } from '@/lib/utils/concurrency';
import { slideMediaReferenceSlots } from './slide-media-slots';

const log = createLogger('InlineImageConversion');

/**
 * Aggregate wall-clock budget for one inline-image conversion pass. The
 * budget family is the ingest path's 15 s constant: a pass must not hold the
 * document lock for an unbounded decoding/ingest run on a document full of
 * heavy base64 payloads. What does not convert within the budget stays inline
 * and converts on a later open.
 */
export const INLINE_IMAGE_CONVERSION_BUDGET_MS = DEFAULT_INGEST_AWAIT_TIMEOUT_MS;

/**
 * Concurrency bound for converting whiteboard slides (the part-1
 * `mapWithConcurrency` batch): at most this many slides decode/ingest at
 * once, so the decoded buffers of N slides never coexist.
 */
export const INLINE_IMAGE_SLIDE_CONCURRENCY = 4;

/**
 * Per-payload decode bound, in DECODED BYTES: an inline data URL whose
 * payload would decode past the shared 50 MB extract cap
 * (`MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES`) is pathological, not the target
 * corpus. It is kept inline WITHOUT decoding — the gate is a pre-decode size
 * ESTIMATE — so an oversized payload never allocates multi-megabyte decode
 * buffers. The same constant bounds the extract route's accepted bytes, so
 * the converter's keep/convert decision and the generation route's
 * accept/reject decision agree on the same quantity.
 */
export const MAX_INLINE_IMAGE_DECODED_BYTES = MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES;

/** Whether a slide media slot value is an inline image data URL — the only shape this converter rewrites. */
export function isInlineImageDataUrl(ref: string | undefined): ref is string {
  return !!ref && /^data:image\//i.test(ref);
}

/** Decoded payload of an inline image data URL. */
export interface DecodedInlineImage {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
}

/** Parsed parts of an inline image data URL (the fetch-spec mediatype split). */
interface ParsedInlineImageDataUrl {
  mimeType: string;
  params: string;
  payload: string;
}

/** Split an inline image data URL into its mediatype parts and raw payload text. */
function parseInlineImageDataUrl(src: string): ParsedInlineImageDataUrl | null {
  const match = /^data:image\/([^;,]+)(?:;([^,]*))?,([\s\S]*)$/i.exec(src);
  if (!match) return null;
  return {
    mimeType: `image/${match[1].toLowerCase()}`,
    params: match[2] ?? '',
    payload: match[3] ?? '',
  };
}

/**
 * Estimated DECODED size of an inline image data URL's payload, computed
 * before any decoding work so an oversized payload is kept without
 * allocating decode buffers. A base64 payload scales the text length by 3/4
 * (each quartet encodes three bytes; trailing padding encodes none and is
 * excluded). A percent-encoded payload uses the raw text length as a safe
 * upper bound (every `%XX` triple decodes to one byte). Returns `null` when
 * the value is not an inline image data URL.
 */
export function estimateInlineImageDecodedBytes(src: string): number | null {
  const parsed = parseInlineImageDataUrl(src);
  if (!parsed) return null;
  const mediatype = parsed.params ? `${parsed.mimeType};${parsed.params}` : parsed.mimeType;
  if (/; *base64$/i.test(mediatype)) {
    const padding = /=+$/.exec(parsed.payload)?.[0].length ?? 0;
    return Math.floor(((parsed.payload.length - padding) * 3) / 4);
  }
  return parsed.payload.length;
}

/**
 * Decode a `data:image/*` URL to bytes. Handles both base64 payloads and
 * percent-encoded (UTF-8) payloads; returns `null` when the value is not
 * decodable, so a malformed value stays inline and retries on a later open
 * instead of being lost or allocated as garbage.
 *
 * The base64 marker follows the fetch spec's data-URL grammar: the body is
 * base64 exactly when the mediatype ends with `;` + zero or more SPACE + an
 * ASCII case-insensitive `base64`. The marker must be the FINAL parameter —
 * a `;base64` anywhere else is not a marker. Such a value is conservatively
 * kept even though the browser still renders it (it percent-decodes the body
 * and ignores the stray parameter): this converter slims data URLs it can
 * decode unambiguously and never guesses a decode path — the slot stays
 * inline because the marker is ambiguous, not because the image is broken.
 */
export function decodeInlineImageDataUrl(src: string): DecodedInlineImage | null {
  const parsed = parseInlineImageDataUrl(src);
  if (!parsed) return null;
  const { mimeType, params, payload } = parsed;
  try {
    const mediatype = params ? `${mimeType};${params}` : mimeType;
    // Fetch-spec marker (case-insensitive, space-tolerant, FINAL parameter).
    const isBase64Payload = /; *base64$/i.test(mediatype);
    // A `;base64` token that is not the final parameter is not a marker: keep
    // the slot inline rather than decoding on a guess.
    const hasStrayBase64Token = !isBase64Payload && /;\s*base64/i.test(mediatype);
    if (hasStrayBase64Token) return null;
    if (isBase64Payload) {
      // Base64 payload: atob yields one binary character per byte. Whitespace
      // is legal inside base64 data URLs (line-wrapped payloads) and must be
      // stripped before decoding.
      const binary = atob(payload.replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return { bytes, mimeType };
    }
    // Percent-encoded payload (commonly UTF-8 SVG). TextEncoder re-encodes
    // the decoded string to its exact UTF-8 bytes, so the digest covers the
    // true byte content and two encodings of one image collapse.
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mimeType };
  } catch {
    return null;
  }
}

export interface InlineImageConversionDeps {
  /** Ingest decoded bytes into the asset pool; resolves to the allocated asset id. */
  putAsset(blob: Blob, meta: AssetMeta): Promise<string>;
  /** Remove an allocation nothing references (the failed-attempt release). */
  removeAsset(ref: string): Promise<void>;
  /**
   * Write the post-conversion Dexie compatibility copy, keyed by the id the
   * document now names — the part-2 double-write discipline that makes stage
   * deletion reclaim the pool entry and export/import resolve it like any
   * id-addressed image.
   */
  putMediaRecord(stageId: string, ref: string, record: MediaFileRecord): Promise<void>;
  /**
   * Content digest of the decoded bytes — the within-run memo key. Defaults
   * to sha256; injectable so tests can pin what is hashed.
   */
  digest(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
}

/** Thrown when the caller's liveness check fails mid-conversion (the classroom fetch path). */
export class InlineImageConversionAbortedError extends Error {
  override readonly name = 'InlineImageConversionAbortedError';
  constructor(readonly allocatedIds: readonly string[]) {
    super('inline image conversion aborted');
  }
}

export interface InlineImageConversionReport {
  /** Slots rewritten to an allocated pool asset id. */
  converted: number;
  /** Unique images ingested this pass (dedup collapses repeated base64). */
  ingested: number;
  /** Inline slots left untouched for a later open (budget expiry or failed ingest). */
  kept: number;
}

export interface InlineImageConversionResult {
  document: AppDocument;
  /** False when nothing was rewritten — the input is returned by identity. */
  changed: boolean;
  report: InlineImageConversionReport;
  /**
   * Ids this pass freshly allocated. A caller that ends up rejecting the
   * converted document (a superseded classroom load) rolls these back through
   * the shared `rollbackConvertedAllocations` accounting.
   */
  allocatedIds: string[];
}

/** The default production wiring: the browser-wide asset pool plus Dexie. */
async function defaultDeps(): Promise<InlineImageConversionDeps> {
  const [{ db, mediaFileKey }, { putAsset, removeAsset }] = await Promise.all([
    import('@/lib/utils/database'),
    import('./asset-pool'),
  ]);
  return {
    putAsset: (blob, meta) => putAsset(blob, meta),
    removeAsset: (ref) => removeAsset(ref),
    putMediaRecord: (stageId, ref, record) =>
      db.mediaFiles
        .put({ ...record, id: mediaFileKey(stageId, ref), stageId })
        .then(() => undefined),
    digest: async (bytes) => {
      const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
    },
  };
}

function imageMeta(blob: Blob): AssetMeta {
  return {
    contentType: blob.type || 'image/png',
    mediaType: 'image',
    origin: 'inline-data-url',
  };
}

function compatRecord(stageId: string, assetId: string, blob: Blob, src: string): MediaFileRecord {
  return {
    id: `${stageId}:${assetId}`,
    stageId,
    type: 'image',
    blob,
    mimeType: blob.type || 'image/png',
    size: blob.size,
    prompt: '',
    params: '{}',
    placeholderRef: src,
    createdAt: Date.now(),
  };
}

type SlideLike = Pick<Slide, 'background' | 'elements'>;

/**
 * Convert every inline `data:image/*` slot value in a loaded document to an
 * allocated asset id. The input document is never mutated; the side effects
 * are pool ingests and Dexie compatibility mirror writes.
 *
 * Crash-safety ordering mirrors the generation write paths and #1101: pool
 * bytes first, the Dexie compatibility copy second, and the in-memory
 * document rewrite last, so a failure mid-conversion never leaves the
 * persisted document pointing at bytes that were never stored.
 */
export async function convertInlineImageAssets(
  document: AppDocument,
  deps?: InlineImageConversionDeps,
  shouldContinue?: () => boolean,
  ledger?: string[],
): Promise<InlineImageConversionResult> {
  const resolvedDeps = deps ?? (await defaultDeps());
  const stageId = document.stage.id;
  const budgetEndsAt = Date.now() + INLINE_IMAGE_CONVERSION_BUDGET_MS;
  const withinBudget = (): boolean => Date.now() <= budgetEndsAt;
  /**
   * Ids this pass freshly allocated. A caller may share the array to own the
   * rollback itself: any failure path — liveness abort or a discarded result
   * — then still compensates what the pass committed.
   */
  const allocatedIds = ledger ?? [];
  // Liveness probe for callers whose own work can be superseded mid-flight (a
  // classroom load): a stale conversion must stop producing side effects as
  // soon as its result is known to be unwanted.
  const assertContinuing = (): void => {
    if (shouldContinue && !shouldContinue()) {
      throw new InlineImageConversionAbortedError(allocatedIds);
    }
  };
  // One allocation per unique DECODED content, shared across every slot that
  // names identical bytes. The map holds the in-flight promise, not just the
  // settled value: whiteboard slides convert concurrently, and caching only
  // completed allocations would let two slides naming one image each allocate
  // their own asset.
  const allocationByDigest = new Map<string, Promise<string | null>>();
  const report: InlineImageConversionReport = { converted: 0, ingested: 0, kept: 0 };
  let changed = false;
  // Oversized payloads are counted per pass and reported with ONE aggregate
  // warn (the old per-payload warn repeated on every open of a document that
  // keeps them).
  let oversizedPayloads = 0;

  /**
   * Probe whether a content digest can be computed at all. `crypto.subtle` —
   * and so the default sha-256 digest — exists only in secure contexts;
   * non-secure contexts and older webviews lack it. Without a digest the
   * within-run memo cannot be computed, so the pass degrades to a no-op (the
   * document is returned unchanged and every inline slot is kept) instead of
   * throwing where a pre-part-4 load succeeded. Probed lazily on the first
   * inline slot; one warn covers the whole pass.
   */
  let digestProbed = false;
  let digestUnavailable = false;
  const ensureDigestAvailable = async (): Promise<boolean> => {
    if (digestProbed) return !digestUnavailable;
    digestProbed = true;
    try {
      await resolvedDeps.digest(new Uint8Array(0));
      return true;
    } catch {
      digestUnavailable = true;
      log.warn(
        `Content digest unavailable for ${JSON.stringify(stageId)} (non-secure context or ` +
          'older webview); keeping inline images inline for a later open',
      );
      return false;
    }
  };

  /**
   * Allocate (once) for a content digest. Returns the allocated id, or `null`
   * when the ingest failed — the slot then stays inline. A failed attempt
   * forgets the digest's memo entry — so a sibling slot naming the same
   * bytes can retry rather than inheriting the failure forever — and
   * releases anything the attempt allocated (a failed pool write allocated
   * nothing; a failed mirror write releases the just-allocated id).
   */
  const allocateImage = (digest: string, blob: Blob, src: string): Promise<string | null> => {
    const inFlight = allocationByDigest.get(digest);
    if (inFlight) return inFlight;
    const pending = (async (): Promise<string | null> => {
      let assetId: string | null = null;
      try {
        // The pool write is inside the guarded region too: a transient pool
        // error must clear the memo entry exactly like a mirror-write
        // failure, so the NEXT slot naming the same bytes retries instead of
        // inheriting the rejected promise for the rest of the pass.
        assetId = await resolvedDeps.putAsset(blob, imageMeta(blob));
        allocatedIds.push(assetId);
        // Liveness is rechecked at the commit boundary: an abort between the
        // allocation and its mirror compensates the allocation, exactly like
        // a mirror-write failure.
        assertContinuing();
        await resolvedDeps.putMediaRecord(
          stageId,
          assetId,
          compatRecord(stageId, assetId, blob, src),
        );
      } catch (error) {
        // Do not strand a memo entry (or an allocation) nothing references.
        allocationByDigest.delete(digest);
        if (assetId !== null) {
          await resolvedDeps.removeAsset(assetId).catch(() => undefined);
        }
        throw error;
      }
      report.ingested += 1;
      return assetId;
    })();
    allocationByDigest.set(digest, pending);
    return pending;
  };

  const convertSlide = async <T extends SlideLike>(slide: T): Promise<T> => {
    assertContinuing();
    const slots = [...slideMediaReferenceSlots(slide)];
    const rewrites: Array<{ index: number; assetId: string }> = [];
    let budgetExhausted = false;
    for (let index = 0; index < slots.length; index += 1) {
      // Budget expiry mid-run keeps the conversions made so far and leaves
      // the rest inline: the next open continues from here (idempotency makes
      // the partial progress safe). Once expired, every remaining inline
      // value is counted as kept rather than converted.
      if (!withinBudget()) budgetExhausted = true;
      const ref = slots[index].read();
      if (!isInlineImageDataUrl(ref)) continue;
      if (budgetExhausted) {
        report.kept += 1;
        continue;
      }
      // Per-payload decode bound, measured in DECODED bytes: a data URL whose
      // payload would decode past the shared 50 MB cap is pathological, not
      // the target corpus. The gate is a pre-decode size ESTIMATE — the
      // decoder is never invoked for it — so an oversized payload never
      // allocates multi-megabyte decode buffers.
      const estimatedDecodedBytes = estimateInlineImageDecodedBytes(ref);
      if (
        estimatedDecodedBytes !== null &&
        estimatedDecodedBytes > MAX_INLINE_IMAGE_DECODED_BYTES
      ) {
        oversizedPayloads += 1;
        report.kept += 1;
        continue;
      }
      if (!(await ensureDigestAvailable())) {
        report.kept += 1;
        continue;
      }
      const decoded = decodeInlineImageDataUrl(ref);
      if (!decoded || decoded.bytes.length === 0) {
        // Undecodable values, and payloads that decode to zero bytes (an
        // empty data URL), are not usable bytes: keep the slot inline,
        // allocate nothing, mirror no row.
        report.kept += 1;
        continue;
      }
      let assetId: string | null = null;
      try {
        const digest = await resolvedDeps.digest(decoded.bytes);
        assetId = await allocateImage(
          digest,
          new Blob([decoded.bytes], { type: decoded.mimeType }),
          ref,
        );
      } catch (error) {
        if (error instanceof InlineImageConversionAbortedError) {
          // A superseded pass stops NOW: the abort is not a per-slot failure —
          // digesting/allocating the remaining slots would defeat the
          // liveness probe's purpose.
          throw error;
        }
        // A failed digest or ingest leaves the slot inline; a failed attempt
        // released what it allocated. Continue with the next slot — one
        // hiccup must not stop the rest of the pass.
        assetId = null;
      }
      if (!assetId) {
        report.kept += 1;
        continue;
      }
      rewrites.push({ index, assetId });
      report.converted += 1;
    }
    if (rewrites.length === 0) return slide;
    // Rewrite on a clone so the caller's document is never mutated. Slot
    // iteration order is deterministic, so the clone's slots align by index.
    const clone = structuredClone(slide);
    const cloneSlots = [...slideMediaReferenceSlots(clone)];
    for (const { index, assetId } of rewrites) cloneSlots[index].write(assetId);
    changed = true;
    return clone;
  };

  const stage = document.stage;
  let whiteboard = stage.whiteboard;
  if (whiteboard) {
    // Bounded concurrency (batch 4): decoded buffers for at most
    // INLINE_IMAGE_SLIDE_CONCURRENCY slides coexist at once.
    const converted = await mapWithConcurrency(
      whiteboard,
      INLINE_IMAGE_SLIDE_CONCURRENCY,
      (slide) => convertSlide(slide),
    );
    if (converted.some((slide, index) => slide !== undefined && slide !== whiteboard![index])) {
      whiteboard = converted.filter((slide): slide is Whiteboard => slide !== undefined);
    }
  }

  const scenes: AppScene[] = [];
  for (const scene of document.scenes) {
    let nextScene = scene;
    if (scene.content.type === 'slide') {
      const canvas = await convertSlide(scene.content.canvas);
      if (canvas !== scene.content.canvas) {
        // Rebuild through makeScene so the discriminated union stays bound:
        // a plain spread cannot prove the canvas lands on the slide member.
        const { type: _type, content: _content, ...core } = nextScene;
        void _type;
        void _content;
        nextScene = makeScene(core, { ...scene.content, canvas });
      }
    }
    if (scene.whiteboards) {
      const converted = await mapWithConcurrency(
        scene.whiteboards,
        INLINE_IMAGE_SLIDE_CONCURRENCY,
        (slide) => convertSlide(slide),
      );
      if (
        converted.some((slide, index) => slide !== undefined && slide !== scene.whiteboards![index])
      ) {
        nextScene = {
          ...nextScene,
          whiteboards: converted.filter((slide): slide is Slide => slide !== undefined),
        };
      }
    }
    scenes.push(nextScene);
  }

  // One aggregate warn per pass for oversized payloads — the kept payloads
  // never convert, so a per-payload warn would repeat on every open. A later
  // open re-warns only while oversized payloads actually remain.
  if (oversizedPayloads > 0) {
    log.warn(
      `Skipping ${oversizedPayloads} oversized inline image payload` +
        `${oversizedPayloads === 1 ? '' : 's'} for ${JSON.stringify(stageId)} ` +
        `(estimated decoded bytes > ${MAX_INLINE_IMAGE_DECODED_BYTES}); keeping them inline`,
    );
  }

  if (!changed) return { document, changed: false, report, allocatedIds };

  const nextStage: Stage = whiteboard !== stage.whiteboard ? { ...stage, whiteboard } : stage;

  log.info(
    `Converted inline base64 images for ${stageId}: ${report.converted} slots rewritten, ` +
      `${report.ingested} unique images ingested, ${report.kept} left inline`,
  );
  return {
    document: { ...document, stage: nextStage, scenes },
    changed: true,
    report,
    allocatedIds,
  };
}
