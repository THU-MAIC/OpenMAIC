/**
 * Pro-mode (edit chrome) page pager state.
 *
 * The deck's page navigation lives in `useStageStore`: `currentSceneId` is
 * the single source of truth for "which page is open" and `setCurrentSceneId`
 * is the only way to change it — the SlideNavRail thumbnails and the
 * canvas pager buttons must both go through that same pair, or the two
 * affordances would drift apart. This module derives the pager's read-only
 * view (index / count / boundary flags / neighbour ids) from the store data
 * so the UI layer renders it without duplicating the deck math.
 */
export interface ScenePagerState {
  /** Zero-based index of the current scene within `scenes`. */
  index: number;
  /** Total page count. */
  count: number;
  /** Whether a previous page exists (false on the first page). */
  canPrev: boolean;
  /** Whether a next page exists (false on the last page). */
  canNext: boolean;
  /** Id of the previous scene, or null when already on the first page. */
  prevSceneId: string | null;
  /** Id of the next scene, or null when already on the last page. */
  nextSceneId: string | null;
}

/**
 * Compute the pager view for a deck. Returns null when there is no current
 * scene (empty deck or unresolved id) — the caller then renders no pager.
 */
export function getScenePagerState(
  scenes: readonly { id: string }[],
  currentSceneId: string | null,
): ScenePagerState | null {
  if (!currentSceneId || scenes.length === 0) return null;
  const index = scenes.findIndex((s) => s.id === currentSceneId);
  if (index < 0) return null;
  return {
    index,
    count: scenes.length,
    canPrev: index > 0,
    canNext: index < scenes.length - 1,
    prevSceneId: index > 0 ? scenes[index - 1].id : null,
    nextSceneId: index < scenes.length - 1 ? scenes[index + 1].id : null,
  };
}
