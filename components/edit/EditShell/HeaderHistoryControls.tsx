'use client';

import { Redo2, Undo2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCourseHistory } from '@/lib/edit/use-course-history';

const BUTTON_CLASS =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60';

/**
 * Undo/redo for a host that hides the CommandBar and offers its own header
 * (the workbench's classroom pane). Portalled there by `EditShell`.
 */
export function HeaderHistoryControls() {
  const { t } = useI18n();
  const history = useCourseHistory();
  return (
    <>
      <button
        type="button"
        data-testid="workbench-undo"
        disabled={!history.canUndo}
        onClick={history.undo}
        aria-label={t('edit.undo')}
        title={t('edit.undo')}
        className={BUTTON_CLASS}
      >
        <Undo2 className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="workbench-redo"
        disabled={!history.canRedo}
        onClick={history.redo}
        aria-label={t('edit.redo')}
        title={t('edit.redo')}
        className={BUTTON_CLASS}
      >
        <Redo2 className="size-3.5" aria-hidden="true" />
      </button>
    </>
  );
}
