'use client';

/**
 * What the workspace's classroom pane shows for a course its generation run
 * is still producing.
 *
 * The pane is edit-locked (see `resolveStageChromeMode`): it shows the edit
 * chrome or nothing. A course being generated is read-only until its run
 * completes, so the edit chrome never resolved and the pane stayed blank.
 * This says what is going on instead, with the run's progress and the way to
 * follow it (the standalone classroom, where a paused run's Retry lives). The
 * pane swaps to the course by itself when the run completes.
 */
import { ExternalLink } from 'lucide-react';

import {
  CourseRunStatusIcon,
  courseRunStatusText,
} from '@/components/generation/course-run-status-label';
import type { CourseRunStatus } from '@/lib/generation-run-client/course-card';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';

export function CourseGeneratingPlaceholder({
  status,
  href,
}: {
  readonly status: CourseRunStatus;
  /** Where the run's progress is followed. */
  readonly href: string;
}) {
  const { t } = useI18n();
  const paused = status.kind === 'paused';
  return (
    <div
      className="flex flex-1 items-center justify-center bg-gray-50 px-6 dark:bg-gray-900"
      data-testid="course-generating-placeholder"
      data-run-state={status.kind}
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <CourseRunStatusIcon
          status={status}
          className={cn('size-8', paused ? 'text-amber-500' : 'text-violet-500')}
        />
        <p className="text-base font-medium">
          {paused ? t('workspace.coursePausedTitle') : t('workspace.courseGeneratingTitle')}
        </p>
        <p
          className={cn(
            'rounded-full px-2.5 py-0.5 text-xs font-medium',
            paused
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
              : 'bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400',
          )}
          data-testid="course-generating-progress"
        >
          {courseRunStatusText(status, t)}
        </p>
        <p className="text-sm text-muted-foreground">
          {paused ? t('workspace.coursePausedDesc') : t('workspace.courseGeneratingDesc')}
        </p>
        <a
          href={href}
          target="_blank"
          rel="noopener"
          data-testid="course-generating-link"
          className="mt-1 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-violet-700 hover:bg-violet-600/10 dark:text-violet-300 dark:hover:bg-violet-400/10"
        >
          {paused ? t('workspace.openToRetry') : t('workspace.viewGenerationProgress')}
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
