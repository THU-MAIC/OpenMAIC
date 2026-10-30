'use client';

/**
 * The classroom pane — the third column, and the REAL classroom inside it.
 *
 * Not a preview and not an iframe: `ClassroomSurface` is the same component
 * `/classroom/[id]` mounts, wrapped in `WorkbenchPanelProvider` so the chrome
 * it does not need in here (its own header, its edit control, the global
 * controls) drops out. The provider is applied HERE rather than around the
 * element that built it because React resolves context by where an element
 * renders, not where it was constructed.
 *
 * One classroom, two sizes. Split beside the conversation, the header is the
 * tab strip, Learn | Edit and ⛶. Full screen (the rail and the conversation
 * step aside) it keeps a header: ← leaves this course on the left, and in the
 * same corner as ⛶ the Learn | Edit switch and ⤡, which collapses back to the
 * split view with the course still open (Esc does the same). Editing works at
 * both sizes.
 *
 * Read-only. A course saved from elsewhere is not yours to edit: the classroom
 * already refuses (`isOwner` gates editing, and the server would refuse the
 * write anyway), so this header only NAMES that state. Learning a saved
 * course, at either size, is a perfectly legitimate thing to do with one.
 */

import { ArrowLeft, Eye, Maximize, Minimize2 } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useState } from 'react';
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
import { useEditorWarmup } from '@/lib/edit/use-editor-warmup';
import { shouldCollapseFullscreenOnEscape } from '@/lib/workbench/classroom-fullscreen';
import { HeaderControls } from '@/components/stage/header-controls';
import { ClassroomModeSwitch } from '@/components/workbench/ClassroomModeSwitch';
import { WorkspaceCourseTabs, type WorkspaceCourseTabItem } from './WorkspaceCourseTabs';
import { PaneFoldButton } from './PaneFoldButton';

