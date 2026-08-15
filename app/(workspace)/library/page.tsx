'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpenCheck,
  Boxes,
  CloudDownload,
  Compass,
  FolderHeart,
  Search,
  Shapes,
  Upload,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CourseCard } from '@/components/workspace/course-card';
import { WorkspacePageHeader } from '@/components/workspace/page-header';
import { useWorkspaceCourses } from '@/components/workspace/use-workspace-courses';
import { useWorkspaceImport } from '@/components/workspace/workspace-import-controller';
import {
  EXTRACURRICULAR_CATEGORIES,
  SUBJECT_CATEGORIES,
  type CourseTaxonomyItem,
} from '@/lib/workspace/taxonomy';
import type { CourseDomain } from '@/lib/workspace';
import { cn } from '@/lib/utils';

function CategoryCard({
  item,
  count,
  selected,
  onSelect,
}: {
  item: CourseTaxonomyItem;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group min-h-32 rounded-2xl border p-4 text-left transition-all',
        selected
          ? 'border-violet-300 bg-violet-50 shadow-sm dark:border-violet-700 dark:bg-violet-950/50'
          : 'border-white bg-white/75 hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md dark:border-white/10 dark:bg-white/[0.04] dark:hover:border-violet-800',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid size-9 place-items-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
          <BookOpenCheck className="size-4" />
        </div>
        <span className="text-[11px] text-muted-foreground">
          {count ? `${count} 门本机课程` : '暂无本机课程'}
        </span>
      </div>
      <h3 className="mt-3 text-sm font-semibold">{item.label}</h3>
      <p className="mt-1.5 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
        {item.description}
      </p>
    </button>
  );
}

