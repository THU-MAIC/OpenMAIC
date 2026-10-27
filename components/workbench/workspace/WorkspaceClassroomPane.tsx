'use client';

/**
 * The classroom pane — the third column, and the REAL classroom inside it.
 *
 * Not a preview and not an iframe: `ClassroomSurface` is the same component
 * `/classroom/[id]` mounts, wrapped in `WorkbenchPanelProvider` so the chrome
 * it does not need in here (its own header, the Pro switch, the global
 * controls) drops out. The provider is applied HERE rather than around the
 * element that built it because React resolves context by where an element
 * renders, not where it was constructed.
 *
 * Read-only. A course saved from Discover is not yours to edit: the classroom
 * already refuses (`isOwner` gates the Pro switch and the auto-edit entry, and
 * the server would refuse the write anyway), so this header only NAMES that
 * state. The start-learning button stays — learning (playing back) a saved
 * course is a perfectly legitimate thing to do with one.
 */

import { Eye, Maximize, BookOpen, Pencil } from 'lucide-react';
import { memo, useLayoutEffect, useState } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  readClassroomMode,
  writeClassroomMode,
  type ClassroomMode,
} from '@/lib/workbench/classroom-mode';
import { cn } from '@/lib/utils/cn';
import { ClassroomSurface } from '@/components/classroom/ClassroomSurface';
import { useStageStore } from '@/lib/store/stage';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { WorkbenchPanelProvider } from '@/lib/workbench/panel-context';
import { useWorkbenchProEditing } from '@/lib/workbench/use-workbench-pro-edit';
import { WorkspaceCourseTabs, type WorkspaceCourseTabItem } from './WorkspaceCourseTabs';
import { PaneFoldButton } from './PaneFoldButton';

