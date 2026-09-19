'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { AgentRosterPanel, type AgentRosterPanelHandle } from './AgentRosterPanel';

interface RosterDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The classroom roster, as a dialog.
 *
 * The roster is course-level content, not an app-level setting, so it does not
 * live in the global SettingsDialog; and it is not a rail either — the Pro right
 * rail it used to occupy is gone. Its entry is the edit dock's global bar, beside
 * the other course-level controls.
 *
 * `AgentRosterPanel` is reused as-is: the panel is self-contained (it reads and
 * writes `useStageStore` through `useAgentRoster`), so mounting it here is
 * zero-change reuse. Radix renders nothing while closed, which is load-bearing:
 * the panel materializes the roster from the stage document AT MOUNT, so every
 * open re-reads the current cast rather than editing a stale snapshot.
 *
 * Sized like the rail it replaced, but as a CAP rather than a fixed width: the
 * hard `w-[384px]` it first shipped with could not shrink, so a narrow viewport
 * (and a grid track sized to the persona textarea's intrinsic `cols` width) pushed
 * the cards' right edge past the clip and off screen. It follows the repo's dialog
 * convention now — full width, capped at `sm`, and never wider than the viewport
 * less a margin — while every box inside it is allowed to shrink (`min-w-0`),
 * which is what stops a textarea from setting the floor.
 *
 * Height is capped as well, with the panel's own scrollable list handling the
 * overflow. The panel already renders `edit.roster.title` as its visible sub-head,
 * so the dialog's own title is sr-only — Radix requires one for accessibility, and
 * showing it would double the heading.
 */
export function RosterDialog({ open, onOpenChange }: RosterDialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<AgentRosterPanelHandle>(null);
  const capturePanel = useCallback((panel: AgentRosterPanelHandle | null) => {
    // React clears callback refs before owner cleanup. Keep the last live
    // handle: its draft readers are deliberately owner-owned snapshots and
    // remain valid for this one final flush.
    if (panel) panelRef.current = panel;
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    // This cleanup runs for both a controlled true -> false transition and an
    // owner unmount. The handle commits draft snapshots straight to the stage,
    // so it does not depend on the dialog content surviving another render.
    return () => panelRef.current?.flushDrafts();
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      // Radix may remove the focused editor without delivering blur. Commit all
      // live drafts directly to the stage before the controlled close unmounts
      // the roster hook.
      panelRef.current?.flushDrafts();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid="roster-dialog"
        // The default corner close button is a boxed glyph riding the edge; we
        // render our own inside the sub-head instead, aligned with undo/redo.
        showCloseButton={false}
        className="w-full max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0 sm:max-w-[400px]"
      >
        <DialogTitle className="sr-only">{t('edit.roster.title')}</DialogTitle>
        <div className="flex h-[min(70vh,560px)] min-h-0 w-full min-w-0 flex-col">
          <AgentRosterPanel
            flushRef={capturePanel}
            headerTrailing={
              <DialogClose
                data-testid="roster-dialog-close"
                aria-label={t('common.close')}
                title={t('common.close')}
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X className="size-3.5" />
              </DialogClose>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
