'use client';

/**
 * Learn | Edit — the one switch between learning a course and editing it.
 *
 * Shared by the workspace's classroom pane (split and full screen) and the
 * standalone classroom page where the workbench is on, so the control looks
 * and behaves the same wherever a course is open. Edit is shown disabled, not
 * hidden, when the course cannot be edited right now (still generating, not
 * yours, not loaded); `editingHint` says why where there is a reason to give.
 */

import { BookOpen, Pencil } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';

// Tailwind rather than the workspace stylesheet: the standalone classroom page
// renders this too, and that route does not load `workspace-shell.css`.
const BUTTON =
  'inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 disabled:pointer-events-none disabled:opacity-40 dark:text-slate-400 dark:hover:text-slate-100';
const SELECTED =
  'bg-slate-900 text-white shadow-sm hover:text-white dark:bg-slate-100 dark:text-slate-900 dark:hover:text-slate-900';

export function ClassroomModeSwitch({
  learning,
  editingAllowed,
  editingHint,
  onLearn,
  onEdit,
  onEditIntent,
  className,
}: {
  readonly learning: boolean;
  readonly editingAllowed: boolean;
  readonly editingHint?: string;
  readonly onLearn: () => void;
  readonly onEdit: () => void;
  /** The pointer or focus reached Edit: a chance to start loading the editor. */
  readonly onEditIntent?: () => void;
  readonly className?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t('workspace.classroomMode')}
      className={cn(
        'inline-flex shrink-0 items-center rounded-[11px] bg-slate-100 p-[3px] dark:bg-white/[0.07]',
        className,
      )}
    >
      <button
        type="button"
        data-testid="workbench-mode-learning"
        aria-pressed={learning}
        onClick={onLearn}
        className={cn(BUTTON, learning && SELECTED)}
      >
        <BookOpen className="size-3.5" aria-hidden="true" />
        {t('workspace.learningMode')}
      </button>
      <button
        type="button"
        data-testid="workbench-mode-editing"
        aria-pressed={!learning}
        disabled={!editingAllowed}
        onPointerEnter={onEditIntent}
        onFocus={onEditIntent}
        onClick={onEdit}
        title={editingHint}
        className={cn(BUTTON, !learning && SELECTED)}
      >
        <Pencil className="size-3.5" aria-hidden="true" />
        {t('workspace.editingMode')}
      </button>
    </div>
  );
}
