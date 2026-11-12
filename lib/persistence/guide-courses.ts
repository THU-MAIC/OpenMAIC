/**
 * The guide course on the server: one per owner where that is safe, nothing
 * edited, referenced or published lost.
 *
 * Every owner's library gets a copy of the guide course the first time it
 * loads (`lib/workbench/guide-course.ts`), under an id derived from that
 * owner. A visitor who signs in brings the anonymous owner's copy along, and
 * the account may hold a copy of its own already (signed in elsewhere first),
 * or seed one while the claim is landing (the library loads beside the login
 * merge, from a list that does not show the claimed copy yet). Two rules,
 * both in the transactions that could otherwise make a second copy:
 *
 * - {@link refuseSecondGuideCourse}: creating a guide course is refused while
 *   the owner holds another active one. A claim takes the owner's identity
 *   lock exclusively, so a seed that lands after a claim sees the claimed
 *   copy; creates take it shared, so two creates of one owner are serialized
 *   by a per-owner guide lock instead. The seed takes the refusal (403) as
 *   settled and reloads the library, whose list missed the claimed copy.
 * - {@link retireDuplicateGuideCourses}: a claim into an account that holds a
 *   copy (kept or deleted) retires the incoming anonymous copy when it is
 *   spare. The account's copy is never retired.
 *
 * The incoming copy is SPARE when all three hold:
 *
 * - UNTOUCHED: nothing wrote it after the seed. The seed inserts the stage
 *   row and each scene row once, in one save, so the document's revision
 *   counter (`document_stage_revision`, bumped by the storage package's
 *   triggers on every stage and scene write) is exactly one more than its
 *   scene count, and every scene still carries the stage's creation time.
 *   Any later write (a rename, an edited, added or removed scene, an agent
 *   change) breaks one of the two. Opening or learning the course writes no
 *   document row. A copy without a revision row counts as edited.
 * - NOT IN USE: no record the claim carries over names it, neither an agent
 *   session (`agent_sessions.stage_id` or `active_stage_id`, not deleted),
 *   such as a conversation about the course started without editing it, nor
 *   a learner's runtime session (`runtime_sessions.stage_id`: classroom chat,
 *   quiz attempts, whiteboard). The claim moves those records unchanged, so a
 *   retired copy would leave them bound to a course the library no longer
 *   shows.
 * - NOT PUBLIC: `stage_meta.is_public` is false. Publishing writes only
 *   `stage_meta`, so the two checks above do not see it; an anonymous owner
 *   cannot normally publish, and this is the guard if one did.
 *
 * In every other case both copies stay. A second guide course in the library
 * is harmless (the user can delete either), and keeping a copy beats
 * re-pointing the records at the other one: a session's history, its course
 * edits and a learner's runtime records all speak of the copy they were made
 * on.
 *
 * Only copies of the current seed generation count
 * (`./guide-course-id.ts`): a copy of an older generation is an ordinary
 * course, never refused against or retired, so advancing the generation
 * seeds the new course once for everyone.
 *
 * Retiring is the same tombstone a delete writes (`stage_meta.deleted_at`,
 * the folder cleared); the rows stay, and the retired id is never seeded
 * again. An untouched copy names only the guide's static files, never the
 * asset pool, so it has no asset references to withdraw, and a spare one has
 * no session or runtime record left pointing at it.
 */
import { DocumentWriteRefusedError } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  currentGuideCourseIdPattern,
  GUIDE_COURSE_EXISTS,
  isCurrentGuideCourseId,
} from './guide-course-id';

export { GUIDE_COURSE_EXISTS };

/**
 * Refuse the creation of guide course `stageId` for `ownerId` when the owner
 * already holds another active guide course of the current generation. Inside
 * the create transaction, after its identity lock (shared); a per-owner lock
 * serializes two such creates, so they cannot both pass. Any other id,
 * an older generation's included, passes untouched.
 */
export async function refuseSecondGuideCourse(
  tx: Queryable,
  stageId: string,
  ownerId: string,
): Promise<void> {
  if (!isCurrentGuideCourseId(stageId)) return;
  // Held to COMMIT. Taken after the stage-create lock of `stageId`, and only
  // here, so every holder takes the two in the same order.
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('openmaic.guide-course:' || $1, 0))",
    [ownerId],
  );
  const other = await tx.query<{ stage_id: string } & Record<string, unknown>>(
    `SELECT stage_id FROM stage_meta
      WHERE owner_id = $1 AND stage_id ~ $2 AND stage_id <> $3 AND deleted_at IS NULL
      LIMIT 1`,
    [ownerId, currentGuideCourseIdPattern(), stageId],
  );
  if (other.rows.length > 0) {
    throw new DocumentWriteRefusedError(
      stageId,
      GUIDE_COURSE_EXISTS,
      'this library already has the guide course',
    );
  }
}

