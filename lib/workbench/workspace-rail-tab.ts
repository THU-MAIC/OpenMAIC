/**
 * Which of the rail's two lists is on screen.
 *
 * Chats and Courses used to be stacked sections, both always visible. They are
 * now two tabs over one body, which buys the active list its height back (see
 * `workspace-paging`) and costs the inactive one its visibility. Run state is
 * intentionally kept on rows inside the conversation tab.
 *
 * The choice is a per-browser view preference, exactly like the rail's width
 * and the panes' collapse: it is remembered in `localStorage`, never in the
 * URL, because it says nothing about what is open.
 *
 * Pure, so the parsing and the first-visit fallback are tested without a rail.
 */

export type RailTab = 'sessions' | 'courses';

export const RAIL_TAB_STORAGE_KEY = 'openmaic:workspace:rail-tab';

const TABS: readonly RailTab[] = ['sessions', 'courses'];

export function isRailTab(value: unknown): value is RailTab {
  return typeof value === 'string' && (TABS as readonly string[]).includes(value);
}

/**
 * The tab to open with.
 *
 * A stored preference always wins — it is the user's own last press. With no
 * preference, a URL that already names a course opens on Courses: the row for
 * `?course=` has to be reachable after a refresh, and a rail that restored the
 * conversation list while a course sat open would hide the one row that is
 * marked `aria-current`.
 *
 * Anything else (first visit, storage denied, a value from a future version)
 * falls back to Chats, which is where the new-session button above the tabs
 * leads.
 */
export function resolveRailTab(options: {
  readonly stored?: string | null;
  readonly hasOpenCourse?: boolean;
}): RailTab {
  if (isRailTab(options.stored)) return options.stored;
  return options.hasOpenCourse ? 'courses' : 'sessions';
}
