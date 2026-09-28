/**
 * The course library a host {@link LibraryProvider} chooses, as list items.
 *
 * The provider returns ids; this module turns them into the `DocumentSummary`
 * items `GET /api/stages` has always returned. It is also the access rule:
 * only an id the document read path would serve is listed -- one with an
 * ownership row that is not tombstoned (see `decideDocumentAccess` and the
 * owner-bound store's read gate) -- so a provider cannot surface a course
 * that `GET /api/stages/{id}` would refuse. What a provider may hand out
 * beyond that (reads are capability-by-id) is the host's decision.
 */
import type { DocumentSummary } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';

import { isQueryableSegment } from '@/lib/persistence/document-access';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import type { LibraryProvider } from '@/lib/server/persistence-hooks/types';

/**
 * The most ids one listing may name. `GET /api/stages` is unpaginated, and the
 * ids travel as one query parameter, so an unbounded provider answer is a
 * memory problem rather than a library. A provider over the limit is a host
 * bug and answers `500`.
 */
export const MAX_LIBRARY_STAGE_IDS = 5000;

interface LibraryRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  interactive_mode: boolean | null;
  task_engine_mode: boolean | null;
  created_at: number | string;
  updated_at: number | string;
  folder_id: string | null;
  scene_count: string;
}

/**
 * Summaries of the listable courses among `stageIds`, in the given order with
 * duplicates dropped. `folderId` is kept only for `ownerId`'s own courses.
 */
export async function summarizeLibraryStages(
  queryable: Queryable,
  ownerId: string,
  stageIds: readonly string[],
): Promise<DocumentSummary[]> {
  // An id the read path cannot address (empty, `.`, `..`, NUL, a lone
  // surrogate) is refused there, so it is not listed here either -- and never
  // reaches the query, where some of them would be a database error.
  const ordered = [...new Set(stageIds)].filter(isQueryableSegment);
  if (ordered.length === 0) return [];
  const result = await queryable.query<LibraryRow>(
    `SELECT stages.id,
            stages.name,
            stages.description,
            stages.interactive_mode,
            stages.task_engine_mode,
            stages.created_at,
            stages.updated_at,
            CASE WHEN meta.owner_id = $2 THEN stages.folder_id END AS folder_id,
            (SELECT COUNT(*) FROM document_scenes AS scenes
              WHERE scenes.stage_id = stages.id)::text AS scene_count
       FROM document_stages AS stages
       JOIN stage_meta AS meta ON meta.stage_id = stages.id
      WHERE stages.id = ANY($1::text[])
        AND meta.deleted_at IS NULL`,
    [ordered, ownerId],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const summaries: DocumentSummary[] = [];
  for (const id of ordered) {
    const row = byId.get(id);
    if (!row) continue;
    summaries.push({
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      ...(row.interactive_mode === null ? {} : { interactiveMode: row.interactive_mode }),
      ...(row.task_engine_mode === null ? {} : { taskEngineMode: row.task_engine_mode }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      sceneCount: Number(row.scene_count),
      ...(row.folder_id === null ? {} : { folderId: row.folder_id }),
    });
  }
  return summaries;
}

/** Ask the provider, check its answer, and summarize what may be listed. */
export async function listLibraryStages(options: {
  provider: LibraryProvider;
  principal: OwnerPrincipal;
  queryable: Queryable;
  ownedStageIds: () => Promise<string[]>;
}): Promise<DocumentSummary[]> {
  const { provider, principal, queryable } = options;
  const ids: unknown = await provider.list({
    principal,
    queryable,
    ownedStageIds: options.ownedStageIds,
  });
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    // A host bug: surfaces as a 500 rather than a silently partial library.
    throw new Error(`Library provider ${provider.name} must resolve an array of stage ids`);
  }
  if (ids.length > MAX_LIBRARY_STAGE_IDS) {
    throw new Error(
      `Library provider ${provider.name} returned ${ids.length} stage ids; the limit is ${MAX_LIBRARY_STAGE_IDS}`,
    );
  }
  return summarizeLibraryStages(queryable, principal.ownerId, ids as string[]);
}
