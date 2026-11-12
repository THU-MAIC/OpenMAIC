/**
 * The guide course on the server: at most one per owner, nothing edited lost.
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
 *   the owner holds another active one. Creates and claims of an owner are
 *   serialized by its identity lock, so a seed that lands after a claim sees
 *   the claimed copy; the seed takes the refusal (403) as settled and reloads
 *   the library, whose list missed the claimed copy.
 * - {@link retireDuplicateGuideCourses}: a claim between two owners that both
 *   hold a copy keeps one, never retiring an edited copy.
 *
 * A copy is UNTOUCHED when nothing wrote it after the seed: the seed inserts
 * the stage row and each scene row once, in one save, so the document's
 * revision counter (`document_stage_revision`, bumped by the storage
 * package's triggers on every stage and scene write) is exactly one more than
 * its scene count, and every scene still carries the stage's creation time.
 * Any later write (a rename, an edited, added or removed scene, an agent
 * change) breaks one of the two. Opening or learning the course writes no
 * document row. A copy without a revision row counts as edited.
 *
 * The rule, when the account holds a guide course (kept or deleted):
 *
 * - an untouched anonymous copy is retired: the account has its own, or
 *   deleted it, and the visitor never changed theirs;
 * - an edited anonymous copy stays, and then the account's untouched copies
 *   are retired instead, so the edited one is the account's guide course;
 * - both edited: both stay. Edited work is never retired.
 *
 * Only copies of the current seed generation count
 * (`./guide-course-id.ts`): a copy of an older generation is an ordinary
 * course, never refused against, retired or kept in place of a new one, so
 * advancing the generation seeds the new course once for everyone.
 *
 * Retiring is the same tombstone a delete writes (`stage_meta.deleted_at`,
 * the folder cleared); the rows stay, and the retired id is never seeded
 * again. An untouched copy names only the guide's static files, never the
 * asset pool, so it has no asset references to withdraw.
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
 * the create transaction, after its identity lock. Any other id, an older
 * generation's included, passes untouched.
 */
export async function refuseSecondGuideCourse(
  tx: Queryable,
  stageId: string,
  ownerId: string,
): Promise<void> {
  if (!isCurrentGuideCourseId(stageId)) return;
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
}

/**
 * Retire the duplicate guide courses a claim of `from` into `to` would leave.
 * Runs before the courses move, so `from`'s copies are still `from`'s. Answers
 * how many copies it retired.
 */
export async function retireDuplicateGuideCourses(
  tx: Queryable,
  from: string,
  to: string,
): Promise<number> {
  const guides = await tx.query<GuideRow>(
    `SELECT meta.stage_id, meta.owner_id, meta.deleted_at IS NOT NULL AS deleted,
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
  const incoming = guides.rows.filter((row) => row.owner_id === from && !row.deleted);
  const account = guides.rows.filter((row) => row.owner_id === to);
  if (incoming.length === 0 || account.length === 0) return 0;

  const retire = incoming.filter((row) => row.untouched).map((row) => row.stage_id);
  if (incoming.some((row) => !row.untouched)) {
    // An edited copy arrives: it becomes the guide course, and the account's
    // untouched copies make way for it.
    retire.push(
      ...account.filter((row) => !row.deleted && row.untouched).map((row) => row.stage_id),
    );
  }
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
