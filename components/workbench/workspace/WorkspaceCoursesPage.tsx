'use client';

/**
 * "My courses" — the owner's course library as a page in the main area.
 *
 * The rail's Courses tab is the same list as a tree, made for switching
 * between courses while you work; this page is for looking over them: folders
 * as cards, courses as thumbnails, a name filter, and the two ways to add to
 * the library (import a course package, make a folder). Renaming, filing and
 * deleting stay in the rail, where the rows already carry them. Both read the
 * one `useHomeDiscovery` list, so the page and the tree cannot disagree.
 *
 * Opening a course opens it in the classroom pane, exactly as a rail row does.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FolderOpen, FolderPlus, Search, Upload } from 'lucide-react';
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
import { workspaceFoldersAvailable } from './workspace-folder-seam';
import { cn } from '@/lib/utils/cn';

type Discovery = ReturnType<typeof useHomeDiscovery>;
type Course = Discovery['classrooms'][number];

export function WorkspaceCoursesPage({
  courses,
  courseRuns,
  pendingRuns,
  onOpenCourse,
}: {
  readonly courses: Discovery;
  readonly courseRuns: ReadonlyMap<string, RunSnapshot>;
  readonly pendingRuns: readonly RunSnapshot[];
  readonly onOpenCourse: (courseId: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  /** The folder being looked into; null is the whole library. */
  const [folderId, setFolderId] = useState<string | null>(null);
  const foldersAvailable = workspaceFoldersAvailable();
  const { thumbnails, requestThumbnail, retainThumbnails } = useCourseThumbnails();

  // A folder deleted from the rail while this page looks into it.
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
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`workspace-courses-folder-${item.id}`}
                  aria-pressed={open}
                  onClick={() => setFolderId(open ? null : item.id)}
                  className={cn('ws-folder-card', open && 'ws-folder-card-on')}
                >
                  <span className="ws-folder-card-icon" aria-hidden="true">
                    {open ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[14px] font-semibold">{item.name}</span>
                    <span className="block text-[12px] text-[color:var(--ws-ink-mute)]">
                      {t('workspace.coursesPage.courseCount', { count: counts.get(item.id) ?? 0 })}
                    </span>
                  </span>
                </button>
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
              ? pendingRuns.map((run) => <PendingRunCard key={run.id} run={run} />)
              : null}
            {visible.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                run={courseRuns.get(course.id)}
                slide={thumbnails[course.id]}
                requestThumbnail={requestThumbnail}
                onOpen={() => onOpenCourse(course.id)}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function CourseCard({
  course,
  run,
  slide,
  requestThumbnail,
  onOpen,
}: {
  readonly course: Course;
  readonly run: RunSnapshot | undefined;
  /** The first slide; null when the course has none, undefined until loaded. */
  readonly slide: Slide | null | undefined;
  readonly requestThumbnail: (stageId: string, version: number) => () => void;
  readonly onOpen: () => void;
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
  // A course its run is still producing opens where its progress (or Retry) is.
  const open = status
    ? status.kind === 'paused'
      ? () => window.open(courseRunHref(run!), '_blank', 'noopener')
      : undefined
    : onOpen;

  return (
    <button
      type="button"
      data-testid={`workspace-courses-card-${course.id}`}
      onClick={open}
      aria-disabled={open ? undefined : true}
      className="ws-course-card group text-left"
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
      <div className="ws-course-card-name">{name}</div>
      <div className="ws-course-card-meta">
        {t('workspace.sceneCount', { count: course.sceneCount })}
        <span aria-hidden="true"> · </span>
        {new Date(course.updatedAt).toLocaleDateString()}
      </div>
    </button>
  );
}

function PendingRunCard({ run }: { readonly run: RunSnapshot }) {
  const { t } = useI18n();
  const status = courseRunStatus(run);
  if (!status) return null;
  return (
    <button
      type="button"
      data-testid={`workspace-courses-run-${run.id}`}
      onClick={() => window.open(courseRunHref(run), '_blank', 'noopener')}
      className="ws-course-card group text-left"
    >
      <div className="ws-course-card-thumb relative">
        <ThumbnailSkeleton />
        <span className="ws-course-card-status">
          <CourseRunStatusIcon status={status} className="size-3" />
          {courseRunStatusText(status, t)}
        </span>
      </div>
      <div className="ws-course-card-name">
        {pendingCourseName(run) || t('workspace.untitledCourse')}
      </div>
      <div className="ws-course-card-meta">{t('workspace.viewGenerationProgress')}</div>
    </button>
  );
}
