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

import { Eye, Play } from 'lucide-react';
import { memo } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
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
    /** The open courses, in tab order — id, display name, and whether one is being written. */
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
  const setPlaybackOn = useWorkbenchStore((s) => s.setPlaybackOn);

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
          {/* The workspace frames playback as LEARNING, not presenting: a soft
              accent-wash chip (the product violet at tint strength) instead of
              a solid dark block — an invitation, not an office command. The
              1px hover lift is the shell's standard hover vocabulary. */}
          <button
            type="button"
            data-testid="workbench-start-learning"
            disabled={scenes.length === 0}
            onClick={() => setPlaybackOn(true)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-violet-600/10 px-3 text-[11px] font-medium text-violet-700 transition-[background-color,color,transform,box-shadow] duration-150',
              'hover:bg-violet-600/15 hover:shadow-sm motion-safe:hover:-translate-y-px disabled:pointer-events-none disabled:opacity-40',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              'dark:bg-violet-400/10 dark:text-violet-300 dark:hover:bg-violet-400/15 dark:hover:shadow-none',
            )}
          >
            <Play className="size-3.5" aria-hidden="true" />
            {t('workspace.startLearning')}
          </button>
        </header>
      )}

      {/* The real classroom chrome. Course identity alone owns its lifecycle;
          chat/session activity is deliberately absent from this boundary.

          This provider is also the EDIT LOCK. Every way a classroom reaches
          the right pane — the agent creating one mid-conversation, a restored
          tab, a tab switch, a reload — comes through this one element, so the
          lock is a property of the pane rather than a default each entry path
          has to remember. `visible && !playback` is the whole rule: what the
          classroom document or the stage store says about play/edit does not
          participate. */}
      <div className="ws-classroom-body relative flex min-h-0 flex-1">
        <WorkbenchPanelProvider visible={!hidden} playback={playback}>
          <ClassroomSurface classroomId={courseId} variant="pane" />
        </WorkbenchPanelProvider>
      </div>
    </section>
  );
});
