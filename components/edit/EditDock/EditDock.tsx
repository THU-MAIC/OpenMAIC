'use client';

/**
 * EditDock — Pro mode's bottom editing bench.
 *
 * Two parts, and only two: a global edit bar (`DockEditBar`) that never changes,
 * and the narration timeline below it. The dock owns the surface — the top
 * border, the blur, the fold — while the timeline owns its own header row and
 * body and reads the fold from `useEditDock`. The dock's height is fixed (the
 * timeline is folded or not, nothing else changes it): the height-drag handle
 * the reference implementation carries above the bar was removed per product
 * decision — this bar must not support height dragging.
 *
 * It briefly had a tab strip and a second tool (an element-reference panel).
 * That was wrong twice over: an exclusive panel hid the timeline to do something
 * the timeline was not in the way of, and the panel's own list duplicated the
 * composer's reference pills. The lasso is a single toggle in the bar now, in the
 * Cursor sense — press it, click elements, they appear in the composer.
 *
 * Deliberately not a new visual idiom. The bar keeps the bench's own hairline,
 * type scale and flat icon buttons; the timeline keeps the height, padding and
 * geometry it had as a standalone bar.
 */
import { useCallback, useEffect, useState } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { ActionsBar } from '@/components/edit/ActionsBar/ActionsBar';
import type { CanvasPagerProps } from '@/components/edit/EditShell/CanvasPager';
import type { SceneType } from '@/lib/types/stage';
import { EditDockProvider } from './dock-context';
import { DockEditBar, DOCK_EDIT_BAR_HEIGHT } from './DockEditBar';

/**
 * The timeline's height, in px — the body only; the edit bar is added on top of
 * it, so folding never takes the bar away. The timeline height is fixed: the
 * height-drag handle was removed (owner decision), so only the fold moves it.
 */
const TIMELINE_DEFAULT_HEIGHT = 224;
/** The axis of node icons, with room for the chips that hang off it. */
const TIMELINE_COLLAPSED_HEIGHT = 86;

export function EditDock({
  sceneId,
  sceneType,
  pager,
}: {
  readonly sceneId: string;
  readonly sceneType: SceneType;
  /**
   * Deck paging. It lands in the dock's global edit bar rather than floating over
   * the canvas: flipping pages acts on the whole course, exactly like the other
   * global entries, and a pill hovering over the slide covered the very content
   * it was about to replace.
   */
  readonly pager?: CanvasPagerProps;
}) {
  const sessionId = useWorkbenchStore((state) => state.sessionId);
  const currentStageId = useStageStore((state) => state.stage?.id ?? null);
  // References address slide canvas elements or DOM elements inside interactive scenes. There is
  // deliberately no agent-ownership condition here: see `ElementRefLassoButton`
  // for why picking elements is a human authoring gesture rather than something
  // a live run has to own.
  const canPickElements = sceneType === 'slide' || sceneType === 'interactive';

  const [collapsed, setCollapsed] = useState(false);
  const toggleCollapsed = useCallback(() => setCollapsed((current) => !current), []);

  /**
   * The dock is an owner boundary for the lasso, because it can outlive a slide
   * renderer during workspace navigation: never leave an old chat's (or an old
   * page's) pick mode armed just because there is temporarily no pick layer
   * mounted to perform the cleanup.
   *
   * The criterion is IDENTITY, not ownership: a staged pick belongs to one exact
   * (chat, course, page) triple, so switching any of the three — a different
   * conversation, a different course, a different slide — disarms whatever the
   * previous one left behind. That is the whole invariant; it used to also fire on
   * "the agent stopped owning this course", which is how the lasso came to vanish
   * the moment a run finished.
   */
  useEffect(() => {
    const target = useCanvasStore.getState().pickTarget;
    if (target?.purpose !== 'element-ref') return;
    if (
      target.ownerSessionId !== sessionId ||
      target.stageId !== currentStageId ||
      target.sceneId !== sceneId
    ) {
      useCanvasStore.getState().setPickTarget(null);
    }
  }, [currentStageId, sceneId, sessionId]);

  return (
    <section
      data-testid="edit-dock"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{
        height:
          (collapsed ? TIMELINE_COLLAPSED_HEIGHT : TIMELINE_DEFAULT_HEIGHT) + DOCK_EDIT_BAR_HEIGHT,
      }}
      className="relative flex flex-col border-t border-gray-100 bg-white/80 backdrop-blur-xl dark:border-gray-800 dark:bg-slate-900/80"
    >
      <DockEditBar sceneId={sceneId} canPickElements={canPickElements} pager={pager} />

      <div data-testid="edit-dock-timeline" className="flex min-h-0 flex-1 flex-col">
        <EditDockProvider value={{ collapsed, toggleCollapsed }}>
          <ActionsBar sceneId={sceneId} />
        </EditDockProvider>
      </div>
    </section>
  );
}
