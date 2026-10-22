import { createHash } from 'node:crypto';
import type { OwnerMaterialExtraction } from '@/lib/persistence/owner-materials';
import { readMaterialExtractionResult } from './extraction';
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
 * Parsing and projecting the read bytes happen after the transaction commits.
 */
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import type { OwnerExtractionResult } from '@/lib/persistence/owner-material-extraction';
import { forwardOwnerWrite } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { resolveDerivativeRefsAsync } from '@/lib/server/material-extraction/document-images';

/** A source's extracted text at one revision. */
export interface OwnerMaterialText {
  text: string;
  revision: string;
}

/** What the caller read of the source: its id, its owner then, and its result then. */
export interface OwnerMaterialTextLocation {
  id: string;
  extraction?: OwnerMaterialExtraction | null;
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
async function textOf(
  bytes: Uint8Array,
  result: Pick<OwnerExtractionResult, 'revision' | 'text' | 'derivatives'>,
  ownerId: string,
  byteRevision: number,
  signal?: AbortSignal,
): Promise<OwnerMaterialText> {
  const cacheKey = JSON.stringify([ownerId, result.text.assetId, result.revision, byteRevision]);
  return {
    text: await resolveDerivativeRefsAsync(
      Buffer.from(bytes).toString('utf8'),
      result.derivatives ?? [],
      cacheKey,
      result.text.imageRefs,
      signal,
    ),
    revision: result.revision,
  };
}

async function readClassicText(
  location: Pick<OwnerMaterialTextLocation, 'id' | 'extraction'>,
): Promise<OwnerMaterialText | null> {
  if (location.extraction?.status !== 'ready' || !location.extraction.resultKey) return null;
  try {
    const result = await readMaterialExtractionResult({
      id: location.id,
      extraction: location.extraction,
    });
    return {
      text: result.text,
      // Each attempt has an immutable result key; never expose that private key.
      revision: createHash('sha256')
        .update(JSON.stringify([location.id, location.extraction.resultKey]))
        .digest('hex'),
    };
  } catch {
    return null;
  }
}

async function readOnce(
  location: OwnerMaterialTextLocation,
  signal?: AbortSignal,
): Promise<OwnerMaterialText | null> {
  const result = location.extractionResult;
  if (!result) return readClassicText(location);
  try {
    const read = await (
      await provider()
    ).assetStore.resolve(assetPrincipalForOwner(location.ownerId), result.text.assetId);
    return read ? await textOf(read.bytes, result, location.ownerId, read.revision, signal) : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    // Retried under the fence.
    return null;
  }
}

/** The re-read and its pool read failed: the transaction rolls back, nothing is returned. */
class FencedTextReadFailed extends Error {}

interface ReadTextBytes {
  bytes: Uint8Array;
  result: Pick<OwnerExtractionResult, 'revision' | 'text' | 'derivatives'>;
  ownerId: string;
  byteRevision: number;
}

async function rereadUnderFence(
  location: OwnerMaterialTextLocation,
): Promise<ReadTextBytes | OwnerMaterialText | null> {
  const persistence = await provider();
  try {
    return await persistence.withTransaction(async (tx) => {
      await forwardOwnerWrite(tx, location.ownerId);
      const found = await tx.query<{
        owner_id: string;
        deleted_at: number | string | null;
        extraction_result: OwnerExtractionResult | null;
        extraction: OwnerMaterialExtraction | null;
      }>(
        'SELECT owner_id, deleted_at, extraction_result, extraction FROM owner_material WHERE id = $1',
        [location.id],
      );
      const row = found.rows[0];
      const result = row?.extraction_result;
      if (!row || row.deleted_at !== null) return null;
      if (!result) return readClassicText({ id: location.id, extraction: row.extraction });
      try {
        const read = await persistence
          .assetStoreIn(tx)
          .resolve(assetPrincipalForOwner(row.owner_id), result.text.assetId);
        return read
          ? { bytes: read.bytes, result, ownerId: row.owner_id, byteRevision: read.revision }
          : null;
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
  signal?: AbortSignal,
): Promise<OwnerMaterialText | null> {
  if (signal?.aborted) throw new Error('aborted');
  const first = await readOnce(location, signal);
  if (first) return first;
  if (signal?.aborted) throw new Error('aborted');
  const read = await rereadUnderFence(location);
  if (!read) return null;
  if ('text' in read) return read;
  // The forwarded fence protects the row and byte read, not the parser. The
  // transaction has committed before a legacy parse can wait on its worker.
  try {
    return await textOf(read.bytes, read.result, read.ownerId, read.byteRevision, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
