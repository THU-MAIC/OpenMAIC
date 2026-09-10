'use client';

/**
 * The way back from full-screen playback to the workbench. The canvas pager or
 * preview toolbar steps the workbench chrome aside; this control — hosted in the
 * classroom header's left slot while a session is attached — is what brings
 * the conversation back. Chat fold and panel state live in the store, so the
 * return restores them exactly.
 */
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useWorkbenchStore } from '@/lib/workbench/session-store';

export function WorkbenchReturnControl() {
  const { t } = useI18n();
  const setPlaybackOn = useWorkbenchStore((s) => s.setPlaybackOn);
  return (
    <button
      type="button"
      data-testid="workbench-return"
      onClick={() => setPlaybackOn(false)}
      title={t('workbench.common.backToWorkspace')}
      aria-label={t('workbench.common.backToWorkspace')}
      className="inline-flex shrink-0 items-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
    </button>
  );
}
