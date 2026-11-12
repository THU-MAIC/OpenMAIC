'use client';

/**
 * EditDock — Pro mode's bottom editing bench.
 *
 * Two parts, and only two: a control bar (`DockEditBar`) that never changes, and
 * the narration timeline below it. The dock owns the surface — the top border,
 * the blur, the fold — while the timeline owns its body and its controls, which
 * it shows in the bar through `useEditDock`. The height and the fold are the
 * classroom's, shared with playback (`useDockBox`), so a switch moves nothing.
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { DockResizeHandle, useDockBox } from '@/components/classroom/dock-box';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { ActionsBar } from '@/components/edit/ActionsBar/ActionsBar';
import type { CanvasPagerProps } from '@/components/edit/EditShell/CanvasPager';
import type { SceneType } from '@/lib/types/stage';
import { EditDockProvider } from './dock-context';
import { DockEditBar } from './DockEditBar';

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
  const { t } = useI18n();
  const sessionId = useWorkbenchStore((state) => state.sessionId);
  const currentStageId = useStageStore((state) => state.stage?.id ?? null);
  // References address slide canvas elements or DOM elements inside interactive scenes. There is
  // deliberately no agent-ownership condition here: see `ElementRefLassoButton`
  // for why picking elements is a human authoring gesture rather than something
  // a live run has to own.
  const canPickElements = sceneType === 'slide' || sceneType === 'interactive';

  const dockRef = useRef<HTMLElement>(null);
  const { height, collapsed } = useDockBox(dockRef);
  const setDockCollapsed = useSettingsStore((state) => state.setDockCollapsed);
  const expand = useCallback(() => setDockCollapsed(false), [setDockCollapsed]);
  const [barActions, setBarActions] = useState<HTMLElement | null>(null);

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
      ref={dockRef}
      data-testid="edit-dock"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{ height }}
      className="relative flex flex-col overflow-hidden transition-[height] duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-[dragging=true]:transition-none motion-reduce:transition-none border-t border-gray-100 bg-white/60 backdrop-blur-md dark:border-gray-800 dark:bg-gray-800/60"
    >
      {/* One edge in both states, so a fold mid-drag keeps the same handle under the pointer. */}
      <DockResizeHandle dockRef={dockRef} folded={collapsed} />
      <DockEditBar
        sceneId={sceneId}
        canPickElements={canPickElements}
        pager={pager}
        collapsed={collapsed}
        onToggleCollapsed={() => setDockCollapsed(!collapsed)}
        barActionsRef={setBarActions}
      />

      <div
        data-testid="edit-dock-timeline"
        role="region"
        aria-label={t('edit.timeline.title')}
        inert={collapsed}
        className="flex min-h-0 flex-1 flex-col"
      >
        <EditDockProvider value={{ expand, barActions }}>
          <ActionsBar sceneId={sceneId} />
        </EditDockProvider>
      </div>
    </section>
  );
}
