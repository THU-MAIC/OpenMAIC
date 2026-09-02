/**
 * The composer's `@` mention — parsing the trigger, and ordering what it offers.
 *
 * Pure on purpose: the menu component is a renderer, and every rule about what
 * counts as a mention and which course should be first is testable without a DOM.
 *
 * `@` AND `/` ARE DELIBERATELY DIFFERENT SHAPES. A pick here is STRUCTURE: it
 * becomes a `courseRef` carrying a stageId, which the server resolves against the
 * owner's own library and injects as a resolved block, so it needs a picker, a
 * pill and a wire format. A skill handle is TEXT — nothing parses it, the model
 * reads it — so `/` writes `/handle ` straight into the draft and has no pill, no
 * store and no cap (`lib/workbench/composer-skills`). Do not "unify" the two;
 * they model different things.
 *
 */

import { tokenAtCaret } from './composer-tokens';

/** A live `@` token in the draft, with the slice it occupies. */
export interface CourseMention {
  /** Text typed after the `@`, used to filter. */
  readonly query: string;
  /** Index of the `@` itself. */
  readonly start: number;
  /** Index just past the token. */
  readonly end: number;
}

/**
 * Longest query the trigger stays open for. Past this the user is writing prose
 * that happens to contain an `@`, not picking a course.
 */
export const COURSE_MENTION_QUERY_MAX = 40;

/**
 * How many courses the menu will paint at once.
 */
export const COURSE_MENTION_LIMIT = 50;

/**
 * The active mention AT THE CARET, or null.
 */
export function courseMentionQuery(draft: string, caret: number): CourseMention | null {
  const token = tokenAtCaret(draft, caret);
  if (!token.text.startsWith('@')) return null;
  const query = token.text.slice(1);
  if (query.length > COURSE_MENTION_QUERY_MAX) return null;
  if (query.includes('@')) return null;
  return { query, start: token.start, end: token.end };
}

/** What a pick leaves behind: the draft without the token, and where the caret goes. */
export interface CourseMentionRemoval {
  readonly draft: string;
  readonly caret: number;
}

/**
 * Splice the mention token out — what a pick leaves behind.
 */
export function replaceCourseMention(draft: string, mention: CourseMention): CourseMentionRemoval {
  // A trailing space before the token was the user's separator, not part of the
  // sentence they are writing; keep the rest verbatim.
  const before = draft.slice(0, mention.start).replace(/[ \t]+$/, '');
  const after = draft.slice(mention.end);
  return { draft: `${before}${after}`, caret: before.length };
}

/** One course the picker may offer. */
export interface CourseMentionCandidate {
  readonly stageId: string;
  readonly title: string;
  /**
   * Why it is offered, which is only ever an ORDERING fact: the classroom on
   * screen right now comes first, everything else follows.
   */
  readonly reason: 'open' | 'recent';
  /** Already named for this turn: the row shows it and picking it is a no-op. */
  readonly alreadyReferenced: boolean;
}

export interface CourseMentionSource {
  readonly id: string;
  readonly name: string;
}

/**
 * What the picker offers: ONE list, in one order — the course open in the
 * classroom pane right now, then everything else the workspace can name,
 * newest first. Filtering is a case-insensitive substring of the name.
 */
export function orderCourseMentionCandidates(input: {
  readonly query: string;
  /** The classroom pane's current course, if any. */
  readonly activeCourseId: string | null;
  /** Every course the workspace can name, newest-updated first. */
  readonly courses: readonly CourseMentionSource[];
  /** Courses already named for this turn. */
  readonly referencedIds: readonly string[];
  /** Fallback title for a course the workspace cannot name. */
  readonly untitled: string;
  readonly limit?: number;
}): CourseMentionCandidate[] {
  const { query, activeCourseId, courses, referencedIds, untitled } = input;
  const limit = input.limit ?? COURSE_MENTION_LIMIT;
  const names = new Map(courses.map((course) => [course.id, course.name]));
  const referenced = new Set(referencedIds);
  const needle = query.trim().toLowerCase();

  const ordered: { id: string; reason: CourseMentionCandidate['reason'] }[] = [];
  const seen = new Set<string>();
  const push = (id: string, reason: CourseMentionCandidate['reason']) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ordered.push({ id, reason });
  };
  if (activeCourseId) push(activeCourseId, 'open');
  for (const course of courses) push(course.id, 'recent');

  const out: CourseMentionCandidate[] = [];
  for (const entry of ordered) {
    const title = (names.get(entry.id) ?? '').trim() || untitled;
    if (needle && !title.toLowerCase().includes(needle)) continue;
    out.push({
      stageId: entry.id,
      title,
      reason: entry.reason,
      alreadyReferenced: referenced.has(entry.id),
    });
    if (out.length >= limit) break;
  }
  return out;
}
