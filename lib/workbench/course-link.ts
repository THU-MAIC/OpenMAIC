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
