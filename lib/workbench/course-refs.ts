/**
 * Course references — the classrooms a user names for the agent alongside a
 * message (e.g. "@course-name, swap the example on page 3").
 *
 * This exists because the workspace's two content columns are INDEPENDENT: a
 * course can be open on the right while the conversation in the middle is about
 * something else entirely, so the runner has no honest way to infer which
 * classroom a sentence is about. It is told instead — the user types `@`, picks
 * a course, and that pick is the turn's editing target.
 *
 * The wire shape is the sibling of `ElementRef` (`lib/workbench/element-refs`)
 * with the element identity removed: same strict decoder in the same two modes,
 * same cap-and-dedupe discipline, same "the id is the handle, the human label is
 * a snapshot" split. `title` is a CLIENT SNAPSHOT and is only ever used for
 * display and for degrading a reference that no longer resolves — the runner
 * reads the course's real current name from the owner-bound store when it
 * injects (see `resolveCourseRefsForContext`).
 */

export interface CourseRef {
  kind: 'course';
  stageId: string;
  /**
   * What the course was called when the user picked it. Display + degradation
   * only: never the name the agent is told to trust when the course resolves.
   */
  title: string;
}

/**
 * How many courses one message may name. Lower than the element cap on purpose:
 * a turn that points at six classrooms is not an editing target, it is a
 * sentence about a curriculum, and that is what plain prose is for.
 */
export const MAX_COURSE_REFS = 5;

export const COURSE_REF_ID_MAX = 64;
export const COURSE_REF_TITLE_MAX = 120;

const COURSE_REF_FIELDS = new Set(['kind', 'stageId', 'title']);

/**
 * Build a ref from a picked course. A course with no name still gets a ref — the
 * caller passes whatever it shows the user (an "untitled course" placeholder),
 * because a pill with no label is worse than a pill with a generic one.
 */
export function makeCourseRef(stageId: string, title: string): CourseRef | null {
  const id = stageId.trim();
  const label = title.trim();
  if (!id || !label) return null;
  return { kind: 'course', stageId: id, title: label.slice(0, COURSE_REF_TITLE_MAX) };
}

export function sameCourseRef(
  a: Pick<CourseRef, 'stageId'>,
  b: Pick<CourseRef, 'stageId'>,
): boolean {
  return a.stageId === b.stageId;
}

export function hasCourseRef(refs: readonly CourseRef[], stageId: string): boolean {
  return refs.some((ref) => ref.stageId === stageId);
}

/**
 * Append unless the same course is already named or the cap is reached.
 * Returns the SAME array identity when nothing changed, so a store `set` with
 * this result is a no-op re-render-wise.
 */
export function addCourseRef(refs: readonly CourseRef[], ref: CourseRef): CourseRef[] {
  if (hasCourseRef(refs, ref.stageId)) return refs as CourseRef[];
  if (refs.length >= MAX_COURSE_REFS) return refs as CourseRef[];
  return [...refs, ref];
}

export function removeCourseRef(refs: readonly CourseRef[], stageId: string): CourseRef[] {
  const next = refs.filter((ref) => ref.stageId !== stageId);
  return next.length === refs.length ? (refs as CourseRef[]) : next;
}

export type CourseRefsDecodeResult = { ok: true; refs: CourseRef[] } | { ok: false; error: string };

/**
 * The one strict wire decoder used by both the POST boundary and durable replay.
 * The route rejects the first invalid item; replay drops invalid historical
 * items and deterministically keeps the first `MAX_COURSE_REFS` valid refs.
 */
export function decodeCourseRefs(
  value: unknown,
  invalid: 'reject' | 'drop' = 'reject',
): CourseRefsDecodeResult {
  if (!Array.isArray(value)) {
    return invalid === 'drop'
      ? { ok: true, refs: [] }
      : { ok: false, error: 'courseRefs must be an array' };
  }
  const refs: CourseRef[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const reject = (error: string): CourseRefsDecodeResult | null =>
      invalid === 'reject' ? { ok: false, error } : null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      const failure = reject(`courseRefs[${index}] must be an object`);
      if (failure) return failure;
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const unknownField = Object.keys(rec).find((field) => !COURSE_REF_FIELDS.has(field));
    if (unknownField) {
      const failure = reject(`courseRefs[${index}] contains unknown field "${unknownField}"`);
      if (failure) return failure;
      continue;
    }
    if (rec.kind !== 'course') {
      const failure = reject(`courseRefs[${index}].kind must be "course"`);
      if (failure) return failure;
      continue;
    }
    if (typeof rec.stageId !== 'string' || !rec.stageId.trim()) {
      const failure = reject(`courseRefs[${index}].stageId must be a non-empty string`);
      if (failure) return failure;
      continue;
    }
    if (rec.stageId.length > COURSE_REF_ID_MAX) {
      const failure = reject(
        `courseRefs[${index}].stageId cannot exceed ${COURSE_REF_ID_MAX} characters`,
      );
      if (failure) return failure;
      continue;
    }
    if (typeof rec.title !== 'string' || !rec.title.trim()) {
      const failure = reject(`courseRefs[${index}].title must be a non-empty string`);
      if (failure) return failure;
      continue;
    }
    if (rec.title.length > COURSE_REF_TITLE_MAX) {
      const failure = reject(
        `courseRefs[${index}].title cannot exceed ${COURSE_REF_TITLE_MAX} characters`,
      );
      if (failure) return failure;
      continue;
    }
    const ref: CourseRef = { kind: 'course', stageId: rec.stageId, title: rec.title };
    if (seen.has(ref.stageId)) continue;
    seen.add(ref.stageId);
    if (refs.length >= MAX_COURSE_REFS) {
      if (invalid === 'reject') {
        return { ok: false, error: `courseRefs cannot contain more than ${MAX_COURSE_REFS} items` };
      }
      continue;
    }
    refs.push(ref);
  }
  return { ok: true, refs };
}

/** Decode refs from a durable event, dropping invalid historical items. */
export function parseCourseRefs(value: unknown): CourseRef[] {
  const decoded = decodeCourseRefs(value, 'drop');
  return decoded.ok ? decoded.refs : [];
}
