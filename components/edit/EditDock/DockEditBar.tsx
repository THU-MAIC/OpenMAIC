'use client';

/**
 * The dock's global edit bar — one row, above the timeline, that never changes.
 *
 * What lands here is what acts on the COURSE rather than on the page's narration:
 * which page you are on, who is in the class, and which elements you are handing
 * the agent. None of it belongs floating over the canvas — a pill hovering on the
 * slide covers the very content it is about to replace.
 *
 * It is playback's control bar (`CanvasToolbar`) in edit's terms, the same row built
 * the same way: the page list and the page number on the left, one centred pill, and
 * only the row's own controls on the right. In the pill, previous and next are exactly
 * where they are in playback, with adding a page where playback has play, and the
 * mode's actions flanking them where playback's flank them: the timeline's on the
 * left (it puts them here itself), the roster and the reference lasso on the right.
 * Icon only, as playback's are, so nothing depends on the language or the width.
 *
 * It stays visible (and usable) while the dock is folded, because none of it is
 * about the fold.
 */
import { useState, type RefCallback } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FoldVertical,
  LayoutList,
  ListChecks,
  Presentation,
  UnfoldVertical,
  Users,
} from 'lucide-react';
import { CtrlDivider, ctrlBtn } from '@/components/canvas/canvas-toolbar';
import { SceneTypeChoice } from '@/components/edit/SlideNavRail/InsertionZone';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { CanvasPagerProps } from '@/components/edit/EditShell/CanvasPager';
import { isCoursewareReferenceEnabled } from '@/lib/config/feature-flags';
import { SCENE_CREATION_ENABLED } from '@/lib/edit/scene-creation-enabled';
import { useInsertSceneAt } from '@/lib/edit/use-insert-scene';
import { useSettingsStore } from '@/lib/store/settings';
import { cn } from '@/lib/utils';
import { RosterDialog } from '@/components/edit/AgentsView/RosterDialog';
import { DOCK_BAR_ACTION, DockBarTip } from './dock-context';
import { ElementRefLassoButton } from './ElementRefLassoButton';

/** The bar's own height, in px. The dock adds it to whatever the timeline is. */
export const DOCK_EDIT_BAR_HEIGHT = 32;

/** Playback's pill, whose last button is behind a flag, and that button's slot. */
const PLAYBACK_PILL_WIDTH = 222;
const PLAYBACK_REFERENCE_WIDTH = 26;

