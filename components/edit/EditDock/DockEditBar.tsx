'use client';

/**
 * The dock's global edit bar — one row, above the timeline, that never changes.
 *
 * What lands here is what acts on the COURSE rather than on the page's narration:
 * which page you are on, who is in the class, and which elements you are handing
 * the agent. None of it belongs inside the timeline (a spoken line has nothing to
 * say about the cast), and none of it belongs floating over the canvas — a pill
 * hovering on the slide covers the very content it is about to replace.
 *
 * It is playback's control bar (`CanvasToolbar`) in edit's terms, in the same
 * place at the same height, so the eye and the hand keep their bearings when the
 * mode changes: the page list and the page number on the left, previous and next
 * where they are in playback, the mode's own actions on the right.
 *
 * It stays visible (and usable) while the dock is folded, because none of it is
 * about the fold.
 */
import { useState } from 'react';
import { ChevronLeft, ChevronRight, LayoutList, Users } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { CanvasPagerProps } from '@/components/edit/EditShell/CanvasPager';
import { useSettingsStore } from '@/lib/store/settings';
import { cn } from '@/lib/utils';
import { RosterDialog } from '@/components/edit/AgentsView/RosterDialog';
import { ElementRefLassoButton } from './ElementRefLassoButton';

/** The bar's own height, in px. The dock adds it to whatever the timeline is. */
export const DOCK_EDIT_BAR_HEIGHT = 32;

/** Playback's control button (`CanvasToolbar`). */
const CONTROL_BUTTON =
  'relative flex items-center justify-center rounded-md outline-none transition-all duration-150 hover:bg-gray-500/[0.08] active:scale-90 disabled:cursor-not-allowed disabled:opacity-35 dark:hover:bg-gray-400/[0.08]';

/** From the bar's centre to the left edge of previous, as playback lays them out. */
const PAGER_FROM_CENTER_PX = 46;

export function DockEditBar({
  sceneId,
  /** Canvas elements to point at — only a slide has any. */
  canPickElements,
  pager,
}: {
  readonly sceneId: string;
  readonly canPickElements: boolean;
  readonly pager?: CanvasPagerProps;
}) {
  const { t } = useI18n();
  const [rosterOpen, setRosterOpen] = useState(false);
  const railCollapsed = useSettingsStore((state) => state.editRailCollapsed);
  const setRailCollapsed = useSettingsStore((state) => state.setEditRailCollapsed);

  return (
    <>
      <div
        role="group"
        data-testid="edit-dock-bar"
        aria-label={t('edit.dock.globalTools')}
        className="relative flex h-8 shrink-0 items-center justify-between gap-2 border-b border-gray-100/40 px-3 dark:border-gray-700/30"
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
              CONTROL_BUTTON,
              'size-6',
              railCollapsed
                ? 'text-gray-400 dark:text-gray-500'
                : 'text-gray-600 dark:text-gray-300',
            )}
          >
            <LayoutList className="size-3.5" />
          </button>
          {pager && pager.count > 0 ? (
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

        {/* Where playback's previous and next are; the gap is its play button.
            Placed against the bar's centre rather than flexed between the flanks,
            so the wider actions on the right cannot push them. */}
        {pager && pager.count > 0 ? (
          <div
            data-testid="edit-canvas-pager"
            className="absolute top-1/2 flex -translate-y-1/2 items-center gap-8"
            style={{ left: `calc(50% - ${PAGER_FROM_CENTER_PX}px)` }}
          >
            <button
              type="button"
              disabled={!pager.canPrev}
              onClick={pager.onPrev}
              title={t('edit.nav.prevPage')}
              aria-label={t('edit.nav.prevPage')}
              className={cn(CONTROL_BUTTON, 'size-6 text-gray-500 dark:text-gray-400')}
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <button
              type="button"
              disabled={!pager.canNext}
              onClick={pager.onNext}
              title={t('edit.nav.nextPage')}
              aria-label={t('edit.nav.nextPage')}
              className={cn(CONTROL_BUTTON, 'size-6 text-gray-500 dark:text-gray-400')}
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        ) : null}

        <div className="flex min-w-0 items-center justify-end gap-1">
          <button
            type="button"
            data-testid="edit-dock-roster"
            onClick={() => setRosterOpen(true)}
            title={t('edit.roster.title')}
            aria-label={t('edit.roster.title')}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
          >
            <Users className="size-3" />
            {t('edit.roster.shortTitle')}
          </button>
          {canPickElements ? <ElementRefLassoButton sceneId={sceneId} /> : null}
        </div>
      </div>

      {/* Radix keeps the dialog in a portal and renders nothing while closed, so
          the roster editor is remounted — and therefore re-read from the stage —
          on every open. */}
      <RosterDialog open={rosterOpen} onOpenChange={setRosterOpen} />
    </>
  );
}
