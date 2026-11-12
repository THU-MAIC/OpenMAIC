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

import { CircleHelp, Eye, Maximize, MessagesSquare, Minimize2 } from 'lucide-react';
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
import { useEditorWarmup, warmEditorSurfaces } from '@/lib/edit/use-editor-warmup';
import { shouldCollapseFullscreenOnEscape } from '@/lib/workbench/classroom-fullscreen';
import { HeaderControls } from '@/components/stage/header-controls';
import { ClassroomModeSwitch } from '@/components/workbench/ClassroomModeSwitch';
import {
  markOnboardingSeen,
  resetOnboarding,
  useOnboardingPending,
  useTourActive,
} from '@/lib/workbench/onboarding';
import { WorkspaceCourseTabs, type WorkspaceCourseTabItem } from './WorkspaceCourseTabs';
import { WorkspaceTour } from './WorkspaceTour';
import { EDIT_TOUR_STEPS } from './edit-tour-steps';

const noop = () => {};
import { PaneFoldButton } from './PaneFoldButton';
import { ClassroomFullHeader } from '@/components/workbench/ClassroomFullHeader';

export const WorkspaceClassroomPane = memo(function WorkspaceClassroomPane({
  browser,
  readOnly,
  readOnlyKnown = true,
  fullscreen,
  hidden,
  onCollapse,
  onTalkAboutCourse,
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
   * Whether the viewer's access is known yet. A course whose access is still
   * being asked about is read-only, but is not labelled so until it is.
   */
  readonly readOnlyKnown?: boolean;
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
  /**
   * The course was browsed, so no conversation is beside it: the header offers
   * one about it ("Edit with AI"). Absent otherwise.
   */
  readonly onTalkAboutCourse?: () => void;
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
  const [historySlot, setHistorySlot] = useState<HTMLDivElement | null>(null);

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
  // A course remembered in Edit opens straight into the editor, so its chunks
  // are needed the moment the document lands. Fetch them alongside the document
  // rather than after it, which would hold the blank editor shell for the extra
  // round trips.
  const opensInEditor = preferences[courseId] === 'editing';
  useEffect(() => {
    if (opensInEditor && !hidden) warmEditorSurfaces();
  }, [opensInEditor, hidden]);

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

  // The one-time hint, the first time any course is on screen here.
  const hintPending = useOnboardingPending('pane');
  const tourActive = useTourActive();
  // The Edit tour, the first time the viewer edits a course of theirs. It
  // replaces the Learn/Edit hint there rather than stacking on it. (Not gated
  // on `tourActive`: that flag is the playing tour's own, this one's included.)
  const editTourPending = useOnboardingPending('edit');
  const showEditTour =
    editTourPending &&
    !learning &&
    editingAllowed &&
    !hidden &&
    !fullscreen &&
    loadedCourseId === courseId;
  // Replaying the Edit tour lives where it applies: in Edit mode, on a course
  // the viewer can edit. Clearing the mark is enough; `showEditTour` picks it up.
  const editGuideButton =
    !learning && editingAllowed && loadedCourseId === courseId && !showEditTour ? (
      <button
        type="button"
        data-testid="workspace-edit-guide"
        onClick={() => resetOnboarding('edit')}
        aria-label={t('workspace.editGuide')}
        title={t('workspace.editGuide')}
        className="ws-head-icon"
      >
        <CircleHelp className="size-4" aria-hidden="true" />
      </button>
    ) : null;
  // The Learn / Edit hint is for a course the viewer can edit: on a read-only
  // one (someone else's, or not yet known to be theirs) there is no Edit.
  const showHint =
    hintPending &&
    !readOnly &&
    learning &&
    !tourActive &&
    !fullscreen &&
    !hidden &&
    loadedCourseId === courseId &&
    scenes.length > 0;

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
        'ws-pane ws-pane-last relative h-full min-w-0 flex-1 flex-col',
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
          {readOnly && readOnlyKnown ? <ReadOnlyBadge /> : null}
          {/* The editor portals its undo/redo here while editing; empty, it
              takes no space. It sits with the other editing control (the
              tour's ?) just before Learn | Edit. */}
          <div
            ref={setHistorySlot}
            data-testid="workspace-history-slot"
            className="flex shrink-0 items-center gap-0.5 empty:hidden"
          />
          {editGuideButton}
          {onTalkAboutCourse ? (
            <button
              type="button"
              data-testid="workspace-talk-about-course"
              onClick={onTalkAboutCourse}
              title={t('workspace.talkAboutCourseHint')}
              className="ws-head-chat"
            >
              <MessagesSquare className="size-4" aria-hidden="true" />
              <span>{t('workspace.talkAboutCourse')}</span>
            </button>
          ) : null}
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
        <ClassroomFullHeader
          courseName={courseName}
          sceneTitle={scene?.title}
          actions={
            <>
              {readOnly && readOnlyKnown ? <ReadOnlyBadge /> : null}
              {/* Export and sharing, which the split view leaves to this size. */}
              <HeaderControls variant="compact" showGlobalControls={false} showCourseActions />
              {/* The editor portals its undo/redo here while editing; empty, it
              takes no space. It sits with the other editing control (the
              tour's ?) just before Learn | Edit. */}
              <div
                ref={setHistorySlot}
                data-testid="workspace-history-slot-fullscreen"
                className="flex shrink-0 items-center gap-0.5 empty:hidden"
              />
              {editGuideButton}
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
            </>
          }
        />
      )}

      {showHint ? <PaneHint /> : null}
      {showEditTour ? (
        <WorkspaceTour
          steps={EDIT_TOUR_STEPS}
          doneLabel="workspace.tour.editDone"
          onNavigate={noop}
          onSendExample={noop}
          onEnd={() => {
            markOnboardingSeen('edit');
            markOnboardingSeen('pane');
          }}
        />
      ) : null}

      {/* One course surface for both modes and both sizes. Generation and access
          gates override remembered editing without overwriting the course's
          preference. */}
      <div className="ws-classroom-body relative flex min-h-0 flex-1">
        <WorkbenchPanelProvider visible={!hidden} learning={learning} historySlot={historySlot}>
          <ClassroomSurface classroomId={courseId} variant="pane" />
        </WorkbenchPanelProvider>
      </div>
    </section>
  );
});

/**
 * Learn vs Edit, and that the conversation can change the course too. Shown
 * once, the first time a course opens in this pane; it points at the switch.
 */
function PaneHint() {
  const { t } = useI18n();
  return (
    <div role="note" className="ws-pane-hint" data-testid="workspace-pane-hint">
      <div className="ws-pane-hint-title">{t('workspace.onboarding.paneTitle')}</div>
      <ul>
        <li>{t('workspace.onboarding.paneLearn')}</li>
        <li>{t('workspace.onboarding.paneEdit')}</li>
        <li>{t('workspace.onboarding.paneChat')}</li>
      </ul>
      <div className="ws-pane-hint-foot">
        <button
          type="button"
          data-testid="workspace-pane-hint-ok"
          className="ws-pane-hint-ok"
          onClick={() => markOnboardingSeen('pane')}
        >
          {t('workspace.onboarding.gotIt')}
        </button>
      </div>
    </div>
  );
}

function ReadOnlyBadge() {
  const { t } = useI18n();
  return (
    <span className="ws-readonly shrink-0" data-testid="workspace-readonly-badge">
      <Eye className="size-3" aria-hidden="true" />
      {t('workspace.readOnlyBadge')}
    </span>
  );
}
