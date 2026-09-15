'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BookOpen,
  BookOpenCheck,
  Bookmark,
  Clock3,
  FileText,
  Plus,
  RotateCcw,
  Sparkles,
  Target,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  LEARNING_TASK_DRAFT_SESSION_KEY,
  loadLearningTasks,
  updateLearningTask,
} from '@/lib/learning/task-storage';
import type { LearningTask, LearningTaskStatus } from '@/lib/learning/types';
import { cn } from '@/lib/utils';

const STATUS_LABELS: Record<'zh-CN' | 'en-US', Record<LearningTaskStatus, string>> = {
  'zh-CN': { draft: '待继续', generating: '生成中', ready: '学习中', reviewed: '已回顾' },
  'en-US': {
    draft: 'Draft',
    generating: 'Generating',
    ready: 'In progress',
    reviewed: 'Reviewed',
  },
};

export function RecentTaskList() {
  const router = useRouter();
  const { locale } = useI18n();
  const language = locale === 'zh-CN' ? 'zh-CN' : 'en-US';
  const zh = language === 'zh-CN';
  const [tasks, setTasks] = useState<LearningTask[]>([]);

  const refresh = useCallback(() => setTasks(loadLearningTasks()), []);
  useEffect(() => {
    const frame = window.requestAnimationFrame(refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [refresh]);

  const continueTask = (task: LearningTask) => {
    if (task.classroomId) {
      router.push(`/classroom/${task.classroomId}`);
      return;
    }
    const draft =
      task.status === 'generating' ? updateLearningTask(task.id, { status: 'draft' }) : task;
    if (!draft) return;
    sessionStorage.setItem(LEARNING_TASK_DRAFT_SESSION_KEY, task.id);
    router.push('/learn/new');
  };

  const activeCount = tasks.filter((task) => task.status !== 'reviewed').length;
  const reviewCount = tasks.reduce((total, task) => total + task.reviewSceneIds.length, 0);
  const noteCount = tasks.reduce((total, task) => total + Object.keys(task.notes).length, 0);
  const recentTasks = tasks.slice(0, 4);
  const summaryItems = [
    { label: zh ? '全部任务' : 'All tasks', value: tasks.length, icon: Target },
    { label: zh ? '进行中' : 'Active', value: activeCount, icon: BookOpen },
    { label: zh ? '待复习' : 'To review', value: reviewCount, icon: Bookmark },
    { label: zh ? '学习笔记' : 'Notes', value: noteCount, icon: FileText },
  ];

  return (
    <section
      className="relative z-20 mt-8 w-full max-w-6xl px-4 md:mt-12 md:px-8"
      data-testid="learning-task-center"
    >
      <div className="overflow-hidden rounded-[28px] border border-primary/15 bg-card shadow-[0_24px_70px_-46px_color-mix(in_oklab,var(--primary)_55%,transparent)]">
        <div className="relative overflow-hidden border-b border-border/70 bg-[linear-gradient(125deg,color-mix(in_oklab,var(--primary)_12%,var(--card))_0%,var(--card)_56%,color-mix(in_oklab,var(--primary)_5%,var(--card))_100%)] px-5 py-6 sm:px-7 sm:py-7">
          <div className="pointer-events-none absolute -right-16 -top-24 size-64 rounded-full border-[44px] border-primary/[0.06]" />
          <div className="relative grid gap-7 lg:grid-cols-[1.35fr_1fr] lg:items-end">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
                <Sparkles className="size-4" />
                {zh ? '知构学习空间' : 'ZhiGou learning space'}
              </div>
              <h1 className="mt-3 max-w-2xl text-2xl font-semibold tracking-[-0.025em] text-foreground sm:text-[30px] sm:leading-10">
                {zh ? '围绕目标，组织你的每一次学习' : 'Organize every session around a clear goal'}
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                {zh
                  ? '从目标出发连接课程、笔记与复习重点，让生成的内容真正沉淀为学习成果。'
                  : 'Connect courses, notes, and review points so generated content becomes lasting learning.'}
              </p>
              <div className="mt-5 flex flex-wrap gap-2.5">
                <Button onClick={() => router.push('/learn/new')}>
                  <Plus className="size-4" />
                  {zh ? '创建学习任务' : 'Create learning task'}
                </Button>
                <Button variant="outline" onClick={() => router.push('/create')}>
                  <Sparkles className="size-4" />
                  {zh ? '自由创作课程' : 'Create a course'}
                </Button>
              </div>
            </div>

            <div
              className="grid grid-cols-2 gap-2.5"
              aria-label={zh ? '学习数据概览' : 'Learning overview'}
            >
              {summaryItems.map(({ label, value, icon: Icon }) => (
                <div
                  key={label}
                  className="rounded-2xl border border-border/65 bg-background/70 px-4 py-3.5 backdrop-blur-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <Icon className="size-3.5 text-primary" aria-hidden="true" />
                  </div>
                  <strong className="mt-2 block text-2xl font-semibold tabular-nums text-foreground">
                    {value}
                  </strong>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 px-5 pb-4 pt-5 sm:px-7">
          <div>
            <div className="flex items-center gap-2">
              <Target className="size-4 text-primary" aria-hidden="true" />
              <h2 className="font-semibold tracking-tight">
                {zh ? '最近学习任务' : 'Recent learning tasks'}
              </h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {zh
                ? '继续学习，或回看已经记录的重点。'
                : 'Continue learning or revisit saved points.'}
            </p>
          </div>
          {tasks.length > 4 ? (
            <span className="text-xs text-muted-foreground">
              {zh ? `显示最近 4 项，共 ${tasks.length} 项` : `Latest 4 of ${tasks.length}`}
            </span>
          ) : null}
        </div>

        {recentTasks.length ? (
          <div className="grid gap-3 px-5 pb-6 sm:grid-cols-2 sm:px-7 lg:grid-cols-4">
            {recentTasks.map((task) => {
              const visitedCount = task.visitedSceneIds.length;
              const taskNoteCount = Object.keys(task.notes).length;
              const taskReviewCount = task.reviewSceneIds.length;
              return (
                <article
                  key={task.id}
                  className="group flex min-h-60 flex-col rounded-2xl border border-border/70 bg-background/55 p-4 transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[0_16px_35px_-28px_color-mix(in_oklab,var(--primary)_70%,transparent)]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={cn(
                        'rounded-full px-2 py-1 text-[11px] font-medium',
                        task.status === 'reviewed'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'bg-primary/10 text-primary',
                      )}
                    >
                      {STATUS_LABELS[language][task.status]}
                    </span>
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Clock3 className="size-3" />
                      {new Date(task.updatedAt).toLocaleDateString(language)}
                    </span>
                  </div>
                  <p className="mt-4 text-xs font-medium text-primary/80">{task.courseName}</p>
                  <h3 className="mt-1 line-clamp-2 font-semibold leading-6 text-foreground">
                    {task.knowledgePoint}
                  </h3>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {task.learningGoal}
                  </p>
                  <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-muted/55 p-2 text-center">
                    <TaskMetric value={visitedCount} label={zh ? '访问' : 'Visits'} />
                    <TaskMetric value={taskReviewCount} label={zh ? '复习' : 'Review'} />
                    <TaskMetric value={taskNoteCount} label={zh ? '笔记' : 'Notes'} />
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                    {task.classroomId ? (
                      <button
                        type="button"
                        onClick={() => router.push(`/learn/${task.id}/review`)}
                        className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-primary"
                      >
                        <BookOpenCheck className="size-3.5" />
                        {zh ? '学习回顾' : 'Review'}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {zh ? '尚未关联课堂' : 'No classroom yet'}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => continueTask(task)}
                      className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                    >
                      {task.classroomId ? (
                        <>
                          {zh ? '继续学习' : 'Continue'} <ArrowRight className="size-3.5" />
                        </>
                      ) : (
                        <>
                          {zh ? '继续创建' : 'Resume'} <RotateCcw className="size-3.5" />
                        </>
                      )}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="mx-5 mb-6 flex flex-col items-center rounded-2xl border border-dashed border-primary/20 bg-primary/[0.025] px-6 py-9 text-center sm:mx-7">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Target className="size-5" />
            </span>
            <h3 className="mt-4 font-semibold">
              {zh ? '从第一个明确的学习目标开始' : 'Start with one clear learning goal'}
            </h3>
            <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
              {zh
                ? '创建目标任务后，课堂访问、笔记和复习重点会自动汇总在这里。'
                : 'Classroom visits, notes, and review points will be collected here.'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function TaskMetric({ value, label }: { value: number; label: string }) {
  return (
    <span className="min-w-0">
      <strong className="block text-sm font-semibold tabular-nums text-foreground">{value}</strong>
      <span className="block truncate text-[10px] text-muted-foreground">{label}</span>
    </span>
  );
}
