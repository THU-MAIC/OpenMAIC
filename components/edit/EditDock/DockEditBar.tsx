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
 * Information structure: paging in the CENTRE, because it is the one control the
 * user reaches for constantly and centre is where the eye returns; the two
 * course-level entries on the flanks — the roster on the left, the lasso on the
 * right — so the row stays symmetric and neither entry can be mistaken for part
 * of the timeline below it.
 *
 * Deliberately not a new visual idiom: the same flat icon buttons, the same type
 * scale and the same hairline the timeline header already uses. It stays visible
 * (and usable) while the dock is folded, because none of it is about the fold.
 */
import { useState } from 'react';
import { Users } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { CanvasPager, type CanvasPagerProps } from '@/components/edit/EditShell/CanvasPager';
import { RosterDialog } from '@/components/edit/AgentsView/RosterDialog';
import { ElementRefLassoButton } from './ElementRefLassoButton';

/** The bar's own height, in px. The dock adds it to whatever the timeline is. */
export const DOCK_EDIT_BAR_HEIGHT = 36;

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

  return (
    <>
      <div
        role="group"
        data-testid="edit-dock-bar"
        aria-label={t('edit.dock.globalTools')}
        // Three tracks rather than a flex row with spacers: the pager must be
        // centred on the DOCK, not on whatever is left over after the flanks.
        className="grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-gray-100 px-6 dark:border-gray-800"
      >
        <div className="flex min-w-0 items-center gap-1">
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
        </div>

        <div className="flex items-center justify-center">
          {pager && pager.count > 0 ? <CanvasPager {...pager} variant="dock" /> : null}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-1">
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
