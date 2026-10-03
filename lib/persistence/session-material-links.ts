/**
 * Which library materials a conversation has attached (RFC #1716 §4).
 *
 * Before Phase 2, sending a library material copied its bytes into the
 * session's byte prefix and minted a session row (`agent_session_materials`).
 * An attachment is now a link: one `(session_id, material_id)` row naming an
 * owner material by its own id. Nothing is copied, and every reader resolves
 * the id against the owner's row as it is now -- its extraction, its
 * derivatives, whether it was deleted.
 *
 * ## No owner on the link
 *
 * A link records no owner. A claim moves a session (`agent-sessions`) and its
 * owner's materials (`owner-materials`) in one transaction and keeps both
 * ids, so a link stays valid across a claim with no participant of its own.
 * Every read joins the session's owner now to the material's owner now and
 * answers nothing when they differ.
 *
 * ## What a link reaches
 *
 * A link names a source. Through it the session reaches that source and the
 * source's media derivatives (`derived_from`), as long as the source is
 * ready and not deleted; a derivative is never attached on its own. A
 * deleted source answers nothing even while its bytes are still in the pool
 * within the grace period.
 *
 * ## Copies made before links
 *
 * A session that already holds a copy of a material -- a row whose
 * `owner_material_id` is the material, or one the pre-upgrade binder keyed on
 * the material id itself -- keeps reading that copy: attaching the material
 * again reuses the copy instead of adding a link, so the conversation never
 * lists the same file twice under two ids. Copies are never migrated.
 */
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';

import type { OwnerExtractionResult } from './owner-material-extraction';
import {
  OWNER_MATERIAL_COLUMNS,
  ownerMaterialRowToRecord,
  type OwnerMaterialRecord,
  type RawOwnerMaterialRow,
} from './owner-materials';
import { forwardOwnerWrite } from './owner-merges';

/**
 * The link table. It references `agent_sessions` and is provisioned after the
 * session-material schema, which needs that table too. Deleting a session
 * row removes its links; soft-deleting one leaves them, and every read joins
 * a live session.
 */
