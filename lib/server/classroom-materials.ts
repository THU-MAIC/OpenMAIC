/**
 * Uploaded materials for `POST /api/generate-classroom`.
 *
 * A caller uploads each file with `POST /api/materials` (the owner-scoped
 * material library) and passes the returned ids as `materialIds`. The route
 * checks the selection up front ({@link resolveClassroomMaterials}); the generation job then
 * reads each upload's bytes, extracts it through the shared server-managed
 * extractor registry, and bundles the texts — in the order given — exactly as
 * classic browser generation bundles several course documents.
 */
import {
  buildDocumentBundle,
  MAX_DOCUMENT_BUNDLE_FILES,
  MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES,
  type ParsedDocumentPart,
} from '@/lib/document/bundle';
import {
  getReadyOwnerMaterials,
  type OwnerMaterialRecord,
} from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { resolveExtractableMimeTypes } from '@/lib/server/material-extraction/availability';
import { extractMaterialSource } from '@/lib/server/material-extraction/extract';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';

/**
 * At most as many materials, and at most as many bytes in total, as classic
 * browser generation accepts course documents for one classroom: the combined
 * text shares one prompt budget.
 */
export const MAX_CLASSROOM_MATERIALS = MAX_DOCUMENT_BUNDLE_FILES;
export const MAX_CLASSROOM_MATERIAL_TOTAL_BYTES = MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES;

/** A `materialIds` selection that cannot be generated from; the message is caller-facing. */
export class ClassroomMaterialsRejectedError extends Error {
  override readonly name: string = 'ClassroomMaterialsRejectedError';
}

/**
 * One or more requested materials do not resolve to a ready upload of the
 * request owner. Missing, foreign, unfinished and deleted ids are deliberately
 * indistinguishable (no existence oracle).
 */
export class ClassroomMaterialsUnavailableError extends ClassroomMaterialsRejectedError {
  override readonly name = 'ClassroomMaterialsUnavailableError';

  constructor() {
    super('One or more materials are unavailable');
  }
}

/**
 * Resolve the owner's ready uploads for `materialIds`, in the given order, and
 * check that this server can generate from them: every id resolves for the
 * owner, every material's type has an extractor available here, and the total
 * size stays within the bundle cap. The route runs this at submit time so a
 * job never fails late for these reasons; the job runs it again because the
 * configuration or the library may change in between.
 */
export async function resolveClassroomMaterials(
  ownerId: string,
  materialIds: readonly string[],
  /** False for a request's own owner, which must not follow a claim. */
  { forward = true }: { forward?: boolean } = {},
): Promise<OwnerMaterialRecord[]> {
  if (materialIds.length === 0) return [];
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const found = await getReadyOwnerMaterials(pool, ownerId, materialIds);
  const byId = new Map(found.map((record) => [record.id, record]));
  const records = materialIds.map((id) => {
    const record = byId.get(id);
    if (!record) throw new ClassroomMaterialsUnavailableError();
    return record;
  });

  const extractable = await resolveExtractableMimeTypes({ ownerId, forward });
  if (records.some((record) => !record.mime || !extractable.has(record.mime.toLowerCase()))) {
    throw new ClassroomMaterialsRejectedError(
      'One or more materials have a type this server cannot extract; see GET /api/generate-classroom/capabilities',
    );
  }
  const totalBytes = records.reduce((sum, record) => sum + record.bytes, 0);
  if (totalBytes > MAX_CLASSROOM_MATERIAL_TOTAL_BYTES) {
    throw new ClassroomMaterialsRejectedError(
      `Materials exceed the ${MAX_CLASSROOM_MATERIAL_TOTAL_BYTES}-byte total for one classroom`,
    );
  }
  return records;
}

/**
 * Extract the owner's materials and bundle their texts into the source-document
 * context the outline and scene stages consume. Extraction failures, and a
 * material that yields no text, fail the job rather than silently generating
 * without the caller's material. Images from extraction are not carried: the
 * server pipeline consumes text only.
 */
export async function loadClassroomMaterialText(
  ownerId: string,
  materialIds: readonly string[],
): Promise<string | undefined> {
  const records = await resolveClassroomMaterials(ownerId, materialIds);
  if (records.length === 0) return undefined;
  const byteStore = getMaterialByteStore();
  const parts: ParsedDocumentPart[] = [];
  for (const [order, record] of records.entries()) {
    const name = record.originalName ?? record.id;
    let bytes: Buffer;
    try {
      bytes = await byteStore.get(record.ossKey);
    } catch {
      throw new ClassroomMaterialsUnavailableError();
    }
    const extraction = await extractMaterialSource(
      {
        bytes,
        mime: record.mime ?? 'application/octet-stream',
        fileName: name,
      },
      { ownerId },
    );
    if (!extraction.text.trim()) {
      throw new Error(`Material "${name}" produced no extractable text`);
    }
    parts.push({
      source: {
        id: record.id,
        name,
        size: record.bytes,
        ...(record.mime ? { mimeType: record.mime } : {}),
        order,
      },
      text: extraction.text,
      rawTextLength: extraction.text.length,
      ...(extraction.kind === 'document' && extraction.artifact.metadata.pageCount !== undefined
        ? { pageCount: extraction.artifact.metadata.pageCount }
        : {}),
      images: [],
    });
  }
  return buildDocumentBundle(parts).text;
}
