/**
 * The ids of seeded guide courses, shared by the client seed
 * (`lib/workbench/guide-course.ts`) and the server rules
 * (`./guide-courses.ts`). Pure: no client or server imports.
 *
 * An id names its seed generation: `stage-guide-<hash>` for the first one
 * (`g1`, the ids already in libraries), `stage-guide-<generation>-<hash>` for
 * every later one. Only copies of the CURRENT generation count as the guide
 * course: the seed skips and the server refuses a second among those alone. A copy of an older generation is an ordinary course of
 * its owner's, so advancing the generation seeds the new course once more for
 * everyone, as {@link GUIDE_SEED_GENERATION} says.
 */

/** The prefix of every seeded guide course's id, of any generation. */
export const GUIDE_COURSE_PREFIX = 'stage-guide-';

/**
 * Part of every seeded id. Changing it gives every owner a new id, so the
 * course is seeded once more for everyone, including owners who deleted it.
 * Copies of an older generation stay in their libraries as ordinary courses.
 */
export const GUIDE_SEED_GENERATION = 'g1';

/** The first generation's ids carry no generation segment. */
const FIRST_GENERATION = 'g1';

function generationPrefix(generation: string): string {
  return generation === FIRST_GENERATION
    ? GUIDE_COURSE_PREFIX
    : `${GUIDE_COURSE_PREFIX}${generation}-`;
}

/** The seed generation `id` belongs to, or `null` when it is no seeded guide course. */
export function guideCourseGenerationOf(id: string | null | undefined): string | null {
  const match = id ? /^stage-guide-(?:(g\d+)-)?[0-9a-f]{16}$/.exec(id) : null;
  return match ? (match[1] ?? FIRST_GENERATION) : null;
}

/** Whether `id` is a guide course of the current seed generation. */
export function isCurrentGuideCourseId(id: string | null | undefined): boolean {
  return guideCourseGenerationOf(id) === GUIDE_SEED_GENERATION;
}

/** A PostgreSQL regular expression (`~`) matching exactly the current generation's ids. */
export function currentGuideCourseIdPattern(): string {
  return `^${generationPrefix(GUIDE_SEED_GENERATION)}[0-9a-f]{16}$`;
}

/** A short, stable, non-reversible name for a learner key (FNV-1a, 2×32 bits). */
export function guideCourseIdFor(
  learnerKey: string,
  generation: string = GUIDE_SEED_GENERATION,
): string {
  const input = `${generation}:${learnerKey}`;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193 + 2) >>> 0;
  }
  return `${generationPrefix(generation)}${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** The code a refused second guide course answers with, as `403`. */
export const GUIDE_COURSE_EXISTS = 'GUIDE_COURSE_EXISTS';