export const SESSION_MATERIAL_LINK_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_session_material_links (
  session_id  TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL,
  created_at  DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (session_id, material_id)
);
`;

export async function ensureSessionMaterialLinkSchema(queryable: Queryable): Promise<void> {
  await queryable.query(SESSION_MATERIAL_LINK_SCHEMA.trim());
}

/** An owner material with the library columns readers need beyond the record. */
export interface OwnerMaterialEntry extends OwnerMaterialRecord {
  folderId: string | null;
  displayName: string | null;
  /** Why the latest extraction failed, while the status is `failed`. */
  extractionError: string | null;
  /** The latest successful extraction of a source; `null` before the first. */
  extractionResult: OwnerExtractionResult | null;
  /**
   * For a derivative, where in its source it came from, as its source's
   * result records it; `null` for a source or when the extractor said nothing.
   */
  lineage: { pageNumber?: number; timeMs?: number } | null;
}

interface RawOwnerMaterialEntryRow extends RawOwnerMaterialRow {
  folder_id: string | null;
  display_name: string | null;
  extraction_error: string | null;
  extraction_result: unknown;
  derivative_lineage: { pageNumber?: unknown; timeMs?: unknown } | null;
}

/**
 * The entry columns, every one qualified by `alias`. A derivative's page and
 * time live in its source's result, so they are read from there whatever
 * else the query returns.
 */
function entryColumns(alias: string): string {
  const columns = [
    ...OWNER_MATERIAL_COLUMNS.split(',').map((column) => column.trim()),
    'folder_id',
    'display_name',
    'extraction_error',
    'extraction_result',
  ].map((column) => `${alias}.${column}`);
  columns.push(`(SELECT jsonb_build_object('pageNumber', recorded->'pageNumber',
                                         'timeMs', recorded->'timeMs')
       FROM owner_material AS lineage_source,
            jsonb_array_elements(
              COALESCE(lineage_source.extraction_result->'derivatives', '[]'::jsonb)
            ) AS recorded
      WHERE lineage_source.id = ${alias}.derived_from AND recorded->>'id' = ${alias}.id
      LIMIT 1) AS derivative_lineage`);
  return columns.join(', ');
}

function lineageOf(
  raw: RawOwnerMaterialEntryRow['derivative_lineage'],
): OwnerMaterialEntry['lineage'] {
  if (!raw) return null;
  const lineage: { pageNumber?: number; timeMs?: number } = {};
  if (typeof raw.pageNumber === 'number') lineage.pageNumber = raw.pageNumber;
  if (typeof raw.timeMs === 'number') lineage.timeMs = raw.timeMs;
  return Object.keys(lineage).length > 0 ? lineage : null;
}

export function ownerMaterialEntryOf(row: RawOwnerMaterialEntryRow): OwnerMaterialEntry {
  return {
    ...ownerMaterialRowToRecord(row),
    folderId: row.folder_id,
    displayName: row.display_name,
    extractionError: row.extraction_error,
    extractionResult: (row.extraction_result ?? null) as OwnerExtractionResult | null,
    lineage: lineageOf(row.derivative_lineage),
  };
}

/**
 * The live sources a session links, with their owner: the session must be
 * live and the source its owner's now, ready and not deleted.
 */
const LINKED_SOURCES = `
  SELECT source.id, source.owner_id, link.created_at AS linked_at
    FROM agent_session_material_links AS link
    JOIN agent_sessions AS session
      ON session.id = link.session_id AND session.deleted_at IS NULL
    JOIN owner_material AS source
      ON source.id = link.material_id AND source.owner_id = session.owner_id
   WHERE link.session_id = $1
     AND source.kind = 'source' AND source.status = 'ready' AND source.deleted_at IS NULL`;

/** Each linked source and its live derivatives (`linked` is {@link LINKED_SOURCES}). */
const LINKED_MATERIALS = `
  SELECT ${entryColumns('material')}, linked.linked_at
    FROM linked
    JOIN owner_material AS material
      ON material.id = linked.id
      OR (material.derived_from = linked.id AND material.owner_id = linked.owner_id
          AND material.status = 'ready' AND material.deleted_at IS NULL)`;

/**
 * Every material a session reaches through its links: each linked source,
 * then its derivatives, in the order the sources were attached.
 */
export async function listLinkedOwnerMaterials(
  queryable: Queryable,
  sessionId: string,
): Promise<OwnerMaterialEntry[]> {
  const result = await queryable.query<RawOwnerMaterialEntryRow>(
    `WITH linked AS (${LINKED_SOURCES})
     ${LINKED_MATERIALS}
     ORDER BY linked.linked_at, linked.id, material.derived_from NULLS FIRST,
              material.created_at, material.id`,
    [sessionId],
  );
  return result.rows.map(ownerMaterialEntryOf);
}

/** One material the session reaches through a link, or `null`. */
export async function getLinkedOwnerMaterial(
  queryable: Queryable,
  sessionId: string,
  materialId: string,
): Promise<OwnerMaterialEntry | null> {
  const result = await queryable.query<RawOwnerMaterialEntryRow>(
    `WITH linked AS (${LINKED_SOURCES})
     ${LINKED_MATERIALS}
     WHERE material.id = $2
     LIMIT 1`,
    [sessionId, materialId],
  );
  return result.rows[0] ? ownerMaterialEntryOf(result.rows[0]) : null;
}

/**
 * One live material of the session's owner, attached or not -- what library
 * scope reaches. A derivative answers only while its source is live too.
 */
export async function getSessionOwnerMaterial(
  queryable: Queryable,
  sessionId: string,
  materialId: string,
): Promise<OwnerMaterialEntry | null> {
  const result = await queryable.query<RawOwnerMaterialEntryRow>(
    `SELECT ${entryColumns('material')}
       FROM agent_sessions AS session
       JOIN owner_material AS material ON material.owner_id = session.owner_id
       LEFT JOIN owner_material AS source ON source.id = material.derived_from
      WHERE session.id = $1 AND session.deleted_at IS NULL AND material.id = $2
        AND material.status = 'ready' AND material.deleted_at IS NULL
        AND (material.derived_from IS NULL
          OR (source.owner_id = material.owner_id AND source.status = 'ready'
              AND source.deleted_at IS NULL))
      LIMIT 1`,
    [sessionId, materialId],
  );
  return result.rows[0] ? ownerMaterialEntryOf(result.rows[0]) : null;
}

export interface OwnerLibraryListOptions {
  /** Omitted: every folder. `null`: Unfiled only. A string: that folder only. */
  folderId?: string | null;
  /** Case-insensitive literal text in the name, original filename or MIME type. */
  query?: string;
  /** Only sources with a successful extraction: the materials search can read. */
  withTextOnly?: boolean;
  /** Only sources: what a conversation can attach (a derivative comes with its source). */
  sourcesOnly?: boolean;
  /** Keyset cursor: list only materials after this id in the listing's order. */
  before?: string;
  /** Default 100, at most 200. */
  limit?: number;
}

/** `%`, `_` and `\` taken literally in a LIKE pattern. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * The session owner's live library, newest first: sources and their live
 * derivatives, attached or not. A derivative is listed only while its source
 * is live, and is filed with it. `folderId` distinguishes omitted (every
 * folder) from `null` (Unfiled).
 */
export async function listSessionOwnerLibrary(
  queryable: Queryable,
  sessionId: string,
  options: OwnerLibraryListOptions = {},
): Promise<OwnerMaterialEntry[]> {
  return listLibrary(queryable, { sessionId }, options);
}

/** {@link listSessionOwnerLibrary} for an owner directly: what the library page lists. */
export async function listOwnerLibrary(
  queryable: Queryable,
  ownerId: string,
  options: OwnerLibraryListOptions = {},
): Promise<OwnerMaterialEntry[]> {
  return listLibrary(queryable, { ownerId }, options);
}

async function listLibrary(
  queryable: Queryable,
  of: { sessionId: string } | { ownerId: string },
  options: OwnerLibraryListOptions,
): Promise<OwnerMaterialEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 200);
  // `owner` is the owner whose library is listed: the session's owner now,
  // or the owner given.
  const bySession = 'sessionId' in of;
  const params: unknown[] = [bySession ? of.sessionId : of.ownerId];
  const owner = bySession ? 'session.owner_id' : '$1';
  const where: string[] = [];
  if (options.folderId === null) {
    where.push('material.folder_id IS NULL');
  } else if (options.folderId !== undefined) {
    params.push(options.folderId);
    where.push(`material.folder_id = $${params.length}`);
  }
  if (options.query) {
    params.push(`%${likeLiteral(options.query)}%`);
    const p = `$${params.length}`;
    where.push(
      `(COALESCE(material.display_name, '') ILIKE ${p} ESCAPE '\\'
        OR COALESCE(material.original_name, '') ILIKE ${p} ESCAPE '\\'
        OR COALESCE(material.mime, '') ILIKE ${p} ESCAPE '\\')`,
    );
  }
  if (options.withTextOnly) {
    where.push(`material.kind = 'source' AND material.extraction_result IS NOT NULL`);
  }
  if (options.sourcesOnly) where.push(`material.kind = 'source'`);
  if (options.before !== undefined) {
    params.push(options.before);
    const p = `$${params.length}`;
    where.push(`(material.created_at, material.id) < (
        SELECT cursor.created_at, cursor.id FROM owner_material AS cursor
         WHERE cursor.id = ${p} AND cursor.owner_id = ${owner})`);
  }
  params.push(limit);
  const result = await queryable.query<RawOwnerMaterialEntryRow>(
    `SELECT ${entryColumns('material')}
       FROM ${
         bySession
           ? `agent_sessions AS session
       JOIN owner_material AS material ON material.owner_id = session.owner_id`
           : 'owner_material AS material'
       }
       LEFT JOIN owner_material AS source ON source.id = material.derived_from
      WHERE ${bySession ? 'session.id = $1 AND session.deleted_at IS NULL' : 'material.owner_id = $1'}
        AND material.status = 'ready' AND material.deleted_at IS NULL
        AND (material.derived_from IS NULL
          OR (source.owner_id = material.owner_id AND source.status = 'ready'
              AND source.deleted_at IS NULL))
        ${where.map((condition) => `AND ${condition}`).join('\n        ')}
      ORDER BY material.created_at DESC, material.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(ownerMaterialEntryOf);
}

