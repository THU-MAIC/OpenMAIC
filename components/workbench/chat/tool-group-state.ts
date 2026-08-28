import type { ChatNode } from '@/lib/workbench/session-store';
import { isWorkbenchToolFailed } from './tool-presentation';

export type ToolGroupStatus = 'running' | 'error' | 'done';

export function aggregateToolGroupStatus(nodes: ChatNode[]): ToolGroupStatus {
  if (nodes.some((n) => n.toolState === 'running')) return 'running';
  if (nodes.some(isWorkbenchToolFailed)) return 'error';
  return 'done';
}

/**
 * Auto-fold policy for a tool group: the group stays expanded while tools are
 * running and collapses itself once every call has settled — unless the user
 * already took manual control of the fold. A group that mounts already
 * settled (e.g. a replayed timeline) starts collapsed.
 */
export function initialToolGroupOpen(status: ToolGroupStatus): boolean {
  return status === 'running';
}

/**
 * The breathing pause between "every call settled" and the fold closing. The
 * finished state (green dot + the done label) has to be readable before the
 * group takes its own height away, otherwise the collapse reads as a twitch.
 */
export const TOOL_GROUP_AUTO_COLLAPSE_MS = 600;

/**
 * How long a group stays on screen at minimum, counted from the moment it
 * first appeared — not from the moment it settled. Cached or trivially fast
 * calls can settle a whole group inside a few hundred milliseconds, and the
 * settle pause alone then closes it well under a second after it appeared:
 * the group expands and collapses in nearly the same breath, which reads as a
 * twitch rather than as work having happened. The floor is what turns a fast
 * group into a legible beat.
 */
export const TOOL_GROUP_MIN_VISIBLE_MS = 1800;

/**
 * How long to wait, from `now`, before closing a group that is owed an
 * auto-collapse. Two deadlines, whichever is later:
 *
 *   settledAt      + TOOL_GROUP_AUTO_COLLAPSE_MS   read the settled head
 *   firstVisibleAt + TOOL_GROUP_MIN_VISIBLE_MS     see the group at all
 *
 * A slow group (seconds of tool work) is unaffected — its settle deadline is
 * already past the visibility floor, so the floor never binds. A fast group
 * borrows the difference and holds until the floor.
 *
 * `now` is passed in so the delay can be recomputed at any point in the
 * window — the caller reads the clock, this stays pure.
 */
export function toolGroupCollapseDelayMs(
  now: number,
  firstVisibleAt: number,
  settledAt: number,
): number {
  const collapseAt = Math.max(
    settledAt + TOOL_GROUP_AUTO_COLLAPSE_MS,
    firstVisibleAt + TOOL_GROUP_MIN_VISIBLE_MS,
  );
  return Math.max(0, collapseAt - now);
}

/**
 * Whether an auto-collapse is owed right now. The caller schedules it after
 * `toolGroupCollapseDelayMs` and cancels whenever this turns false again — a
 * call going back to running, the user folding it by hand, or the group
 * unmounting mid-window. Only an OPEN group is ever owed one, which is also
 * what keeps a replayed (mounted-settled, already collapsed) group still.
 */
export function shouldScheduleAutoCollapse(
  status: ToolGroupStatus,
  open: boolean,
  userToggled: boolean,
): boolean {
  return status !== 'running' && open && !userToggled;
}