export function DockEditBar({
  sceneId,
  /** Canvas elements to point at — only a slide has any. */
  canPickElements,
  pager,
  collapsed,
  onToggleCollapsed,
  barActionsRef,
}: {
  readonly sceneId: string;
  readonly canPickElements: boolean;
  readonly pager?: CanvasPagerProps;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  /** Receives the place the timeline's own actions go. */
  readonly barActionsRef?: RefCallback<HTMLElement>;
}) {
  const { t } = useI18n();
  const [rosterOpen, setRosterOpen] = useState(false);
  const insertSceneAt = useInsertSceneAt();
  const railCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setRailCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);
  // Where playback has a reference button, the lasso sits on it and the roster has
  // the two slots before; without it, the two take those two slots between them. A
  // page with no lasso (nothing to point at, or no conversation to hand it to) ends
  // the pill early, on the roster's side of playback's reference button.
  const playbackHasReference = isCoursewareReferenceEnabled();
  const hasPages = !!pager && pager.count > 0;
  const pagerButton = cn(
    ctrlBtn,
    'h-6 w-6 text-gray-500 disabled:pointer-events-none disabled:opacity-20 dark:text-gray-400',
  );
  const foldLabel = t(collapsed ? 'stage.dock.expand' : 'stage.dock.collapse');

  return (
    <>
      <div
        role="group"
        data-testid="edit-dock-bar"
        aria-label={t('edit.dock.globalTools')}
        className="relative flex h-8 shrink-0 items-center gap-2 border-b border-gray-100/40 px-3 dark:border-gray-700/30"
      >
        <div className="flex shrink-0 items-center gap-1 pl-1">
          <button
            type="button"
            data-testid="edit-rail-toggle"
            aria-expanded={!railCollapsed}
            onClick={() => setRailCollapsed(!railCollapsed)}
            title={t(railCollapsed ? 'edit.nav.expand' : 'edit.nav.collapse')}
            aria-label={t(railCollapsed ? 'edit.nav.expand' : 'edit.nav.collapse')}
            className={cn(
              ctrlBtn,
              'h-6 w-6',
              railCollapsed
                ? 'text-gray-400 dark:text-gray-500'
                : 'text-gray-600 dark:text-gray-300',
            )}
          >
            <LayoutList className="size-3.5" />
          </button>
          {hasPages ? (
            <span
              data-testid="edit-page-indicator"
              className="select-none text-[11px] font-medium tabular-nums text-gray-400 dark:text-gray-500"
            >
              {pager.index + 1}
              <span className="mx-px opacity-35">/</span>
              {pager.count}
            </span>
          ) : null}
        </div>

        <CtrlDivider />

        <div className="flex min-w-0 flex-1 items-center justify-center">
          {/* Playback's pill's footprint, centred as playback's is, which puts previous
              and next on playback's x. The pill itself starts at its left edge and is as
              wide as what it holds, so a missing lasso takes its slot with it. */}
          <div
            className="flex shrink-0"
            style={{
              width: PLAYBACK_PILL_WIDTH + (playbackHasReference ? PLAYBACK_REFERENCE_WIDTH : 0),
            }}
          >
            <div
              data-testid="edit-bar-pill"
              className="flex h-7 shrink-0 items-center gap-0.5 rounded-lg bg-gray-100/60 px-1 dark:bg-gray-800/60"
            >
              {/* The timeline's actions land here. Playback's volume and speed, 58 wide. */}
              <div ref={barActionsRef} className="flex w-[58px] shrink-0 items-center gap-0.5" />
              <CtrlDivider />
              <button
                type="button"
                data-testid="edit-canvas-prev"
                disabled={!pager?.canPrev}
                onClick={pager?.onPrev}
                title={t('edit.nav.prevPage')}
                aria-label={t('edit.nav.prevPage')}
                className={pagerButton}
              >
                <ChevronLeft className="size-3.5" />
              </button>
              {/* Where playback has play. */}
              {SCENE_CREATION_ENABLED && hasPages ? (
                <Popover>
                  <DockBarTip label={t('edit.nav.addPage')}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        data-testid="edit-add-page"
                        aria-label={t('edit.nav.addPage')}
                        className={cn(ctrlBtn, 'h-6 w-7 text-gray-500 dark:text-gray-400')}
                      >
                        <FilePlus2 className="size-3.5" />
                      </button>
                    </PopoverTrigger>
                  </DockBarTip>
                  <PopoverContent
                    side="top"
                    align="center"
                    sideOffset={8}
                    className="w-40 p-1.5"
                    data-testid="scene-type-chooser"
                  >
                    <SceneTypeChoice
                      type="slide"
                      label={t('edit.sceneType.slide')}
                      Icon={Presentation}
                      onInsert={(type) => insertSceneAt(pager.index + 1, type)}
                    />
                    <SceneTypeChoice
                      type="quiz"
                      label={t('edit.sceneType.quiz')}
                      Icon={ListChecks}
                      onInsert={(type) => insertSceneAt(pager.index + 1, type)}
                    />
                  </PopoverContent>
                </Popover>
              ) : (
                <span className="h-6 w-7 shrink-0" />
              )}
              <button
                type="button"
                data-testid="edit-canvas-next"
                disabled={!pager?.canNext}
                onClick={pager?.onNext}
                title={t('edit.nav.nextPage')}
                aria-label={t('edit.nav.nextPage')}
                className={pagerButton}
              >
                <ChevronRight className="size-3.5" />
              </button>
              <CtrlDivider />
              {/* At least as wide as the timeline's side, so without a lasso the roster has
                  that side to itself and the pill stays even around previous and next. */}
              <div className="flex min-w-[58px] shrink-0 gap-0.5">
                <div className={cn('flex grow justify-center', playbackHasReference && 'w-[58px]')}>
                  <DockBarTip label={t('edit.roster.title')}>
                    <button
                      type="button"
                      data-testid="edit-dock-roster"
                      onClick={() => setRosterOpen(true)}
                      aria-label={t('edit.roster.title')}
                      className={cn(DOCK_BAR_ACTION, 'w-8')}
                    >
                      <Users className="size-3.5" />
                    </button>
                  </DockBarTip>
                </div>
                <div className="flex w-6 shrink-0 empty:hidden">
                  {canPickElements ? <ElementRefLassoButton sceneId={sceneId} /> : null}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-px pr-1">
          <CtrlDivider />
          {/* Playback's fullscreen and chat toggle; the fold is where it is in playback. */}
          <span className="h-6 w-6 shrink-0" />
          <span className="h-6 w-6 shrink-0" />
          <button
            type="button"
            data-testid="dock-fold"
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
            title={foldLabel}
            aria-label={foldLabel}
            className={cn(ctrlBtn, 'h-6 w-6 text-gray-500 dark:text-gray-400')}
          >
            {collapsed ? (
              <UnfoldVertical className="size-3.5" />
            ) : (
              <FoldVertical className="size-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Radix keeps the dialog in a portal and renders nothing while closed, so
          the roster editor is remounted — and therefore re-read from the stage —
          on every open. */}
      <RosterDialog open={rosterOpen} onOpenChange={setRosterOpen} />
    </>
  );
}
