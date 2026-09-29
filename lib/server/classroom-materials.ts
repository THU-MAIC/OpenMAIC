/**
 * Uploaded materials for `POST /api/generate-classroom`.
 *
 * A caller uploads each file with `POST /api/materials` (the owner-scoped
 * material library) and passes the returned ids as `materialIds`. The route
 * checks the ids against the request owner up front; the generation job then
 * reads each upload's bytes, extracts it through the shared server-managed
 * extractor registry, and bundles the texts — in the order given — exactly as
 * classic browser generation bundles several course documents.
 */
import {
  buildDocumentBundle,
  MAX_DOCUMENT_BUNDLE_FILES,
  type ParsedDocumentPart,
} from '@/lib/document/bundle';
import {
  getReadyOwnerMaterials,
  type OwnerMaterialRecord,
} from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { extractMaterialSource } from '@/lib/server/material-extraction/extract';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';

/**
 * At most as many materials as classic browser generation accepts course
 * documents for one classroom: the combined text shares one prompt budget.
 */
export const MAX_CLASSROOM_MATERIALS = MAX_DOCUMENT_BUNDLE_FILES;

/**
 * One or more requested materials do not resolve to a ready upload of the
 * request owner. Missing, foreign, unfinished and deleted ids are deliberately
 * indistinguishable (no existence oracle).
 */
export class ClassroomMaterialsUnavailableError extends Error {
  override readonly name = 'ClassroomMaterialsUnavailableError';

  constructor() {
    super('One or more materials are unavailable');
  }
}

/** Resolve the owner's ready uploads for `materialIds`, in the given order. */
export async function resolveClassroomMaterials(
  ownerId: string,
  materialIds: readonly string[],
): Promise<OwnerMaterialRecord[]> {
  if (materialIds.length === 0) return [];
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new ClassroomMaterialsUnavailableError();
  const { pool } = await getServerPersistenceProvider(connectionString);
  const records = await getReadyOwnerMaterials(pool, ownerId, materialIds);
  const byId = new Map(records.map((record) => [record.id, record]));
  return materialIds.map((id) => {
    const record = byId.get(id);
    if (!record) throw new ClassroomMaterialsUnavailableError();
    return record;
  });
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
    const extraction = await extractMaterialSource({
      bytes,
      mime: record.mime ?? 'application/octet-stream',
      fileName: name,
    });
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