export const WorkspaceClassroomPane = memo(function WorkspaceClassroomPane({
  browser,
  readOnly,
  fullscreen,
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
    /** The course this pane shows: always a real course id. */
    readonly activeCourseId: string;
    /**
     * The tab the strip marks selected, when it is not the course (the request
     * preview's tab). Selection only: nothing loads, stores or navigates by it.
     */
    readonly selectedTabId?: string;
    readonly onActivateCourse: (courseId: string) => void;
    /**
     * The real close: closing the last tab drops `?course=`, shuts the pane and
     * forgets this chat's set. `onCollapse` below is minimise and preserves it.
     */
    readonly onCloseCourse: (courseId: string) => void;
  };
  readonly readOnly: boolean;
  /**
   * Full screen: the pane is the whole window (the rail and the conversation
   * step aside), with a header of its own — leave the course on the left, the
   * Learn | Edit switch and the collapse button on the right. Learning and
   * editing both work here; the per-course preference carries across.
   */
  readonly fullscreen: boolean;
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
  const currentSceneId = useStageStore((s) => s.currentSceneId);
  const courseGenerating = useStageStore((s) => s.courseGenerating);
  const setFullscreen = useWorkbenchStore((s) => s.setPlaybackOn);
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
  // Full screen does not force learning: it is a size, not a mode.
  const learning = !editingAllowed || preferences[courseId] !== 'editing';
  // Load the editor while the course is shown in Learn mode, so the first switch
  // to Edit does not wait on its download. Only where the switch is offered.
  const warmEditorNow = useEditorWarmup(editingAllowed && learning && !hidden);

  const rememberMode = (mode: ClassroomMode) => {
    setPreferences((previous) => ({ ...previous, [courseId]: mode }));
    writeClassroomMode(courseId, mode);
  };
  // Pro-mode sizing for a hosted classroom: fill the 16:9 card instead of
  // keeping the full-page editor's studio margin, which reads as a second
  // letterbox inside a pane.
  useWorkbenchProEditing();

  // Esc collapses full screen back to the split view, the course still open.
  // Bubbling phase, so an editor, a menu or a dialog that handles Esc itself
  // (and marks the event handled) keeps it.
  useEffect(() => {
    if (!fullscreen || hidden) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldCollapseFullscreenOnEscape(event)) setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen, hidden, setFullscreen]);

  const modeSwitch = (
    <ClassroomModeSwitch
      learning={learning}
      editingAllowed={editingAllowed}
      editingHint={courseGenerating ? t('workspace.editingUnavailableGenerating') : undefined}
      onLearn={() => rememberMode('learning')}
      onEdit={() => {
        if (editingAllowed) rememberMode('editing');
      }}
      onEditIntent={warmEditorNow}
    />
  );

  const courseName =
    browser.tabs.find((tab) => tab.id === courseId)?.name || t('workspace.untitledCourse');
  const sceneIndex = scenes.findIndex((scene) => scene.id === currentSceneId);
  const scene = sceneIndex >= 0 ? scenes[sceneIndex] : undefined;

  return (
    <section
      data-testid="workspace-classroom-pane"
      data-fullscreen={fullscreen || undefined}
      aria-label={t('workspace.classroomPaneAria')}
      aria-hidden={hidden || undefined}
      className={cn(
        'ws-pane ws-pane-last h-full min-w-0 flex-1 flex-col',
        fullscreen && 'ws-classroom-fullscreen',
        // Opening the pane (a course handed over from the request preview, or
        // opened from the library) comes in from the right edge as the
        // conversation narrows beside it, rather than snapping.
        'ws-pane-enter',
        hidden ? 'hidden' : 'flex',
      )}
    >
      {!fullscreen ? (
        <header
          data-testid="workbench-editor-header"
          className="ws-pane-head ws-classroom-head flex shrink-0 items-center px-2"
        >
          {/* Fold FIRST, at the seam side. The conversation folds from the right
              edge of its own header (◀) and the classroom folds from the left of
              its header (▶): the two buttons flank the shared seam and point
              outward, reading as "push each pane away from the middle". It is
              the one pane-scope control left of the tab strip; every other one
              stays on the right. */}
          {onCollapse ? (
            <span className="flex shrink-0 items-center">
              <PaneFoldButton
                className="ws-pane-fold"
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
            activeCourseId={browser.selectedTabId ?? browser.activeCourseId}
            onActivate={browser.onActivateCourse}
            onClose={browser.onCloseCourse}
          />
          <span className="ws-ctabs-rule" aria-hidden="true" />
          {readOnly ? <ReadOnlyBadge /> : null}
          {modeSwitch}
          <span className="ws-vsep" aria-hidden="true" />
          <button
            type="button"
            data-testid="workbench-start-learning"
            disabled={scenes.length === 0 || loadedCourseId !== courseId}
            onClick={() => setFullscreen(true)}
            aria-label={t('workspace.fullscreen.expand')}
            title={t('workspace.fullscreen.expand')}
            className="ws-head-icon"
          >
            <Maximize className="size-4" aria-hidden="true" />
          </button>
        </header>
      ) : (
        <header
          data-testid="workbench-fullscreen-header"
          className="ws-full-head flex shrink-0 items-center gap-3 pl-4 pr-3"
        >
          {/* Leave THIS course: its tab closes and the workspace comes back
              around whatever is left — the conversation, the other tabs. */}
          <button
            type="button"
            data-testid="workbench-leave-course"
            onClick={() => {
              setFullscreen(false);
              browser.onCloseCourse(courseId);
            }}
            title={t('workspace.fullscreen.leaveHint')}
            className="ws-full-leave"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            <span>{t('workspace.fullscreen.leave')}</span>
          </button>
          <div className="min-w-0 flex-1">
            <div className="ws-full-crumb truncate">
              {courseName}
              {scene ? (
                <>
                  <span aria-hidden="true"> · </span>
                  {t('workspace.pagePosition', { index: sceneIndex + 1, total: scenes.length })}
                </>
              ) : null}
            </div>
            <div className="ws-full-title truncate" data-testid="workbench-fullscreen-title">
              {scene?.title || courseName}
            </div>
          </div>
          {readOnly ? <ReadOnlyBadge /> : null}
          {/* Export and sharing, which the split view leaves to this size. */}
          <HeaderControls variant="compact" showGlobalControls={false} showCourseActions />
          {modeSwitch}
          <span className="ws-vsep" aria-hidden="true" />
          <button
            type="button"
            data-testid="workbench-exit-fullscreen"
            onClick={() => setFullscreen(false)}
            aria-label={t('workspace.fullscreen.collapse')}
            title={t('workspace.fullscreen.collapse')}
            className="ws-head-icon ws-head-icon-on"
          >
            <Minimize2 className="size-4" aria-hidden="true" />
          </button>
        </header>
      )}

      {/* One course surface for both modes and both sizes. Generation and access
          gates override remembered editing without overwriting the course's
          preference. */}
      <div className="ws-classroom-body relative flex min-h-0 flex-1">
        <WorkbenchPanelProvider visible={!hidden} learning={learning}>
          <ClassroomSurface classroomId={courseId} variant="pane" />
        </WorkbenchPanelProvider>
      </div>
    </section>
  );
});

function ReadOnlyBadge() {
  const { t } = useI18n();
  return (
    <span className="ws-readonly shrink-0" data-testid="workspace-readonly-badge">
      <Eye className="size-3" aria-hidden="true" />
      {t('workspace.readOnlyBadge')}
    </span>
  );
}
