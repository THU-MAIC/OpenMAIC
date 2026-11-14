'use client';

/**
 * The full-screen classroom's header: where you are on the left (the course,
 * then the scene's title), the controls on the right. The page position is the
 * playback toolbar's (8 / 9) alone; saying it here too only repeated it.
 *
 * Shared by the workspace's classroom pane at full screen and, where the
 * workbench is part of the build, the standalone classroom page, so a course
 * reads the same wherever it fills the window. The caller supplies the
 * controls; owner-only ones are simply not passed for a viewer.
 *
 * Tailwind rather than the workspace stylesheet: the standalone classroom page
 * renders this too, and that route does not load `workspace-shell.css`.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export function ClassroomFullHeader({
  courseName,
  sceneTitle,
  actions,
  testId = 'workbench-fullscreen-header',
  className,
}: {
  readonly courseName: string;
  /** The current scene's title; the course name stands in when there is none. */
  readonly sceneTitle?: string;
  readonly actions: ReactNode;
  readonly testId?: string;
  readonly className?: string;
}) {
  return (
    <header
      data-testid={testId}
      className={cn(
        'relative z-[5] flex h-14 shrink-0 items-center gap-2 pl-4 pr-3 sm:gap-3',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] tracking-[0.02em] text-slate-500 dark:text-slate-400">
          {courseName}
        </div>
        <div
          className="mt-px truncate text-[15.5px] font-[650] text-slate-900 dark:text-slate-50"
          data-testid="workbench-fullscreen-title"
          suppressHydrationWarning
        >
          {sceneTitle || courseName}
        </div>
      </div>
      {actions}
    </header>
  );
}
