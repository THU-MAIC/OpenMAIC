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
 * Names are edited in place, the knowledge base's way (`inline-name`): "New
 * folder" adds a folder card whose name field already holds a de-duplicated
 * default, selected; a rename turns the name into that field. Enter or leaving
 * the field saves, Escape cancels.
 *
 * Opening a course opens it in the classroom pane.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, FolderInput, FolderPlus, Search, Upload } from 'lucide-react';
import { FOLDER_TILE_FRAME, FolderTileCover } from '@/components/discovery/folder-card';
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
  FOLDER_COUNT_LIMIT,
  FOLDER_NAME_MAX_WIDTH,
  FolderNameError,
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
import { WorkspaceRowMenu } from './workspace-row-controls';
import { InlineName, newFolderName, type CommitCause } from './inline-name';
import { cn } from '@/lib/utils/cn';

type Discovery = ReturnType<typeof useHomeDiscovery>;
type Course = Discovery['classrooms'][number];

/** A name being edited in place on the page. */
interface NameEdit {
  /** One per edit: an answer is only its own edit's. */
  readonly id: number;
  readonly kind: 'newFolder' | 'folder' | 'course';
  readonly targetId: string | null;
  /** The name the field opens with (what was typed, after a refusal). */
  readonly name: string;
  readonly moveCourseId?: string;
  readonly busy: boolean;
  readonly error: string | null;
}

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

  /**
   * The name being edited in place — one at a time: a new folder's draft, a
   * folder's rename or a course's. `moveCourseId` is the course whose "move to
   * → new folder" asked for the draft; it is filed there once it exists.
   */
  const [edit, setEdit] = useState<NameEdit | null>(null);
  const editSeq = useRef(0);
  const startEdit = (
    kind: NameEdit['kind'],
    targetId: string | null,
    name: string,
    moveCourseId?: string,
  ) => {
    editSeq.current += 1;
    setEdit({ id: editSeq.current, kind, targetId, name, moveCourseId, busy: false, error: null });
  };
  const ownEdit = (id: number, change: (current: NameEdit) => NameEdit | null) =>
    setEdit((current) => (current?.id === id ? change(current) : current));
  /** The folder whose delete has been asked for, and not yet answered. */
  const [folderToDelete, setFolderToDelete] = useState<{ id: string; name: string } | null>(null);

  /** Why a folder name is refused before asking the server, or null. */
  const folderNameRefusal = useCallback(
    (name: string, folderId: string | null): string | null => {
      const widthCheck = validateFolderName(name);
      if (!widthCheck.ok) {
        return widthCheck.kind === 'empty'
          ? t('classroom.folderNameEmpty')
          : t('classroom.folderWidth', { width: widthCheck.width, max: FOLDER_NAME_MAX_WIDTH });
      }
      const trimmed = name.trim().toLowerCase();
      // The server's own rule (case-insensitive), so a name the list already
      // holds does not cost a round trip to be told so.
      if (
        courses.folders.some(
          (folder) => folder.id !== folderId && folder.name.toLowerCase() === trimmed,
        )
      ) {
        return t('classroom.folderNameExists');
      }
      return null;
    },
    [courses.folders, t],
  );

  /** A refusal from the folder routes, as copy. */
  const folderErrorMessage = useCallback(
    (caught: unknown, name: string, fallback: string): string => {
      const kind =
        caught instanceof WorkspaceFolderNameError || caught instanceof FolderNameError
          ? caught.kind
          : null;
      if (kind === 'duplicate') return t('classroom.folderNameExists');
      if (kind === 'tooLong') {
        return t('classroom.folderWidth', {
          width: displayNameWidth(name),
          max: FOLDER_NAME_MAX_WIDTH,
        });
      }
      if (kind === 'empty') return t('classroom.folderNameEmpty');
      if (kind === 'limit') return t('classroom.folderCountLimit');
      if (kind) return t('classroom.folderNameHint');
      return fallback;
    },
    [t],
  );

  const submitFolderRename = useCallback(
    async (folderId: string, name: string): Promise<string | null> => {
      const trimmed = name.trim();
      // Unchanged is not a rename; leave editing without writing anything.
      if (courses.folders.find((folder) => folder.id === folderId)?.name === trimmed) return null;
      const refusal = folderNameRefusal(name, folderId);
      if (refusal) return refusal;
      try {
        if (!workspaceFolderAdapter) return t('workspace.foldersUnavailable');
        await workspaceFolderAdapter.rename(folderId, trimmed);
        await courses.reload();
        return null;
      } catch (caught) {
        return folderErrorMessage(caught, trimmed, t('classroom.folderRenameFailed'));
      }
    },
    [courses, folderErrorMessage, folderNameRefusal, t],
  );

  /** Create the drafted folder, and file the course that asked for it there. */
  const submitNewFolder = useCallback(
    async (name: string, moveCourseId: string | undefined): Promise<string | null> => {
      const trimmed = name.trim();
      const refusal = folderNameRefusal(name, null);
      if (refusal) return refusal;
      if (courses.folders.length >= FOLDER_COUNT_LIMIT) return t('classroom.folderCountLimit');
      try {
        const folder = await courses.createFolder(trimmed);
        if (moveCourseId) await courses.moveCourse(moveCourseId, folder.id);
        return null;
      } catch (caught) {
        return folderErrorMessage(caught, trimmed, t('classroom.folderCreateFailed'));
      }
    },
    [courses, folderErrorMessage, folderNameRefusal, t],
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

  const commitEdit = async (current: NameEdit, typed: string, _cause: CommitCause) => {
    if (current.busy) return;
    // An empty name asks nothing: a draft folder goes away, a rename ends.
    if (!typed.trim()) return ownEdit(current.id, () => null);
    ownEdit(current.id, (value) => ({ ...value, busy: true, error: null }));
    const refusal =
      current.kind === 'newFolder'
        ? await submitNewFolder(typed, current.moveCourseId)
        : current.kind === 'folder'
          ? await submitFolderRename(current.targetId!, typed)
          : await submitCourseRename(current.targetId!, typed);
    ownEdit(current.id, (value) =>
      refusal ? { ...value, name: typed, busy: false, error: refusal } : null,
    );
  };

  /** "New folder": a draft card at the head of the grid, its name selected. */
  const startNewFolder = (moveCourseId?: string) => {
    setQuery('');
    // Folders live at the top level; a draft is made where they are.
    setFolderId(null);
    startEdit(
      'newFolder',
      null,
      newFolderName(t('classroom.newFolderTitle'), courses.folders),
      moveCourseId,
    );
  };

  /** The field of the edit in place, as the knowledge base draws it. */
  const nameField = (current: NameEdit, testId: string, label: string) => (
    <InlineName
      key={current.id}
      testId={testId}
      errorTestId={`${testId}-error`}
      label={label}
      initialName={current.name}
      maxLength={current.kind === 'course' ? STAGE_NAME_MAX_LENGTH : 80}
      busy={current.busy}
      error={current.error}
      onEdit={() =>
        ownEdit(current.id, (value) => (value.error ? { ...value, error: null } : value))
      }
      onCommit={(name, cause) => void commitEdit(current, name, cause)}
      onCancel={() => ownEdit(current.id, () => null)}
    />
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
  const knownFolders = useMemo(
    () => new Set(courses.folders.map((item) => item.id)),
    [courses.folders],
  );
  const visible = useMemo(() => {
    const newest = [...courses.classrooms].sort((a, b) => b.updatedAt - a.updatedAt);
    // A search looks through the whole library: a folder is a place, not a filter.
    if (searching) return filterByName(newest, query);
    if (activeFolderId) return newest.filter((course) => course.folderId === activeFolderId);
    // The top level: the folders' cards, then the courses in no folder (one
    // whose folder is gone counts as in none).
    return newest.filter((course) => !course.folderId || !knownFolders.has(course.folderId));
  }, [activeFolderId, courses.classrooms, knownFolders, query, searching]);

  /**
   * Each folder's cover: up to three member covers, newest first, as the
   * classic home's folder tile shows them. The members that fill (or, not
   * loaded yet, may fill) those slots are the card's candidates; a member
   * without a slide gives its slot to the next.
   */
  const folderCovers = useMemo(() => {
    const byFolder = new Map<string, { slides: Slide[]; candidates: Course[] }>();
    for (const course of [...courses.classrooms].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!course.folderId) continue;
      const covers = byFolder.get(course.folderId) ?? { slides: [], candidates: [] };
      byFolder.set(course.folderId, covers);
      if (covers.candidates.length >= 3) continue;
      const slide = thumbnails[course.id];
      if (slide === null) continue;
      covers.candidates.push(course);
      if (slide) covers.slides.push(slide);
    }
    return byFolder;
  }, [courses.classrooms, thumbnails]);
  const atTop = !searching && !activeFolderId;
  const showFolders = foldersAvailable && atTop;

  useEffect(() => {
    retainThumbnails(new Set(courses.classrooms.map((course) => course.id)));
  }, [courses.classrooms, retainThumbnails]);

  const showPending = atTop && pendingRuns.length > 0;
  const empty =
    visible.length === 0 &&
    !showPending &&
    !(showFolders && (courses.folders.length > 0 || edit?.kind === 'newFolder'));

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
                onClick={() => startNewFolder()}
                className="ws-page-btn"
              >
                <FolderPlus className="size-4" aria-hidden="true" />
                <span>{t('classroom.newFolderTitle')}</span>
              </button>
            ) : null}
          </div>
        </header>

        <div className="mb-3.5 mt-8 flex min-w-0 items-center gap-1.5">
          {folder && !searching ? (
            // Inside a folder: the way back, then where you are.
            <>
              <button
                type="button"
                data-testid="workspace-courses-back"
                onClick={() => setFolderId(null)}
                className="ws-section-title ws-quiet inline-flex shrink-0 items-center gap-1"
              >
                <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
                {t('workspace.coursesPage.allCourses')}
              </button>
              <ChevronRight
                className="size-3.5 shrink-0 text-[color:var(--ws-ink-mute)] rtl:rotate-180"
                aria-hidden="true"
              />
              <h2
                className="ws-section-title min-w-0 truncate"
                data-testid="workspace-courses-folder-title"
              >
                {folder.name}
              </h2>
            </>
          ) : (
            <h2 className="ws-section-title">
              {searching ? t('workspace.coursesPage.results') : t('workspace.coursesPage.recent')}
            </h2>
          )}
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
            {showFolders && edit?.kind === 'newFolder' ? (
              <FolderTile
                testId="workspace-courses-new-folder-card"
                name={edit.name}
                courseCount={0}
                covers={NO_COVERS}
                nameField={nameField(
                  edit,
                  'workspace-courses-new-folder-input',
                  t('classroom.folderNameLabel'),
                )}
              />
            ) : null}
            {showFolders
              ? courses.folders.map((item) => {
                  const covers = folderCovers.get(item.id);
                  const renaming = edit?.kind === 'folder' && edit.targetId === item.id;
                  return (
                    <FolderTile
                      key={item.id}
                      testId={`workspace-courses-folder-card-${item.id}`}
                      openTestId={`workspace-courses-folder-${item.id}`}
                      name={item.name}
                      courseCount={counts.get(item.id) ?? 0}
                      covers={covers?.slides ?? NO_COVERS}
                      candidates={covers?.candidates}
                      requestThumbnail={requestThumbnail}
                      onOpen={() => setFolderId(item.id)}
                      nameField={
                        renaming
                          ? nameField(
                              edit,
                              `workspace-courses-folder-rename-${item.id}`,
                              t('classroom.folderNameLabel'),
                            )
                          : null
                      }
                      menu={
                        renaming ? null : (
                          <WorkspaceRowMenu
                            testId={`workspace-courses-folder-more-${item.id}`}
                            label={item.name}
                            triggerClassName="ws-card-more-btn"
                            onRename={() => startEdit('folder', item.id, item.name)}
                            // Asked as a question rather than confirmed in the
                            // menu: this delete moves courses, and that needs a
                            // sentence.
                            onDelete={() => setFolderToDelete(item)}
                            deleteAsksElsewhere
                          />
                        )
                      }
                    />
                  );
                })
              : null}
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
                onCreateAndMove={() => startNewFolder(course.id)}
                nameField={
                  edit?.kind === 'course' && edit.targetId === course.id
                    ? nameField(
                        edit,
                        `workspace-courses-rename-${course.id}`,
                        t('classroom.rename'),
                      )
                    : null
                }
                // While its name is a field, or a folder is being drafted for
                // it, the card's ⋯ steps aside: the menu handing the focus back
                // to its button would end the edit.
                busyWithEdit={
                  (edit?.kind === 'course' && edit.targetId === course.id) ||
                  edit?.moveCourseId === course.id
                }
                onStartRename={() => startEdit('course', course.id, course.name)}
                onDelete={() => onDeleteCourse(course.id)}
              />
            ))}
          </div>
        )}
      </div>

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

