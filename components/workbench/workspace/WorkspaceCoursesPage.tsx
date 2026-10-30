'use client';

/**
 * "My courses" — the owner's course library as a page in the main area.
 *
 * The library's one home in the workspace (the rail lists conversations
 * only): folders as cards, courses as thumbnails, a name filter, the two ways
 * to add to the library (import a course package, make a folder), and every
 * card's ⋯ — rename in place, file into or out of a folder, delete. Courses a
 * run is still producing show its progress and are not maintained until it
 * ends; a run whose course does not exist yet is a placeholder card that can
 * be discarded. Everything reads the one `useHomeDiscovery` list, so this page,
 * the classroom tab strip and the composer's `@` picker cannot disagree.
 *
 * Opening a course opens it in the classroom pane.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FolderInput, FolderOpen, FolderPlus, Search, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { Slide } from '@openmaic/dsl';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { useHomeDiscovery } from '@/lib/hooks/use-home-discovery';
import { useCourseThumbnails } from '@/lib/hooks/use-course-thumbnails';
import { useNearViewport } from '@/lib/hooks/use-near-viewport';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { ThumbnailSkeleton } from '@/components/discovery/thumbnail-skeleton';
import {
  CourseRunStatusIcon,
  courseRunStatusText,
} from '@/components/generation/course-run-status-label';
import {
  courseRunHref,
  courseRunStatus,
  pendingCourseName,
} from '@/lib/generation-run-client/course-card';
import type { RunSnapshot } from '@/lib/generation-run-client/types';
import { filterByName } from '@/lib/workbench/workspace-tree';
import { apiRenameStage, StageRenameError, STAGE_NAME_MAX_LENGTH } from '@/lib/live/server-api';
import {
  displayNameWidth,
  FOLDER_NAME_MAX_WIDTH,
  validateFolderName,
} from '@/lib/utils/folder-name-validation';
import { MoveToFolderMenu } from '@/components/discovery/move-to-folder-menu';
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  workspaceFolderAdapter,
  workspaceFoldersAvailable,
  WorkspaceFolderNameError,
} from './workspace-folder-seam';
import { InlineNameRow, WorkspaceRowMenu } from './workspace-row-controls';
import { cn } from '@/lib/utils/cn';

type Discovery = ReturnType<typeof useHomeDiscovery>;
type Course = Discovery['classrooms'][number];

export function WorkspaceCoursesPage({
  courses,
  courseRuns,
  pendingRuns,
  onOpenCourse,
  onDeleteCourse,
  onDiscardRun,
}: {
  readonly courses: Discovery;
  readonly courseRuns: ReadonlyMap<string, RunSnapshot>;
  readonly pendingRuns: readonly RunSnapshot[];
  readonly onOpenCourse: (courseId: string) => void;
  /** The shell deletes the course AND closes its classroom tab on success. */
  readonly onDeleteCourse: (courseId: string) => Promise<void> | void;
  /** Discard a run whose course does not exist yet. */
  readonly onDiscardRun?: (runId: string) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  /** The folder being looked into; null is the whole library. */
  const [folderId, setFolderId] = useState<string | null>(null);
  const foldersAvailable = workspaceFoldersAvailable();
  const { thumbnails, requestThumbnail, retainThumbnails } = useCourseThumbnails();

  // Which card is an input right now: one at a time.
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingCourseId, setRenamingCourseId] = useState<string | null>(null);
  /** The folder whose delete has been asked for, and not yet answered. */
  const [folderToDelete, setFolderToDelete] = useState<{ id: string; name: string } | null>(null);

  const submitFolderRename = useCallback(
    async (folderId: string, name: string): Promise<string | null> => {
      const widthCheck = validateFolderName(name);
      if (!widthCheck.ok) {
        return widthCheck.kind === 'empty'
          ? t('classroom.folderNameEmpty')
          : t('classroom.folderWidth', { width: widthCheck.width, max: FOLDER_NAME_MAX_WIDTH });
      }
      const trimmed = name.trim();
      // Unchanged is not a rename; leave editing without writing anything.
      if (courses.folders.find((folder) => folder.id === folderId)?.name === trimmed) return null;
      if (
        courses.folders.some(
          (folder) => folder.id !== folderId && folder.name.toLowerCase() === trimmed.toLowerCase(),
        )
      ) {
        return t('classroom.folderNameExists');
      }
      try {
        if (!workspaceFolderAdapter) return t('workspace.foldersUnavailable');
        await workspaceFolderAdapter.rename(folderId, trimmed);
        await courses.reload();
        return null;
      } catch (caught) {
        if (caught instanceof WorkspaceFolderNameError) {
          if (caught.kind === 'duplicate') return t('classroom.folderNameExists');
          if (caught.kind === 'tooLong') {
            return t('classroom.folderWidth', {
              width: displayNameWidth(trimmed),
              max: FOLDER_NAME_MAX_WIDTH,
            });
          }
          if (caught.kind === 'empty') return t('classroom.folderNameEmpty');
          return t('classroom.folderNameHint');
        }
        return t('classroom.folderRenameFailed');
      }
    },
    [courses, t],
  );

  /**
   * Commit a course rename through `PATCH /api/stages/:id` — the route owns the
   * owner gate and the write, so this only maps its refusals onto copy. NOT the
   * storage boundary's `renameStage`: that reads and rewrites the whole document
   * client-side, which a name change in a list has no reason to do.
   */
  const submitCourseRename = useCallback(
    async (courseId: string, name: string): Promise<string | null> => {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > STAGE_NAME_MAX_LENGTH) {
        return t('workspace.renameInvalid');
      }
      if (courses.classrooms.find((course) => course.id === courseId)?.name === trimmed)
        return null;
      try {
        await apiRenameStage(courseId, trimmed);
        // The authoritative list is what every surface reads a course's name
        // from — this card, the classroom tab strip, an in-chat course link.
        // One reload renames all of them.
        await courses.reload();
        return null;
      } catch (caught) {
        if (caught instanceof StageRenameError) {
          if (caught.kind === 'invalidName') return t('workspace.renameInvalid');
          if (caught.kind === 'forbidden') return t('workspace.renameForbidden');
          if (caught.kind === 'notFound') return t('workspace.renameGone');
        }
        return t('classroom.renameFailed');
      }
    },
    [courses, t],
  );

  /**
   * Delete a folder, keeping its courses (`mode=ungroup`, the endpoint's
   * default): they return to the library's top level. The destructive mode that
   * also deletes the courses is deliberately NOT offered here — a container's ⋯
   * must not be able to destroy work.
   */
  const deleteFolderKeepingCourses = useCallback(
    async (folderId: string) => {
      try {
        if (!workspaceFolderAdapter) return;
        await workspaceFolderAdapter.removeKeepingCourses(folderId);
      } catch {
        toast.error(t('classroom.folderDeleteFailed'));
      } finally {
        // Either way: the page must show what the server actually has.
        await courses.reload();
      }
    },
    [courses, t],
  );

  // A folder deleted while this page looks into it.
  const folder = folderId ? courses.folders.find((f) => f.id === folderId) : undefined;
  const activeFolderId = folder ? folder.id : null;

  const counts = useMemo(() => {
    const byFolder = new Map<string, number>();
    for (const course of courses.classrooms) {
      if (course.folderId) byFolder.set(course.folderId, (byFolder.get(course.folderId) ?? 0) + 1);
    }
    return byFolder;
  }, [courses.classrooms]);

  const searching = query.trim().length > 0;
  const visible = useMemo(() => {
    const newest = [...courses.classrooms].sort((a, b) => b.updatedAt - a.updatedAt);
    // A search looks through the whole library: a folder is a place, not a filter.
    if (searching) return filterByName(newest, query);
    return activeFolderId ? newest.filter((course) => course.folderId === activeFolderId) : newest;
  }, [activeFolderId, courses.classrooms, query, searching]);

  useEffect(() => {
    retainThumbnails(new Set(courses.classrooms.map((course) => course.id)));
  }, [courses.classrooms, retainThumbnails]);

  const showPending = !searching && !activeFolderId && pendingRuns.length > 0;
  const empty = visible.length === 0 && !showPending;

  return (
    <main
      data-testid="workspace-courses-page"
      aria-label={t('workspace.nav.myCourses')}
      className="ws-canvas ws-page relative flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-[1120px] px-6 pb-16 pt-10 lg:px-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="ws-page-title">{t('workspace.nav.myCourses')}</h1>
            <p className="ws-page-sub">{t('workspace.coursesPage.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="ws-page-search">
              <Search className="size-4 shrink-0" aria-hidden="true" />
              <input
                data-testid="workspace-courses-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setQuery('');
                }}
                placeholder={t('workspace.coursesPage.searchPlaceholder')}
                aria-label={t('workspace.coursesPage.searchPlaceholder')}
                className="min-w-0 flex-1 bg-transparent outline-none"
              />
            </label>
            <button
              type="button"
              data-testid="workspace-courses-import"
              onClick={courses.triggerImport}
              disabled={courses.importing}
              className="ws-page-btn"
            >
              <Upload className="size-4" aria-hidden="true" />
              <span>{t('import.classroom')}</span>
            </button>
            {foldersAvailable ? (
              <button
                type="button"
                data-testid="workspace-courses-new-folder"
                onClick={courses.openNewFolder}
                className="ws-page-btn"
              >
                <FolderPlus className="size-4" aria-hidden="true" />
                <span>{t('classroom.newFolderTitle')}</span>
              </button>
            ) : null}
          </div>
        </header>

        {foldersAvailable && courses.folders.length > 0 && !searching ? (
          <section
            aria-label={t('workspace.coursesPage.folders')}
            className="mt-7 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4"
          >
            {courses.folders.map((item) => {
              const open = item.id === activeFolderId;
              if (item.id === renamingFolderId) {
                return (
                  <InlineNameRow
                    key={item.id}
                    testId={`workspace-courses-folder-rename-${item.id}`}
                    initialName={item.name}
                    placeholder={t('classroom.folderNamePlaceholder')}
                    ariaLabel={t('classroom.folderNameLabel')}
                    maxLength={80}
                    className="ws-folder-card ws-card-rename"
                    onSubmit={(name) => submitFolderRename(item.id, name)}
                    onClose={() => setRenamingFolderId(null)}
                  />
                );
              }
              return (
                <div key={item.id} className="ws-card-wrap group relative">
                  <button
                    type="button"
                    data-testid={`workspace-courses-folder-${item.id}`}
                    aria-pressed={open}
                    onClick={() => setFolderId(open ? null : item.id)}
                    className={cn('ws-folder-card w-full', open && 'ws-folder-card-on')}
                  >
                    <span className="ws-folder-card-icon" aria-hidden="true">
                      {open ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1 pr-6 text-left">
                      <span className="block truncate text-[14px] font-semibold">{item.name}</span>
                      <span className="block text-[12px] text-[color:var(--ws-ink-mute)]">
                        {t('workspace.coursesPage.courseCount', {
                          count: counts.get(item.id) ?? 0,
                        })}
                      </span>
                    </span>
                  </button>
                  <div className="ws-card-more ws-card-more-folder">
                    <WorkspaceRowMenu
                      testId={`workspace-courses-folder-more-${item.id}`}
                      label={item.name}
                      triggerClassName="ws-card-more-btn"
                      onRename={() => setRenamingFolderId(item.id)}
                      // Asked as a question rather than confirmed in the menu:
                      // this delete moves courses, and that needs a sentence.
                      onDelete={() => setFolderToDelete(item)}
                      deleteAsksElsewhere
                    />
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}

        <div className="mb-3.5 mt-8 flex items-center justify-between">
          <h2 className="ws-section-title">
            {searching
              ? t('workspace.coursesPage.results')
              : folder
                ? folder.name
                : t('workspace.coursesPage.recent')}
          </h2>
          {folder && !searching ? (
            <button
              type="button"
              onClick={() => setFolderId(null)}
              className="ws-quiet text-[13px]"
            >
              {t('workspace.coursesPage.allCourses')}
            </button>
          ) : null}
        </div>

        {courses.state === 'loading' && courses.classrooms.length === 0 ? (
          <div className="grid grid-cols-2 gap-x-5 gap-y-6 md:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="ws-course-card-thumb relative">
                <ThumbnailSkeleton />
              </div>
            ))}
          </div>
        ) : empty ? (
          <p className="ws-page-empty" data-testid="workspace-courses-empty">
            {searching
              ? t('workspace.searchEmpty')
              : folder
                ? t('classroom.emptyFolderHint')
                : t('workspace.coursesEmpty')}
          </p>
        ) : (
          <div
            data-testid="workspace-courses-grid"
            className="grid grid-cols-2 gap-x-5 gap-y-6 md:grid-cols-3 xl:grid-cols-4"
          >
            {showPending
              ? pendingRuns.map((run) => (
                  <PendingRunCard key={run.id} run={run} onDiscard={onDiscardRun} />
                ))
              : null}
            {visible.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                run={courseRuns.get(course.id)}
                slide={thumbnails[course.id]}
                requestThumbnail={requestThumbnail}
                onOpen={() => onOpenCourse(course.id)}
                folders={foldersAvailable ? courses.folders : null}
                onMove={(target) => void courses.moveCourse(course.id, target)}
                onCreateAndMove={courses.createAndMove(course.id)}
                renaming={course.id === renamingCourseId}
                onStartRename={() => setRenamingCourseId(course.id)}
                onSubmitRename={(name) => submitCourseRename(course.id, name)}
                onEndRename={() => setRenamingCourseId(null)}
                onDelete={() => onDeleteCourse(course.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* The new-folder dialog the header button and "move to → new folder"
          open; the home surface mounts it otherwise, never both at once. */}
      {courses.discoveryContent}

      {/* Deleting a folder does something to the courses inside it, so it is
          asked as a question with that consequence stated. Only the keeping
          mode is offered (see `deleteFolderKeepingCourses`). */}
      <AlertDialog
        open={folderToDelete !== null}
        onOpenChange={(next) => {
          if (!next) setFolderToDelete(null);
        }}
      >
        <AlertDialogContent
          data-testid="workspace-courses-folder-delete-dialog"
          className="sm:max-w-[400px]"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('classroom.deleteFolderTitle', { name: folderToDelete?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('workspace.folderDeleteHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="workspace-courses-folder-delete-confirm"
              onClick={() => {
                const target = folderToDelete;
                setFolderToDelete(null);
                if (!target) return;
                if (target.id === activeFolderId) setFolderId(null);
                void deleteFolderKeepingCourses(target.id);
              }}
            >
              {t('workspace.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function CourseCard({
  course,
  run,
  slide,
  requestThumbnail,
  onOpen,
  folders,
  onMove,
  onCreateAndMove,
  renaming,
  onStartRename,
  onSubmitRename,
  onEndRename,
  onDelete,
}: {
  readonly course: Course;
  readonly run: RunSnapshot | undefined;
  /** The first slide; null when the course has none, undefined until loaded. */
  readonly slide: Slide | null | undefined;
  readonly requestThumbnail: (stageId: string, version: number) => () => void;
  readonly onOpen: () => void;
  /** The folders a course can be filed into; null when folders are unavailable. */
  readonly folders: Discovery['folders'] | null;
  readonly onMove: (folderId: string | undefined) => void;
  readonly onCreateAndMove: () => void;
  readonly renaming: boolean;
  readonly onStartRename: () => void;
  readonly onSubmitRename: (name: string) => Promise<string | null>;
  readonly onEndRename: () => void;
  readonly onDelete: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const thumbRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const near = useNearViewport(thumbRef);
  const status = run ? courseRunStatus(run) : null;

  useEffect(() => {
    if (!near) return;
    return requestThumbnail(course.id, course.updatedAt);
  }, [near, requestThumbnail, course.id, course.updatedAt]);

  useEffect(() => {
    const el = thumbRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const name = course.name || t('workspace.untitledCourse');
  // A course its run is still producing opens where its progress (or Retry) is,
  // and is not renamed, filed or deleted until the run ends.
  const open = status
    ? status.kind === 'paused'
      ? () => window.open(courseRunHref(run!), '_blank', 'noopener')
      : undefined
    : onOpen;

  return (
    <div className="ws-card-wrap group relative min-w-0">
      <button
        type="button"
        data-testid={`workspace-courses-card-${course.id}`}
        data-generating={status ? 'true' : undefined}
        onClick={open}
        aria-disabled={open ? undefined : true}
        className="ws-course-card w-full text-left"
      >
        <div ref={thumbRef} className="ws-course-card-thumb relative">
          {slide && width > 0 ? (
            <SlideThumbnail
              slide={slide}
              size={width}
              viewportSize={slide.viewportSize ?? 1000}
              viewportRatio={slide.viewportRatio ?? 0.5625}
            />
          ) : slide === undefined ? (
            <ThumbnailSkeleton />
          ) : (
            <div className="ws-course-card-blank" aria-hidden="true" />
          )}
          {status ? (
            <span className="ws-course-card-status">
              <CourseRunStatusIcon status={status} className="size-3" />
              {courseRunStatusText(status, t)}
            </span>
          ) : null}
        </div>
        {renaming ? null : <div className="ws-course-card-name">{name}</div>}
        {renaming ? null : (
          <div className="ws-course-card-meta">
            {t('workspace.sceneCount', { count: course.sceneCount })}
            <span aria-hidden="true"> · </span>
            {new Date(course.updatedAt).toLocaleDateString()}
          </div>
        )}
      </button>
      {renaming ? (
        <div className="mt-2">
          <InlineNameRow
            testId={`workspace-courses-rename-${course.id}`}
            initialName={course.name}
            placeholder={t('classroom.renamePlaceholder')}
            ariaLabel={t('classroom.rename')}
            maxLength={STAGE_NAME_MAX_LENGTH}
            className="ws-card-rename"
            onSubmit={onSubmitRename}
            onClose={onEndRename}
          />
        </div>
      ) : null}
      {status ? null : (
        <div className="ws-card-more">
          <WorkspaceRowMenu
            testId={`workspace-courses-more-${course.id}`}
            label={name}
            triggerClassName="ws-card-more-btn"
            onRename={onStartRename}
            extraItems={
              folders ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid={`workspace-courses-more-${course.id}-move`}>
                    <FolderInput className="size-3.5" aria-hidden="true" />
                    {t('classroom.moveToFolder')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="pro-popover w-52">
                    <MoveToFolderMenu
                      variant="items"
                      folders={folders}
                      currentFolderId={
                        folders.some((folder) => folder.id === course.folderId)
                          ? course.folderId
                          : undefined
                      }
                      onMove={onMove}
                      onCreateAndMove={onCreateAndMove}
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null
            }
            onDelete={onDelete}
          />
        </div>
      )}
    </div>
  );
}

function PendingRunCard({
  run,
  onDiscard,
}: {
  readonly run: RunSnapshot;
  readonly onDiscard?: (runId: string) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const status = courseRunStatus(run);
  if (!status) return null;
  const name = pendingCourseName(run) || t('workspace.untitledCourse');
  return (
    <div className="ws-card-wrap group relative min-w-0">
      <button
        type="button"
        data-testid={`workspace-courses-run-${run.id}`}
        onClick={() => window.open(courseRunHref(run), '_blank', 'noopener')}
        className="ws-course-card w-full text-left"
      >
        <div className="ws-course-card-thumb relative">
          <ThumbnailSkeleton />
          <span className="ws-course-card-status">
            <CourseRunStatusIcon status={status} className="size-3" />
            {courseRunStatusText(status, t)}
          </span>
        </div>
        <div className="ws-course-card-name">{name}</div>
        <div className="ws-course-card-meta">{t('workspace.viewGenerationProgress')}</div>
      </button>
      {onDiscard ? (
        <div className="ws-card-more">
          <WorkspaceRowMenu
            testId={`workspace-courses-run-more-${run.id}`}
            label={name}
            triggerClassName="ws-card-more-btn"
            onDelete={() => onDiscard(run.id)}
          />
        </div>
      ) : null}
    </div>
  );
}
