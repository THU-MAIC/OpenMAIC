/**
 * Read a source's extracted text: the latest successful extraction, with the
 * revision it was published at.
 *
 * The text is not an owner material of its own. It is a pool entry the
 * source's `extraction_result` names (`text.assetId`), under the owner's
 * partition and rooted by the source. So `readOwnerMaterialBytes`, which
 * reads a row's own `asset_id`, cannot read it, and a claim re-keys the entry
 * to the account just as it does a source's original.
 *
 * ## One result, one read
 *
 * The text, its revision and the derivatives its image references resolve to
 * (`openmaic-derivative:<key>` becomes `material:<derivative id>`, see
 * `lib/server/material-extraction/document-images.ts`) always come from the
 * same `extraction_result`:
 * a caller never pairs a revision read earlier with text read later, or a
 * page boundary checked against one revision could hand out text of another.
 *
 * ## One re-read, under the owner's fence
 *
 * As `./owner-material-bytes.ts` does for originals: the first read uses the
 * result and owner the caller holds. When that read finds nothing or throws,
 * the row is re-read and the entry it names now is read in one transaction
 * that first takes the record owner's forwarded write fence, so a claim
 * cannot move the row and its entry between the two reads. The re-read may
 * find a newer result; the text and revision returned are that result's.
 */
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import type { OwnerExtractionResult } from '@/lib/persistence/owner-material-extraction';
import { forwardOwnerWrite } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { resolveDerivativeRefs } from '@/lib/server/material-extraction/document-images';

/** A source's extracted text at one revision. */
export interface OwnerMaterialText {
  text: string;
  revision: string;
}

/** What the caller read of the source: its id, its owner then, and its result then. */
export interface OwnerMaterialTextLocation {
  id: string;
  ownerId: string;
  extractionResult: Pick<OwnerExtractionResult, 'revision' | 'text' | 'derivatives'> | null;
}

async function provider() {
  return getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
}

/**
 * The text as this source's reader sees it: its image references name this
 * source's own derivatives, from the same result as the revision.
 */
function textOf(
  bytes: Uint8Array,
  result: Pick<OwnerExtractionResult, 'revision' | 'derivatives'>,
): OwnerMaterialText {
  return {
    text: resolveDerivativeRefs(Buffer.from(bytes).toString('utf8'), result.derivatives ?? []),
    revision: result.revision,
  };
}

async function readOnce(location: OwnerMaterialTextLocation): Promise<OwnerMaterialText | null> {
  const result = location.extractionResult;
  if (!result) return null;
  try {
    const read = await (
      await provider()
    ).assetStore.resolve(assetPrincipalForOwner(location.ownerId), result.text.assetId);
    return read ? textOf(read.bytes, result) : null;
  } catch {
    // Retried under the fence.
    return null;
  }
}

/** The re-read and its pool read failed: the transaction rolls back, nothing is returned. */
class FencedTextReadFailed extends Error {}

async function rereadUnderFence(
  location: OwnerMaterialTextLocation,
): Promise<OwnerMaterialText | null> {
  const persistence = await provider();
  try {
    return await persistence.withTransaction(async (tx) => {
      await forwardOwnerWrite(tx, location.ownerId);
      const found = await tx.query<{
        owner_id: string;
        deleted_at: number | string | null;
        extraction_result: OwnerExtractionResult | null;
      }>('SELECT owner_id, deleted_at, extraction_result FROM owner_material WHERE id = $1', [
        location.id,
      ]);
      const row = found.rows[0];
      const result = row?.extraction_result;
      if (!row || row.deleted_at !== null || !result) return null;
      try {
        const read = await persistence
          .assetStoreIn(tx)
          .resolve(assetPrincipalForOwner(row.owner_id), result.text.assetId);
        return read ? textOf(read.bytes, result) : null;
      } catch (error) {
        // Out of the transaction, so it rolls back rather than ending aborted.
        throw new FencedTextReadFailed('pool read failed', { cause: error });
      }
    });
  } catch (error) {
    if (error instanceof FencedTextReadFailed) return null;
    throw error;
  }
}

/**
 * The source's latest extracted text and its revision, or `null` when it has
 * no successful extraction or its text cannot be read. The caller decides
 * beforehand that the source is one it may read (live, the right owner,
 * attached or in scope); this reads, it does not authorize -- except that a
 * re-read finding the source deleted answers `null`.
 */
export async function readOwnerMaterialText(
  location: OwnerMaterialTextLocation,
): Promise<OwnerMaterialText | null> {
  const first = await readOnce(location);
  if (first) return first;
  return rereadUnderFence(location);
}
