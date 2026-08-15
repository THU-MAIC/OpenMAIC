'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  FolderOpen,
  LibraryBig,
  PencilRuler,
  Plus,
  Sparkles,
  UploadCloud,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CourseCard } from '@/components/workspace/course-card';
import { useWorkspaceCourses } from '@/components/workspace/use-workspace-courses';
import { useWorkspaceImport } from '@/components/workspace/workspace-import-controller';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export default function WorkspaceDashboardPage() {
  const { courses, thumbnails, loading, error } = useWorkspaceCourses();
  const { openImporter } = useWorkspaceImport();
  const recentCourses = courses.filter(({ metadata }) => !metadata.archived).slice(0, 4);
  const offlineReady = courses.filter(
    ({ metadata }) => metadata.offlineStatus === 'complete',
  ).length;
  const adapted = courses.filter(({ metadata }) => metadata.kind === 'teacher_variant').length;
  const [greetingLabel, setGreetingLabel] = useState('你好');
  const [recentCutoff, setRecentCutoff] = useState(0);

  useEffect(() => {
    queueMicrotask(() => {
      setGreetingLabel(greeting());
      setRecentCutoff(Date.now() - 7 * 86_400_000);
    });
  }, []);

  return (
    <div>
      <section className="relative overflow-hidden rounded-[28px] border border-white bg-gradient-to-br from-[#fffdf9] via-[#fbf6ff] to-[#eee7ff] p-6 shadow-sm shadow-violet-100 dark:border-white/10 dark:from-[#211a25] dark:via-[#211627] dark:to-[#281b3c] sm:p-8 lg:p-10">
        <div className="pointer-events-none absolute -right-12 -top-20 size-72 rounded-full bg-violet-300/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 left-1/3 size-64 rounded-full bg-amber-200/20 blur-3xl" />
        <div className="relative grid gap-8 lg:grid-cols-[1fr_410px] lg:items-center">
          <div>
            <p className="text-sm font-medium text-violet-700 dark:text-violet-300">
              {greetingLabel}，欢迎回到课程工作台
            </p>
            <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-[-0.025em] sm:text-[38px] sm:leading-[1.18]">
              把好课程留在本机，
              <span className="text-violet-700 dark:text-violet-300">按你的方式教。</span>
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-7 text-muted-foreground sm:text-[15px]">
              导入 OpenMAIC 资源包后即可离线打开、复制改编和直接授课。课程数据默认只保存在当前设备。
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button
                onClick={openImporter}
                size="lg"
                className="h-11 rounded-xl bg-violet-600 px-5 hover:bg-violet-700"
              >
                <UploadCloud /> 导入课程资源
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                className="h-11 rounded-xl bg-white/60 px-5 dark:bg-white/5"
              >
                <Link href="/create">
                  <Sparkles /> AI 创建新课程
                </Link>
              </Button>
            </div>
          </div>

          <button
            onClick={openImporter}
            className="group flex min-h-56 flex-col items-center justify-center rounded-3xl border-2 border-dashed border-violet-200 bg-white/60 p-7 text-center transition-all hover:border-violet-400 hover:bg-white hover:shadow-xl hover:shadow-violet-100/60 dark:border-violet-800 dark:bg-black/10 dark:hover:bg-white/5 dark:hover:shadow-none"
          >
            <div className="grid size-16 place-items-center rounded-3xl bg-violet-100 text-violet-700 transition-transform group-hover:-translate-y-1 dark:bg-violet-950 dark:text-violet-300">
              <UploadCloud className="size-8" />
            </div>
            <span className="mt-5 text-base font-semibold">把资源包或文件夹拖到这里</span>
            <span className="mt-2 text-xs leading-5 text-muted-foreground">
              也可以点击选择 · 支持 .maic.zip
              <br />
              导入前会先检查离线完整度
            </span>
          </button>
        </div>
      </section>

      <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: '本机课程',
            value: courses.length,
            unit: '门',
            icon: FolderOpen,
            tone: 'violet',
          },
          {
            label: '完整离线',
            value: offlineReady,
            unit: '门',
            icon: CheckCircle2,
            tone: 'emerald',
          },
          { label: '我的适配版', value: adapted, unit: '门', icon: PencilRuler, tone: 'amber' },
          {
            label: '最近更新',
            value: courses.filter(({ stage }) => stage.updatedAt > recentCutoff).length,
            unit: '门',
            icon: Clock3,
            tone: 'sky',
          },
        ].map((stat) => {
          const Icon = stat.icon;
          const toneClasses = {
            violet: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
            emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
            amber: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
            sky: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
          }[stat.tone];
          return (
            <div
              key={stat.label}
              className="flex items-center gap-4 rounded-2xl border border-white bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.045]"
            >
              <div className={`grid size-11 place-items-center rounded-2xl ${toneClasses}`}>
                <Icon className="size-5" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{stat.label}</p>
                <p className="mt-0.5 text-xl font-semibold tabular-nums">
                  {loading ? '—' : stat.value}{' '}
                  <span className="text-xs font-normal text-muted-foreground">{stat.unit}</span>
                </p>
              </div>
            </div>
          );
        })}
      </section>

      <section className="mt-9">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-600 dark:text-violet-300">
              继续工作
            </p>
            <h2 className="mt-1.5 text-xl font-semibold tracking-tight">最近课程</h2>
          </div>
          <Button asChild variant="ghost" className="rounded-xl text-muted-foreground">
            <Link href="/courses">
              查看全部 <ArrowRight />
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
        ) : error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        ) : recentCourses.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {recentCourses.map((course) => (
              <CourseCard
                key={course.stage.id}
                course={course}
                slide={thumbnails[course.stage.id]}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-[24px] border border-dashed border-violet-200 bg-white/60 p-8 text-center dark:border-violet-900 dark:bg-white/[0.025]">
            <div className="grid size-14 place-items-center rounded-2xl bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
              <BookOpenCheck className="size-7" />
            </div>
            <h3 className="mt-4 text-base font-semibold">你的课程库还是空的</h3>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              导入一个 OpenMAIC 课程资源包，或从资源库开始探索。导入的数据会保存在当前设备。
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button
                onClick={openImporter}
                className="rounded-xl bg-violet-600 hover:bg-violet-700"
              >
                <Plus /> 导入第一门课程
              </Button>
              <Button asChild variant="outline" className="rounded-xl bg-transparent">
                <Link href="/library">
                  <LibraryBig /> 浏览资源库
                </Link>
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