/**
 * Which of `materialIds` the session has attached: sources its links name and
 * their derivatives, and sources it holds a copy of -- a copy row that names
 * the source, or one the pre-upgrade binder keyed on the source id. A copy
 * reaches only its source: its derivatives are the copy's own session rows.
 */
export async function attachedMaterialIds(
  queryable: Queryable,
  sessionId: string,
  materialIds: readonly string[],
): Promise<Set<string>> {
  if (materialIds.length === 0) return new Set();
  const result = await queryable.query<{ id: string }>(
    `WITH linked AS (${LINKED_SOURCES})
     SELECT material.id
       FROM linked
       JOIN owner_material AS material
         ON material.id = linked.id OR material.derived_from = linked.id
      WHERE material.id = ANY($2::text[])
     UNION
     SELECT COALESCE(copy.owner_material_id, copy.id) AS id
       FROM agent_session_materials AS copy
       JOIN agent_sessions AS session
         ON session.id = copy.session_id AND session.deleted_at IS NULL
      WHERE copy.session_id = $1
        AND (copy.owner_material_id = ANY($2::text[])
          OR (copy.owner_material_id IS NULL AND copy.id = ANY($2::text[])))`,
    [sessionId, [...materialIds]],
  );
  return new Set(result.rows.map((row) => row.id));
}

