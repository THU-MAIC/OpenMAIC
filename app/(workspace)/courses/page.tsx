'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import {
  ArrowRight,
  Grid2X2,
  LayoutList,
  Layers3,
  Plus,
  SearchX,
  Sparkles,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CourseCard, CourseCover, OfflineStatusBadge } from '@/components/workspace/course-card';
import { WorkspacePageHeader } from '@/components/workspace/page-header';
import { useWorkspaceCourses } from '@/components/workspace/use-workspace-courses';
import { useWorkspaceImport } from '@/components/workspace/workspace-import-controller';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'original' | 'teacher_variant' | 'offline' | 'archived';

function CoursesContent() {
  const searchParams = useSearchParams();
  const query = (searchParams.get('q') ?? '').trim().toLocaleLowerCase('zh-CN');
  const { courses, thumbnails, loading, error } = useWorkspaceCourses();
  const { openImporter } = useWorkspaceImport();
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');

  const visibleCourses = useMemo(
    () =>
      courses.filter((course) => {
        const { metadata, stage } = course;
        const matchesFilter =
          filter === 'all'
            ? !metadata.archived
            : filter === 'offline'
              ? metadata.offlineStatus === 'complete' && !metadata.archived
              : filter === 'archived'
                ? metadata.archived
                : metadata.kind === filter && !metadata.archived;
        if (!matchesFilter) return false;
        if (!query) return true;
        return [
          metadata.title,
          metadata.summary,
          metadata.subject,
          metadata.category,
          ...(metadata.tags ?? []),
          stage.name,
          stage.description,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase('zh-CN').includes(query));
      }),
    [courses, filter, query],
  );

  const filters: Array<{ key: Filter; label: string }> = [
    { key: 'all', label: '全部课程' },
    { key: 'teacher_variant', label: '我的适配版' },
    { key: 'original', label: '导入原作' },
    { key: 'offline', label: '完整离线' },
    { key: 'archived', label: '已归档' },
  ];

  return (
    <div>
      <WorkspacePageHeader
        eyebrow="My courses"
        title={query ? `“${query}”的搜索结果` : '我的课程'}
        description="管理保存在这台设备上的课程，进入详情后再选择授课、预演或复制改编。"
        actions={
          <>
            <Button
              asChild
              variant="outline"
              className="h-10 rounded-xl bg-white/70 dark:bg-white/5"
            >
              <Link href="/create">
                <Sparkles /> 创建新课程
              </Link>
            </Button>
            <Button
              onClick={openImporter}
              className="h-10 rounded-xl bg-violet-600 px-4 hover:bg-violet-700"
            >
              <Upload /> 导入课程
            </Button>
          </>
        }
      />

      <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-white bg-white/75 p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.035] sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1 sm:pb-0">
          {filters.map((item) => (
            <button
              key={item.key}
              onClick={() => setFilter(item.key)}
              aria-pressed={filter === item.key}
              className={cn(
                'h-9 shrink-0 rounded-xl px-3.5 text-xs font-medium transition-colors',
                filter === item.key
                  ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          <span className="px-2 text-xs text-muted-foreground">{visibleCourses.length} 门课程</span>
          <div className="flex rounded-xl bg-muted/70 p-1">
            <button
              aria-label="卡片视图"
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
              className={cn(
                'grid size-8 place-items-center rounded-lg',
                view === 'grid' && 'bg-white shadow-sm dark:bg-white/10',
              )}
            >
              <Grid2X2 className="size-4" />
            </button>
            <button
              aria-label="列表视图"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
              className={cn(
                'grid size-8 place-items-center rounded-lg',
                view === 'list' && 'bg-white shadow-sm dark:bg-white/10',
              )}
            >
              <LayoutList className="size-4" />
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="aspect-[4/3] animate-pulse rounded-2xl bg-white/75 dark:bg-white/5"
            />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      ) : visibleCourses.length === 0 ? (
        <div className="flex min-h-[420px] flex-col items-center justify-center rounded-[24px] border border-dashed border-violet-200 bg-white/55 p-8 text-center dark:border-violet-900 dark:bg-white/[0.025]">
          <div className="grid size-14 place-items-center rounded-2xl bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            <SearchX className="size-7" />
          </div>
          <h2 className="mt-4 text-base font-semibold">没有找到符合条件的课程</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            {query
              ? '试试更短的课程名、学科或知识点。'
              : '调整筛选条件，或导入一门新的 OpenMAIC 课程。'}
          </p>
          <Button
            onClick={openImporter}
            className="mt-5 rounded-xl bg-violet-600 hover:bg-violet-700"
          >
            <Plus /> 导入课程
          </Button>
        </div>
      ) : view === 'grid' ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visibleCourses.map((course) => (
            <CourseCard key={course.stage.id} course={course} slide={thumbnails[course.stage.id]} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {visibleCourses.map((course) => (
            <article
              key={course.stage.id}
              className="grid gap-4 rounded-2xl border border-white bg-white/80 p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.04] sm:grid-cols-[220px_1fr_auto] sm:items-center"
            >
              <CourseCover course={course} slide={thumbnails[course.stage.id]} compact />
              <div className="min-w-0 px-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/courses/${course.stage.id}`}
                    className="truncate text-base font-semibold hover:text-violet-700 dark:hover:text-violet-300"
                  >
                    {course.metadata.title || course.stage.name}
                  </Link>
                  <OfflineStatusBadge status={course.metadata.offlineStatus} />
                </div>
                <p className="mt-2 line-clamp-2 max-w-2xl text-xs leading-5 text-muted-foreground">
                  {course.metadata.summary || course.stage.description || '暂无课程简介'}
                </p>
                <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                  <span>{course.metadata.subject || course.metadata.category || '未分类'}</span>
                  <span className="inline-flex items-center gap-1">
                    <Layers3 className="size-3" /> {course.sceneCount} 个场景
                  </span>
                  {course.metadata.kind === 'teacher_variant' && (
                    <span className="text-violet-700 dark:text-violet-300">我的适配版</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2 sm:flex-col">
                <Button
                  asChild
                  variant="outline"
                  className="h-9 flex-1 rounded-xl bg-transparent sm:w-28"
                >
                  <Link href={`/courses/${course.stage.id}`}>详情</Link>
                </Button>
                <Button
                  asChild
                  className="h-9 flex-1 rounded-xl bg-violet-600 hover:bg-violet-700 sm:w-28"
                >
                  <Link href={`/classroom/${course.stage.id}`}>
                    授课 <ArrowRight />
                  </Link>
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CoursesPage() {
  return (
    <Suspense
      fallback={
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="aspect-[4/3] animate-pulse rounded-2xl bg-white/75 dark:bg-white/5"
            />
          ))}
        </div>
      }
    >
      <CoursesContent />
    </Suspense>
  );
}
