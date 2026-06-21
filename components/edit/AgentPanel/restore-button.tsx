'use client';

/**
 * Icon-only Restore (undo) control for regenerate tool cards. Whole-slide and
 * narration regeneration both apply directly; the runtime snapshots the
 * pre-regenerate scene state, so this offers a one-tap revert. Rendered on the
 * card's always-visible bar (ToolCard `barAction`). Returns null when there is
 * no in-memory snapshot (e.g. a card restored from storage after a refresh).
 */
import { Undo2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useRegenSnapshots } from '@/lib/agent/client/regen-snapshots';
import { applyScenePatchInSync } from '@/lib/agent/client/apply-slide-content';

export function RestoreButton({ toolCallId }: { toolCallId: string }) {
  const { t } = useI18n();
  const snap = useRegenSnapshots((s) => s.snapshots[toolCallId]);
  if (!snap) return null;

  if (snap.restored) {
    return (
      <span
        title={t('edit.regenScene.restored')}
        className="grid size-6 place-items-center text-muted-foreground/40"
      >
        <Undo2 className="size-3.5" />
      </span>
    );
  }

  return (
    <button
      type="button"
      title={t('edit.regenScene.restore')}
      aria-label={t('edit.regenScene.restore')}
      onClick={() =>
        useRegenSnapshots
          .getState()
          .restore(toolCallId, (id, patch) => applyScenePatchInSync(id, patch))
      }
      className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Undo2 className="size-3.5" />
    </button>
  );
}