const NO_COVERS: Slide[] = [];

/**
 * A folder as a card in the course grid — the classic home's folder tile
 * (`FolderTileCover` in the same 16:9 frame, the folder badge and the name),
 * with the workspace's ⋯ in the corner. A draft folder is the same card with
 * its name as a field.
 */
function FolderTile({
  testId,
  openTestId,
  name,
  courseCount,
  covers,
  candidates,
  requestThumbnail,
  onOpen,
  nameField,
  menu,
}: {
  readonly testId: string;
  readonly openTestId?: string;
  readonly name: string;
  readonly courseCount: number;
  readonly covers: Slide[];
  /** The members whose thumbnails fill (or may fill) the cover. */
  readonly candidates?: readonly Course[];
  readonly requestThumbnail?: (stageId: string, version: number) => () => void;
  /** Absent for a draft: nothing to open yet. */
  readonly onOpen?: () => void;
  /** The name's field while it is being named; null otherwise. */
  readonly nameField: ReactNode;
  readonly menu?: ReactNode;
}) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(frameRef);
  const candidateKey = (candidates ?? []).map((c) => `${c.id}@${c.updatedAt}`).join('|');
  useEffect(() => {
    if (!near || !requestThumbnail || !candidateKey) return;
    const withdraws = candidateKey.split('|').map((key) => {
      const at = key.lastIndexOf('@');
      return requestThumbnail(key.slice(0, at), Number(key.slice(at + 1)));
    });
    return () => withdraws.forEach((withdraw) => withdraw());
  }, [near, requestThumbnail, candidateKey]);

  const frame = (
    <div
      ref={frameRef}
      className={cn(
        FOLDER_TILE_FRAME,
        nameField ? 'ring-2 ring-violet-400/70' : 'ring-violet-200/50 dark:ring-violet-800/40',
      )}
    >
      <FolderTileCover covers={covers} courseCount={courseCount} />
    </div>
  );
  const badge = (
    <span className="shrink-0 inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">
      {t('classroom.folderBadge')}
    </span>
  );

  return (
    <div data-testid={testId} className="ws-card-wrap group relative min-w-0">
      {nameField ? (
        <>
          {frame}
          <div className="mt-2.5 flex items-start gap-2 px-1">
            {badge}
            {nameField}
          </div>
        </>
      ) : (
        <button
          type="button"
          data-testid={openTestId}
          onClick={onOpen}
          title={name}
          className="block w-full text-left"
        >
          {frame}
          <div className="mt-2.5 flex items-center gap-2 px-1">
            {badge}
            <span className="ws-course-card-name mt-0! min-w-0 truncate">{name}</span>
          </div>
        </button>
      )}
      {menu ? <div className="ws-card-more">{menu}</div> : null}
    </div>
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
  nameField,
  busyWithEdit,
  onStartRename,
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
  /** The name's field while it is being renamed in place; null otherwise. */
  readonly nameField: ReactNode;
  readonly busyWithEdit: boolean;
  readonly onStartRename: () => void;
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
        {nameField ? null : <div className="ws-course-card-name">{name}</div>}
        {nameField ? null : (
          <div className="ws-course-card-meta">
            {t('workspace.sceneCount', { count: course.sceneCount })}
            <span aria-hidden="true"> · </span>
            {new Date(course.updatedAt).toLocaleDateString()}
          </div>
        )}
      </button>
      {nameField ? <div className="mt-2.5 flex">{nameField}</div> : null}
      {status || busyWithEdit ? null : (
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
