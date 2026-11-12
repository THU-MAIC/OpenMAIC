'use client';

import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useRouter, useSearchParams } from 'next/navigation';
import type { StageMode } from '@/lib/types/stage';
import { classroomExitLabelKey, exitClassroom } from '@/lib/workbench/classroom-exit';
import { HeaderControls } from './stage/header-controls';
import { ClassroomFullHeader } from '@/components/workbench/ClassroomFullHeader';
import { useStageStore } from '@/lib/store';

interface HeaderProps {
  readonly currentSceneTitle: string;
  readonly mode?: StageMode;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  /** See `HeaderControls`: Learn | Edit and the way into the workspace. */
  readonly workbenchControls?: boolean;
  readonly onOpenInWorkspace?: () => void;
  readonly makeOwnCourseHref?: string;
}

/**
 * The standalone classroom's header (`/classroom/[id]`). A classroom hosted
 * in the workspace has no header of its own: the pane draws one around it.
 *
 * Where the workbench is part of the build (`workbenchControls`), the page is
 * the workspace's full-screen classroom entered from outside, and wears its
 * header (`ClassroomFullHeader`): the course, the scene's title, then
 * the export control and — for the owner — Learn | Edit and the way into the
 * workspace; for a viewer, the way to a course of their own instead. The
 * language / theme / settings pill is not part of it: the workbench keeps
 * those in its account menu. Without the workbench, the classic header below.
 */
export function Header({
  currentSceneTitle,
  mode,
  canEdit,
  onToggleEditMode,
  workbenchControls,
  onOpenInWorkspace,
  makeOwnCourseHref,
}: HeaderProps) {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const exitLabel = t(classroomExitLabelKey(searchParams));
  const courseName = useStageStore((s) => s.stage?.name) || t('workspace.untitledCourse');

  if (workbenchControls) {
    return (
      <ClassroomFullHeader
        testId="classroom-full-header"
        className="px-3 sm:pl-6 sm:pr-5"
        courseName={courseName}
        sceneTitle={currentSceneTitle}
        actions={
          <HeaderControls
            variant="compact"
            showGlobalControls={false}
            showCourseActions
            mode={mode}
            canEdit={canEdit}
            onToggleEditMode={onToggleEditMode}
            workbenchControls
            onOpenInWorkspace={onOpenInWorkspace}
            makeOwnCourseHref={makeOwnCourseHref}
          />
        }
      />
    );
  }

  return (
    <>
      <header className="h-20 px-8 flex items-center justify-between z-10 bg-transparent gap-4">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            data-testid="classroom-exit"
            onClick={() => exitClassroom(router, searchParams)}
            className="shrink-0 p-2 rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            title={exitLabel}
            aria-label={exitLabel}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          {/* Title block — hidden when `mode === 'edit'`. Header lives
              inside `PlaybackChromeRoot`, which is unmounted by `Stage`
              once mode flips to 'edit', so in steady state this branch
              is always taken. The guard exists for the ~280ms
              AnimatePresence exit window where the playback chrome
              is still rendering its exit animation while `mode` has
              already flipped — without the guard, this title would
              briefly stack on top of the incoming EditChromeRoot's
              CommandBar title during the cross-fade. */}
          {mode !== 'edit' && (
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] uppercase tracking-widest font-bold text-gray-400 dark:text-gray-500 mb-0.5">
                {t('stage.currentScene')}
              </span>
              <h1
                className="text-xl font-bold text-gray-800 dark:text-gray-200 tracking-tight truncate"
                suppressHydrationWarning
              >
                {currentSceneTitle || t('common.loading')}
              </h1>
            </div>
          )}
        </div>

        <HeaderControls
          mode={mode}
          canEdit={canEdit}
          onToggleEditMode={onToggleEditMode}
          workbenchControls={workbenchControls}
          onOpenInWorkspace={onOpenInWorkspace}
          makeOwnCourseHref={makeOwnCourseHref}
        />
      </header>
    </>
  );
}
