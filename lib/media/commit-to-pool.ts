'use client';

/**
 * The one client-side sequence that turns bytes into something a shared
 * document may name.
 *
 * Three paths reach the asset pool from this browser — the media generation
 * pass, narration adoption, and fresh TTS synthesis — and all three run the
 * same four steps in the same order: store the bytes at the pool seam, write
 * the allocated id back into the document, mirror the bytes locally under that
 * id, and decide what a refusal means. The first three steps were already
 * spelled the same way at each caller. The fourth was not, and that is what
 * this module exists to fix: the media pass kept the bytes a full store
 * refused, adoption had nothing to keep because the bytes were already local,
 * and fresh TTS threw them away — re-billing the provider on every later
 * attempt for audio this browser had already paid for. Fixing that in place
 * would have made a fourth variant, so the sequence and its refusal rule live
 * here instead.
 *
 * What this owns:
 *
 * - The pool write, through `putAsset` and therefore through its stage seam.
 * - The classification of a failure as "the store had no room for THIS write"
 *   versus anything else. It was written twice before, once per caller, under
 *   slightly different conditions.
 * - The retention rule: a room refusal must leave the bytes in this browser's
 *   local table under the key the retry path looks for, so that a later attempt
 *   re-uploads them instead of buying them again. Callers whose bytes are
 *   already there (adoption reads the very row it would write) pass no `retain`
 *   and say so.
 * - The order of the remaining steps, and which of them may fail the commit. A
 *   reference reaches the document only after the pool answered with an id, and
 *   the local mirror is written only after the write-back, so the document can
 *   never name bytes that were not stored and the cache can never outlive a
 *   write-back that did not happen. The mirror itself is best-effort here
 *   rather than at each caller: by then the bytes are stored and the document
 *   names them, so a cache write costs a re-download at worst.
 *
 * What this deliberately does NOT own:
 *
 * - The store-full marker. Clearing it lives inside `putAsset`'s stage seam and
 *   nowhere else, so a successful write retires the course's "no room" note in
 *   one place rather than one per caller; and *setting* it is a claim that
 *   calling a provider for this course is a waste of money, which only the
 *   paths that spend provider money may make. Adoption spends none, so it must
 *   not write the marker — a fact several review rounds re-established. This
 *   module therefore neither reads nor writes it.
 * - The write-back funnel and the local table. Generated media and narration
 *   carry different references in different document shapes and mirror into
 *   different tables, and each already has exactly one funnel
 *   (`persistGeneratedMediaReference`, `persistNarrationReference`). Inventing a
 *   third would be the opposite of this change, so the funnel and the mirror are
 *   supplied by the caller and merely sequenced here.
 */
import type { AssetMeta } from '@openmaic/dsl';

import { createLogger } from '@/lib/logger';
import { putAsset } from '@/lib/media/asset-pool';
import { ASSET_QUOTA_EXCEEDED, isStorageFullFailure } from '@/lib/media/media-failure';

const log = createLogger('PoolCommit');

/**
 * Bytes a full store refused, handed back so nothing has to be bought twice.
 *
 * The caller gets them whether or not it supplied a `retain` sink: the media
 * pass carries them out to the failure record it writes around them, which is
 * the row that is also the only copy a pre-server-backed course has of its own
 * media.
 */
export interface RefusedPoolBytes {
  /** The key the retry path looks for these bytes under. */
  readonly slot: string;
  readonly bytes: Blob;
  readonly mimeType: string;
  /** The pool's own error, for the caller's record and log. */
  readonly error: unknown;
}

/**
 * What one commit settled as.
 *
 * `refused-retained` is returned only once the bytes are somewhere a later
 * attempt can find them, which is what makes the name true rather than a hope.
 * Neither refusal outcome throws: a refusal is an answer, and every caller has
 * a different thing to do with it.
 */
export type PoolCommitOutcome<TPlacement> =
  | {
      readonly status: 'stored';
      readonly assetId: string;
      /** Whatever the caller's write-back reported. */
      readonly placement: TPlacement;
    }
  | {
      readonly status: 'refused-retained';
      readonly code: typeof ASSET_QUOTA_EXCEEDED;
      readonly error: unknown;
      readonly refused: RefusedPoolBytes;
    }
  | { readonly status: 'failed'; readonly error: unknown };

