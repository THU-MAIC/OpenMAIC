'use client';

/**
 * Icon-only Restore (undo) control for regenerate tool cards. Whole-slide and
 * narration regeneration both apply directly; the runtime snapshots the
 * pre-regenerate scene state, so this offers a one-tap revert. Rendered on the
 * card's always-visible bar (ToolCard `barAction`). Returns null when there is
 * no in-memory snapshot (e.g. a card restored from storage after a refresh).
 */
import { Redo2, Undo2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useRegenSnapshots } from '@/lib/agent/client/regen-snapshots';
import { applyScenePatchInSync } from '@/lib/agent/client/apply-slide-content';

export function RestoreButton({ toolCallId }: { toolCallId: string }) {
  const { t } = useI18n();
  const snap = useRegenSnapshots((s) => s.snapshots[toolCallId]);
  if (!snap) return null;

  // Undone but with no captured post-edit state (e.g. a card restored from
  // storage after a refresh) → terminal undone state, nothing to resume.
  if (snap.restored && !snap.redo) {
    return (
      <span
        title={t('edit.regenScene.restored')}
        className="grid size-6 place-items-center text-muted-foreground/40"
      >
        <Undo2 className="size-3.5" />
      </span>
    );
  }

  // Toggle: undo while applied, resume (redo) once undone.
  const resume = snap.restored;
  const Icon = resume ? Redo2 : Undo2;
  const label = resume ? t('edit.regenScene.resume') : t('edit.regenScene.restore');
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() =>
        useRegenSnapshots
          .getState()
          .restore(toolCallId, (id, patch) => applyScenePatchInSync(id, patch))
      }
      className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Icon className="size-3.5" />
    </button>
  );
}