export const WorkspaceClassroomPane = memo(function WorkspaceClassroomPane({
  browser,
  readOnly,
  playback,
  hidden,
  onCollapse,
}: {
  /**
   * The tab strip's state and callbacks. The pane owns no tab state: the
   * ordered set, the active id and the URL all live in the shell, and this is
   * the seam they arrive through.
   */
  readonly browser: {
    /** The open courses, in tab order. */
    readonly tabs: readonly WorkspaceCourseTabItem[];
    readonly activeCourseId: string;
    readonly onActivateCourse: (courseId: string) => void;
    /**
     * The real close: closing the last tab drops `?course=`, shuts the pane and
     * forgets this chat's set. `onCollapse` below is minimise and preserves it.
     */
    readonly onCloseCourse: (courseId: string) => void;
  };
  readonly readOnly: boolean;
  /** Full-screen playback: the pane is the whole surface and drops its header. */
  readonly playback: boolean;
  /**
   * Collapsed. Hidden rather than unmounted: remounting would run the whole
   * classroom load again — clearing the media store and the whiteboard
   * history on the way — for a course that never changed. `Stage` still drops
   * out of edit mode because this pane publishes visibility through its host
   * context; the attached Chat store is not involved.
   */
  readonly hidden: boolean;
  /**
   * Minimise this pane, leaving its reopen tab and this chat's remembered set
   * intact. Rendered at the end of the pane's own header — see `PaneFoldButton`
   * for why it is not a grip on the seam any more.
   */
  readonly onCollapse?: () => void;
}) {
  const courseId = browser.activeCourseId;
  const { t } = useI18n();
  const scenes = useStageStore((s) => s.scenes);
  const courseGenerating = useStageStore((s) => s.courseGenerating);
  const setPlaybackOn = useWorkbenchStore((s) => s.setPlaybackOn);
  const loadedCourseId = useStageStore((s) => s.stage?.id);
  const isOwner = useStageStore((s) => s.isOwner);
  const stageReadOnly = useStageStore((s) => s.readOnly);
  const [preferences, setPreferences] = useState<Record<string, ClassroomMode>>({});

  useLayoutEffect(() => {
    // Apply browser memory before paint. A different course never inherits an
    // edit preference during its first render or while its document is loading.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the browser preference before painting this course
    setPreferences((previous) =>
      previous[courseId] ? previous : { ...previous, [courseId]: readClassroomMode(courseId) },
    );
  }, [courseId]);
  const editingAllowed =
    loadedCourseId === courseId &&
    isOwner &&
    !stageReadOnly &&
    !readOnly &&
    !courseGenerating &&
    scenes.length > 0;
  const learning = playback || !editingAllowed || preferences[courseId] !== 'editing';

  const rememberMode = (mode: ClassroomMode) => {
    setPreferences((previous) => ({ ...previous, [courseId]: mode }));
    writeClassroomMode(courseId, mode);
  };
  // Pro-mode sizing for a hosted classroom: fill the 16:9 card instead of
  // keeping the full-page editor's studio margin, which reads as a second
  // letterbox inside a pane.
  useWorkbenchProEditing();

  return (
    <section
      data-testid="workspace-classroom-pane"
      aria-label={t('workspace.classroomPaneAria')}
      aria-hidden={hidden || undefined}
      className={cn(
        'ws-pane ws-pane-last h-full min-w-0 flex-1 flex-col',
        // Opening the pane (a course handed over from the request preview, or
        // opened from the library) fades in rather than snapping.
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500',
        hidden ? 'hidden' : 'flex',
      )}
    >
      {playback ? null : (
        <header
          data-testid="workbench-editor-header"
          className="ws-pane-head ws-classroom-head flex shrink-0 items-center px-2"
        >
          {/* Fold FIRST, at the seam side. The conversation folds from the right
              edge of its own header (◀) and the classroom folds from the left of
              its header (▶): the two buttons flank the shared seam and point
              outward, reading as "push each pane away from the middle". Its ▶
              still names where the pane goes (off to the right), even though the
              button sits on the left. It is the one pane-scope control left of the
              tab strip; every other one stays on the right. */}
          {onCollapse ? (
            <span className="mr-1 flex shrink-0 items-center">
              <PaneFoldButton
                testId="workspace-classroom-fold"
                label={t('workspace.collapseClassroom')}
                direction="right"
                onClick={onCollapse}
              />
            </span>
          ) : null}
          {/* The name half of the header IS the tab strip — see
              `WorkspaceCourseTabs`. A hairline marks where scope changes:
              everything between the fold and it acts on ONE tab, everything right
              of it acts on the whole pane. There is deliberately no pane-level
              CLOSE: the × lives on a tab, closing the last one closes the pane,
              and folding covers "not now". */}
          <WorkspaceCourseTabs
            tabs={browser.tabs}
            activeCourseId={browser.activeCourseId}
            onActivate={browser.onActivateCourse}
            onClose={browser.onCloseCourse}
          />
          <span className="ws-ctabs-rule" aria-hidden="true" />
          {readOnly ? (
            <span className="ws-readonly shrink-0" data-testid="workspace-readonly-badge">
              <Eye className="size-3" aria-hidden="true" />
              {t('workspace.readOnlyBadge')}
            </span>
          ) : null}
          <div
            role="group"
            aria-label={t('workspace.classroomMode')}
            className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5"
          >
            <button
              type="button"
              data-testid="workbench-mode-learning"
              aria-pressed={learning}
              onClick={() => {
                rememberMode('learning');
              }}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                learning
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <BookOpen className="size-3.5" aria-hidden="true" />
              {t('workspace.learningMode')}
            </button>
            <button
              type="button"
              data-testid="workbench-mode-editing"
              aria-pressed={!learning}
              disabled={!editingAllowed}
              onClick={() => {
                if (editingAllowed) rememberMode('editing');
              }}
              title={courseGenerating ? t('workspace.editingUnavailableGenerating') : undefined}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                !learning
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              {t('workspace.editingMode')}
            </button>
          </div>
          <button
            type="button"
            data-testid="workbench-start-learning"
            disabled={scenes.length === 0 || loadedCourseId !== courseId}
            onClick={() => setPlaybackOn(true)}
            aria-label={t('workspace.fullscreenLearning')}
            title={t('workspace.fullscreenLearning')}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Maximize className="size-3.5" aria-hidden="true" />
          </button>
        </header>
      )}

      {/* One course surface for both modes. Generation and access gates override
          remembered editing without overwriting the course's preference. */}
      <div className="ws-classroom-body relative flex min-h-0 flex-1">
        <WorkbenchPanelProvider visible={!hidden} playback={playback} learning={learning}>
          <ClassroomSurface classroomId={courseId} variant="pane" />
        </WorkbenchPanelProvider>
      </div>
    </section>
  );
});