export default function LibraryPage() {
  const { courses, thumbnails, loading } = useWorkspaceCourses();
  const { openImporter } = useWorkspaceImport();
  const [domain, setDomain] = useState<CourseDomain>('subject');
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const categories = domain === 'subject' ? SUBJECT_CATEGORIES : EXTRACURRICULAR_CATEGORIES;

  const matchingCourses = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return courses.filter((course) => {
      if (course.metadata.archived || course.metadata.domain !== domain) return false;
      if (
        category &&
        course.metadata.subject !== category &&
        course.metadata.category !== category
      ) {
        return false;
      }
      if (!normalized) return true;
      return [
        course.metadata.title,
        course.metadata.summary,
        course.metadata.subject,
        course.metadata.category,
        ...(course.metadata.tags ?? []),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase('zh-CN').includes(normalized));
    });
  }, [category, courses, domain, query]);

  const counts = useMemo(() => {
    const next = new Map<string, number>();
    courses
      .filter((course) => course.metadata.domain === domain && !course.metadata.archived)
      .forEach((course) => {
        if (course.metadata.subject) {
          next.set(course.metadata.subject, (next.get(course.metadata.subject) ?? 0) + 1);
        }
      });
    return next;
  }, [courses, domain]);

  return (
    <div>
      <WorkspacePageHeader
        eyebrow="Resource library"
        title="课程资源库"
        description="先从本机已保存课程开始，按学科与知识门类整理。公共优秀课程下载接口可在后续接入，不影响本机课程工作。"
        actions={
          <Button
            onClick={openImporter}
            className="h-10 rounded-xl bg-violet-600 px-4 hover:bg-violet-700"
          >
            <Upload /> 导入资源
          </Button>
        }
      />

      <section className="relative overflow-hidden rounded-[26px] border border-white bg-gradient-to-r from-[#382149] via-[#51306d] to-[#6e45a2] p-6 text-white shadow-lg shadow-violet-200/40 dark:border-white/10 dark:shadow-none sm:p-8">
        <div className="absolute -right-8 -top-24 size-72 rounded-full bg-white/10 blur-2xl" />
        <div className="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <Badge className="border-white/20 bg-white/10 text-white">
              <Compass /> 课程发现
            </Badge>
            <h2 className="mt-4 text-2xl font-semibold sm:text-3xl">好课程，可以成为你的课程。</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/70">
              保存原作到本机，再创建独立适配副本。原作者版本与教师改编版本始终分开管理。
            </p>
          </div>
          <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm lg:w-72">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CloudDownload className="size-4" /> 公共资源库连接
            </div>
            <p className="mt-2 text-xs leading-5 text-white/65">
              当前版本先启用本机资源库。云端审核、评分与版本更新接口已保留产品位置。
            </p>
            <Badge className="mt-3 bg-white/15 text-white">第二阶段接入</Badge>
          </div>
        </div>
      </section>

      <section className="mt-7">
        <div className="flex flex-col gap-3 rounded-2xl border border-white bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.035] sm:flex-row sm:items-center">
          <div className="flex rounded-xl bg-muted/70 p-1">
            <button
              onClick={() => {
                setDomain('subject');
                setCategory(null);
              }}
              aria-pressed={domain === 'subject'}
              className={cn(
                'flex h-9 items-center gap-2 rounded-lg px-4 text-xs font-medium',
                domain === 'subject' &&
                  'bg-white text-violet-700 shadow-sm dark:bg-white/10 dark:text-violet-300',
              )}
            >
              <Boxes className="size-4" /> 学科课程
            </button>
            <button
              onClick={() => {
                setDomain('extracurricular');
                setCategory(null);
              }}
              aria-pressed={domain === 'extracurricular'}
              className={cn(
                'flex h-9 items-center gap-2 rounded-lg px-4 text-xs font-medium',
                domain === 'extracurricular' &&
                  'bg-white text-violet-700 shadow-sm dark:bg-white/10 dark:text-violet-300',
              )}
            >
              <Shapes className="size-4" /> 课外知识
            </button>
          </div>
          <div className="relative min-w-0 flex-1 sm:ml-auto sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="在当前资源分类中搜索"
              className="h-10 rounded-xl bg-white pl-9 dark:bg-white/5"
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">
              {domain === 'subject' ? '学科门类' : '课外知识门类'}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              年级、教材版本、知识点和课程类型作为筛选维度，不继续堆叠目录层级。
            </p>
          </div>
          {category && (
            <Button variant="ghost" onClick={() => setCategory(null)} className="rounded-xl">
              查看全部门类
            </Button>
          )}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {categories.map((item) => (
            <CategoryCard
              key={item.id}
              item={item}
              count={counts.get(item.id) ?? 0}
              selected={category === item.id}
              onSelect={() => setCategory((current) => (current === item.id ? null : item.id))}
            />
          ))}
        </div>
      </section>

      <section className="mt-9">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">
              {category ? categories.find((item) => item.id === category)?.label : '本机精选'}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {matchingCourses.length} 门已保存在当前设备的课程
            </p>
          </div>
          <Button asChild variant="ghost" className="rounded-xl">
            <Link href="/courses">
              管理全部课程 <ArrowRight />
            </Link>
          </Button>
        </div>
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="aspect-[4/3] animate-pulse rounded-2xl bg-white/70 dark:bg-white/5"
              />
            ))}
          </div>
        ) : matchingCourses.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {matchingCourses.map((course) => (
              <CourseCard
                key={course.stage.id}
                course={course}
                slide={thumbnails[course.stage.id]}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-h-60 flex-col items-center justify-center rounded-[24px] border border-dashed border-violet-200 bg-white/50 p-8 text-center dark:border-violet-900 dark:bg-white/[0.025]">
            <FolderHeart className="size-9 text-violet-500" />
            <h3 className="mt-4 font-semibold">这个分类里还没有本机课程</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              导入课程后，在课程详情中设置学科门类，它就会出现在这里。
            </p>
            <Button
              onClick={openImporter}
              className="mt-5 rounded-xl bg-violet-600 hover:bg-violet-700"
            >
              <Upload /> 导入课程资源
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