/** One attached material: the id the conversation knows it by, and its owner row. */
export interface AttachedOwnerMaterial {
  /** The owner material id for a link; the copy's own id for an existing copy. */
  materialId: string;
  /** `link`: attached by id. `copy`: the session already held a copy, which it keeps reading. */
  attachment: 'link' | 'copy';
  record: OwnerMaterialRecord;
}

export type AttachOwnerMaterialsOutcome =
  | { status: 'attached'; materials: AttachedOwnerMaterial[] }
  | { status: 'session_missing' }
  | { status: 'unavailable' };

/**
 * Attach library sources to a session by id, idempotently.
 *
 * One transaction: the owner's write fence, forwarded (an attachment rides on
 * the session's own write, which follows a claim; the route refuses a retired
 * owner before it gets here), then the session, which must be live and the
 * owner's, then the sources, each of which must be the owner's ready,
 * undeleted source -- locked `FOR SHARE` so a deletion cannot commit between
 * the check and the link. A derivative or another owner's material makes the
 * whole call `unavailable`, and nothing is attached.
 *
 * A source the session already holds a copy of keeps that copy (see the
 * module docstring); every other source gets one link, and a link that
 * exists already is left as it is. The result follows `materialIds`, without
 * repeats.
 */
export async function attachOwnerMaterialsToSession(
  persistence: { withTransaction: WithTransaction },
  input: { sessionId: string; ownerId: string; materialIds: readonly string[] },
  now: number = Date.now(),
): Promise<AttachOwnerMaterialsOutcome> {
  const ids = [...new Set(input.materialIds)];
  return persistence.withTransaction(async (tx) => {
    const ownerId = await forwardOwnerWrite(tx, input.ownerId);
    const session = await tx.query<{ owner_id: string }>(
      'SELECT owner_id FROM agent_sessions WHERE id = $1 AND deleted_at IS NULL',
      [input.sessionId],
    );
    if (session.rows[0]?.owner_id !== ownerId) return { status: 'session_missing' as const };
    if (ids.length === 0) return { status: 'attached' as const, materials: [] };

    const sources = await tx.query<RawOwnerMaterialRow>(
      `SELECT ${OWNER_MATERIAL_COLUMNS}
         FROM owner_material
        WHERE id = ANY($1::text[]) AND owner_id = $2 AND kind = 'source'
          AND status = 'ready' AND deleted_at IS NULL
        ORDER BY id
          FOR SHARE`,
      [ids, ownerId],
    );
    if (sources.rows.length !== ids.length) return { status: 'unavailable' as const };
    const byId = new Map(sources.rows.map((row) => [row.id, ownerMaterialRowToRecord(row)]));

    // The session's copies of these sources: rows that name the source, or
    // that the pre-upgrade binder keyed on the source id itself.
    const copies = await tx.query<{ id: string; owner_material_id: string | null }>(
      `SELECT id, owner_material_id
         FROM agent_session_materials
        WHERE session_id = $1
          AND (owner_material_id = ANY($2::text[]) OR id = ANY($2::text[]))`,
      [input.sessionId, ids],
    );
    const copyOf = new Map<string, string>();
    for (const row of copies.rows) {
      if (row.owner_material_id !== null) copyOf.set(row.owner_material_id, row.id);
    }
    for (const row of copies.rows) {
      if (row.owner_material_id === null && !copyOf.has(row.id)) copyOf.set(row.id, row.id);
    }

    const toLink = ids.filter((id) => !copyOf.has(id));
    if (toLink.length > 0) {
      await tx.query(
        `INSERT INTO agent_session_material_links (session_id, material_id, created_at)
         SELECT $1, material_id, $3 FROM unnest($2::text[]) AS material_id
         ON CONFLICT (session_id, material_id) DO NOTHING`,
        [input.sessionId, toLink, now],
      );
    }
    return {
      status: 'attached' as const,
      materials: ids.map((id) => {
        const copy = copyOf.get(id);
        return copy === undefined
          ? { materialId: id, attachment: 'link' as const, record: byId.get(id)! }
          : { materialId: copy, attachment: 'copy' as const, record: byId.get(id)! };
      }),
    };
  });
}