export interface PoolCommitPlan<TPlacement> {
  /**
   * The course these bytes belong to.
   *
   * Handed to the pool seam, which is where a write that goes through retires
   * this course's "no room" note. Optional only because one caller (fresh TTS
   * outside a course) genuinely has no course to retire it for.
   */
  readonly stageId?: string;
  /**
   * The placeholder or derived key this element's bytes are known by locally.
   *
   * `gen_img_3` for a generation placeholder, `tts_s2_action_…` for a narration
   * key. It is not sent to the pool; it is the address a retained refusal is
   * kept under and the address a later attempt reads back.
   */
  readonly slot: string;
  readonly bytes: Blob;
  readonly mimeType: string;
  /** Extra asset metadata, e.g. `durationSeconds` for audio. */
  readonly meta?: Readonly<Omit<AssetMeta, 'contentType'>>;
  /**
   * Keep the bytes under `slot`, so a later attempt re-uploads rather than
   * re-synthesizes. Called on a room refusal and only then.
   *
   * Omitted by a caller whose bytes are already under `slot` in its own table —
   * adoption reads exactly the row it would write — and by a caller carrying
   * them out to a record it writes itself. A caller that omits it is stating
   * that the bytes survive the refusal, not that they do not matter.
   *
   * A sink that cannot keep the bytes must REJECT rather than swallow: the
   * commit then reports `failed`, not `refused-retained`. That is the whole
   * value of the outcome's name — a caller reading `refused-retained` goes on
   * to stamp `slot` into something durable, and a stamp naming bytes no local
   * table holds is a reference that resolves to nothing for the rest of the
   * course's life.
   */
  readonly retain?: (refused: RefusedPoolBytes) => Promise<void>;
  /**
   * Write the allocated id into the document through this reference family's
   * existing funnel, and report whatever the caller needs to know afterwards.
   *
   * Errors are the caller's: they propagate out of `commitToPool` untouched,
   * because a write-back failure carries information (whether the allocation
   * was retained) that only the caller can act on.
   */
  readonly writeBack: (assetId: string) => Promise<TPlacement>;
  /**
   * Mirror the bytes locally under the allocated id.
   *
   * Best-effort, and enforced here rather than left to each caller's own
   * `catch`: by this point the bytes are in the pool and the document already
   * names them, so a cache write that fails costs a re-download and nothing
   * else. A commit must not be reported as failed over it.
   */
  readonly mirror: (assetId: string, placement: TPlacement) => Promise<void>;
}

/**
 * Whether this failure is the store saying it had no room for these bytes.
 *
 * The refusal reaches this browser as the asset client's error, whose `code` is
 * the one the storage contract puts in the 507 response body. Matching on the
 * code rather than on the client's error class is deliberate: the class is not
 * always the one this bundle imported, while the code is the part of the
 * contract that crosses every boundary.
 *
 * `errorCode` — the field the generation routes' own error class carries — is
 * deliberately not read. That class is raised by the image and video API calls
 * and never by a pool write, so accepting its shape here would widen this
 * predicate past anything `putAsset` can throw, on a field whose values come
 * from a different contract.
 */
function poolRefusedForRoom(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && isStorageFullFailure(code);
}

/**
 * Store bytes in the pool and point the document at them.
 *
 * Returns rather than throws for every refusal shape; a write-back that fails
 * still throws, for the reason given on `writeBack`. A mirror that fails does
 * neither: the commit already happened.
 */
export async function commitToPool<TPlacement>(
  plan: PoolCommitPlan<TPlacement>,
): Promise<PoolCommitOutcome<TPlacement>> {
  let assetId: string;
  try {
    assetId = await putAsset(
      plan.bytes,
      { contentType: plan.mimeType, ...plan.meta },
      // The stage goes to the seam, which is the one place a successful write
      // retires this course's "no room" note. A write-back that fails for its
      // own reasons afterwards therefore does not leave the course standing
      // down.
      { ...(plan.stageId ? { stageId: plan.stageId } : {}) },
    );
  } catch (error) {
    if (!poolRefusedForRoom(error)) return { status: 'failed', error };
    const refused: RefusedPoolBytes = {
      slot: plan.slot,
      bytes: plan.bytes,
      mimeType: plan.mimeType,
      error,
    };
    // Awaited before the outcome is reported, so `refused-retained` is a
    // statement about what is on disk rather than about what was scheduled --
    // and a sink that could not keep the bytes demotes the outcome, so no
    // caller stamps a key nothing can be read back by.
    if (plan.retain) {
      try {
        await plan.retain(refused);
      } catch (retentionError) {
        log.warn(`Could not keep the bytes refused for ${plan.slot}:`, retentionError);
        return { status: 'failed', error: retentionError };
      }
    }
    return { status: 'refused-retained', code: ASSET_QUOTA_EXCEEDED, error, refused };
  }

  const placement = await plan.writeBack(assetId);
  try {
    await plan.mirror(assetId, placement);
  } catch (error) {
    // The bytes are stored and the document names them. A cache this browser
    // could not write costs a re-download, never the media, so the commit is
    // still a commit.
    log.warn(`Local mirror failed for ${assetId}:`, error);
  }
  return { status: 'stored', assetId, placement };
}