interface GuideRow extends Record<string, unknown> {
  stage_id: string;
  owner_id: string;
  deleted: boolean;
  untouched: boolean;
  public: boolean;
}

/**
 * Retire the incoming guide course a claim of `from` into `to` would
 * duplicate, when it is spare. Runs before the courses move, so `from`'s
 * copies are still `from`'s. Answers how many copies it retired.
 */
export async function retireDuplicateGuideCourses(
  tx: Queryable,
  from: string,
  to: string,
): Promise<number> {
  const guides = await tx.query<GuideRow>(
    `SELECT meta.stage_id, meta.owner_id, meta.deleted_at IS NOT NULL AS deleted,
            meta.is_public AS public,
            COALESCE(rev.rev = 1 + (SELECT count(*) FROM document_scenes s WHERE s.stage_id = meta.stage_id)
              AND NOT EXISTS (
                SELECT 1 FROM document_scenes s
                 WHERE s.stage_id = meta.stage_id
                   AND (s.data->>'createdAt') IS DISTINCT FROM stages.created_at::bigint::text),
              false) AS untouched
       FROM stage_meta meta
       JOIN document_stages stages ON stages.id = meta.stage_id
       LEFT JOIN document_stage_revision rev ON rev.stage_id = meta.stage_id
      WHERE meta.owner_id IN ($1, $2) AND meta.stage_id ~ $3
      ORDER BY meta.stage_id
      FOR UPDATE OF meta`,
    [from, to, currentGuideCourseIdPattern()],
  );
  if (!guides.rows.some((row) => row.owner_id === to)) return 0;
  const candidates = guides.rows
    .filter((row) => row.owner_id === from && !row.deleted && row.untouched && !row.public)
    .map((row) => row.stage_id);
  const inUse = await stagesInUse(tx, [from, to], candidates);
  const retire = candidates.filter((stageId) => !inUse.has(stageId));
  if (retire.length === 0) return 0;
  await tx.query(
    `UPDATE stage_meta SET deleted_at = CURRENT_TIMESTAMP
      WHERE stage_id = ANY($1::text[]) AND deleted_at IS NULL`,
    [retire],
  );
  await tx.query('UPDATE document_stages SET folder_id = NULL WHERE id = ANY($1::text[])', [
    retire,
  ]);
  return retire.length;
}

/**
 * Which of `stageIds` a record the claim carries over still names: an agent
 * session of `owners` that is not deleted, or a runtime session (of any
 * learner). Either table may not be provisioned yet (both are created
 * lazily), and then names nothing. Reads only: the claim holds both owners'
 * identity locks, which the session and runtime writers take first.
 */
async function stagesInUse(
  tx: Queryable,
  owners: readonly string[],
  stageIds: readonly string[],
): Promise<Set<string>> {
  const inUse = new Set<string>();
  if (stageIds.length === 0) return inUse;
  const present = await tx.query<{ sessions: boolean; runtime: boolean } & Record<string, unknown>>(
    `SELECT to_regclass('agent_sessions') IS NOT NULL AS sessions,
            to_regclass('runtime_sessions') IS NOT NULL AS runtime`,
  );
  const tables = present.rows[0];
  const collect = (rows: Array<{ id: string | null }>) => {
    for (const row of rows) if (row.id) inUse.add(row.id);
  };
  if (tables?.sessions) {
    const named = await tx.query<{ id: string | null } & Record<string, unknown>>(
      `SELECT stage_id AS id FROM agent_sessions
        WHERE owner_id = ANY($2::text[]) AND deleted_at IS NULL AND stage_id = ANY($1::text[])
       UNION
       SELECT active_stage_id FROM agent_sessions
        WHERE owner_id = ANY($2::text[]) AND deleted_at IS NULL
          AND active_stage_id = ANY($1::text[])`,
      [[...stageIds], [...owners]],
    );
    collect(named.rows);
  }
  if (tables?.runtime) {
    const named = await tx.query<{ id: string | null } & Record<string, unknown>>(
      'SELECT DISTINCT stage_id AS id FROM runtime_sessions WHERE stage_id = ANY($1::text[])',
      [[...stageIds]],
    );
    collect(named.rows);
  }
  return inUse;
}
