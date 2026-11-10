/**
 * The in-chat course link's pure parts.
 *
 * NO STATE. A card is always pressable, says only what the course is (name, page
 * count), and the answer to "is it showing?" is the right pane itself.
 *
 * What is left here is the fold's arithmetic and the one bridge from agent prose
 * to a course id — both genuinely pure, both worth testing without a DOM.
 *
 */

import { WORKSPACE_COURSE_PARAM } from './workspace-panes';

/**
 * How many of one exchange's classroom cards are painted before the rest fold
 * away.
 */
export const RUN_COURSE_CARD_LIMIT = 3;

/**
 * One exchange's cards, split into what is painted and what is behind the `+N`.
 */
export function splitRunCourseCards(
  stageIds: readonly string[],
  expanded = false,
  limit: number = RUN_COURSE_CARD_LIMIT,
): { readonly shown: readonly string[]; readonly hiddenCount: number } {
  if (expanded || stageIds.length <= limit) {
    return { shown: stageIds, hiddenCount: 0 };
  }
  return { shown: stageIds.slice(0, limit), hiddenCount: stageIds.length - limit };
}

/**
 * The course id inside a link the agent wrote, or `null`.
 *
 * Recognised: `/classroom/<id>` (the course's own route) and any href carrying
 * `?course=<id>` (the workspace's own param). Anything else is `null`, and the
 * caller must then leave the anchor exactly as it was.
 */
export function courseIdFromHref(href: string | undefined | null): string | null {
  if (typeof href !== 'string' || href.length === 0) return null;
  // A scheme or a protocol-relative prefix means "somewhere else".
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  const [pathname, query = ''] = href.split('?');
  const fromParam = new URLSearchParams(query.split('#')[0]).get(WORKSPACE_COURSE_PARAM);
  if (fromParam) return fromParam;
  const match = /^\/classroom\/([^/?#]+)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed escape is not a course id.
    return null;
  }
}

/**
 * The courses a piece of agent Markdown links to, in the order first linked:
 * every `[text](href)` whose href names a course. Fenced code is skipped -- a
 * link shown as code is an example, not a mention.
 */
export function courseMentionsIn(markdown: string): string[] {
  const ids: string[] = [];
  let fence: string | null = null;
  const prose = markdown
    .split('\n')
    .filter((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (fence === null || marker[0] === fence[0])) {
        fence = fence === null ? marker : null;
        return false;
      }
      return fence === null;
    })
    .join('\n');
  for (const match of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const id = courseIdFromHref(match[1]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** A run of Markdown and the course cards that follow it. */
export interface CourseMentionSegment {
  readonly markdown: string;
  readonly cards: readonly string[];
}

/**
 * Cut an answer after each block (paragraph, list, quote...) that FIRST
 * mentions a course, so that course's card can stand right below the words
 * that named it. One card per course: a course mentioned again, or one in
 * `exclude` (already carded earlier in the answer, or among the cards at its
 * tail), gets none. `blocks` is the answer split into top-level blocks whose
 * concatenation is the answer itself (Streamdown's own splitter).
 */
export function segmentCourseMentions(
  blocks: readonly string[],
  exclude: ReadonlySet<string> = new Set(),
): CourseMentionSegment[] {
  const segments: CourseMentionSegment[] = [];
  const carded = new Set(exclude);
  let pending = '';
  for (const block of blocks) {
    pending += block;
    const cards = courseMentionsIn(block).filter((id) => !carded.has(id));
    if (cards.length === 0) continue;
    for (const id of cards) carded.add(id);
    segments.push({ markdown: pending, cards });
    pending = '';
  }
  if (pending || segments.length === 0) segments.push({ markdown: pending, cards: [] });
  return segments;
}

/**
 * For each piece of agent text, the courses that must get no card under it:
 * the ones an earlier piece of the same answer already carded, and the ones
 * among the cards at the answer's tail (its `course` row). An answer runs from
 * one user message to the next; its text may be split around tool calls.
 */
export function courseCardExclusions(
  chat: readonly {
    readonly key: string;
    readonly kind: string;
    readonly text?: string;
    readonly stageIds?: readonly string[];
  }[],
): Map<string, ReadonlySet<string>> {
  const exclusions = new Map<string, ReadonlySet<string>>();
  let start = 0;
  const flush = (end: number) => {
    const tail = new Set<string>();
    for (let i = start; i < end; i += 1) {
      const node = chat[i]!;
      if (node.kind === 'course') for (const id of node.stageIds ?? []) tail.add(id);
    }
    const carded = new Set(tail);
    for (let i = start; i < end; i += 1) {
      const node = chat[i]!;
      if (node.kind !== 'assistant' || !node.text) continue;
      exclusions.set(node.key, new Set(carded));
      for (const id of courseMentionsIn(node.text)) carded.add(id);
    }
  };
  chat.forEach((node, index) => {
    if (node.kind !== 'user') return;
    flush(index);
    start = index + 1;
  });
  flush(chat.length);
  return exclusions;
}
