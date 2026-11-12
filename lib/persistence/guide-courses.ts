/**
 * The guide course on the server: no second copy created in a library that
 * already holds one.
 *
 * Every owner's library gets a copy of the guide course the first time it
 * loads (`lib/workbench/guide-course.ts`), under an id derived from that
 * owner. A visitor who signs in brings the anonymous owner's copy along, and
 * the account's own seed may land while the claim is landing (the library
 * loads beside the login merge, from a list that does not show the claimed
 * copy yet). {@link refuseSecondGuideCourse} refuses creating a guide course
 * while the owner holds another active one. A claim takes the owner's
 * identity lock exclusively, so a seed that lands after a claim sees the
 * claimed copy; creates take it shared, so two creates of one owner are
 * serialized by a per-owner guide lock instead. The seed takes the refusal
 * (403) as settled and reloads the library, whose list missed the claimed
 * copy.
 *
 * A claim never retires a guide course. When the visitor and the account each
 * had a copy before the sign-in, both stay: a second guide course in the
 * library is harmless (the user can delete either), and any copy may carry
 * edits, a publication or a session someone else holds, which a retire would
 * strand.
 *
 * Only copies of the current seed generation count
 * (`./guide-course-id.ts`): a copy of an older generation is an ordinary
 * course, never refused against, so advancing the generation seeds the new
 * course once for everyone.
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
