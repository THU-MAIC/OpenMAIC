'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpenCheck, Clock3, Plus, RotateCcw, Target } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  LEARNING_TASK_DRAFT_SESSION_KEY,
  loadLearningTasks,
  updateLearningTask,
} from '@/lib/learning/task-storage';
import type { LearningTask, LearningTaskStatus } from '@/lib/learning/types';
import { cn } from '@/lib/utils';

const STATUS_LABELS: Record<LearningTaskStatus, string> = {
  draft: '待继续',
  generating: '生成中',
  ready: '学习中',
  reviewed: '已回顾',
};

export function RecentTaskList() {
  const router = useRouter();
  const [tasks, setTasks] = useState<LearningTask[]>([]);

  const refresh = useCallback(() => setTasks(loadLearningTasks().slice(0, 4)), []);
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

  return (
    <section
      className="relative z-20 mt-8 w-full max-w-6xl px-4 md:mt-12 md:px-8"
      data-testid="learning-task-center"
    >
      <div className="overflow-hidden rounded-2xl border border-primary/15 bg-card shadow-[0_18px_50px_-38px_color-mix(in_oklab,var(--primary)_45%,transparent)]">
        <div className="flex flex-col gap-4 border-b border-border/70 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              <Target className="size-4" /> 目标学习
            </div>
            <h2 className="mt-2 text-xl font-semibold tracking-tight">我的学习任务</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              围绕目标学习、记录理解，并把重点带进复习。
            </p>
          </div>
          <Button onClick={() => router.push('/learn/new')}>
            <Plus className="size-4" /> 创建学习任务
          </Button>
        </div>

        {tasks.length ? (
          <div className="grid gap-px bg-border/60 sm:grid-cols-2 lg:grid-cols-4">
            {tasks.map((task) => {
              const visitedCount = task.visitedSceneIds.length;
              const noteCount = Object.keys(task.notes).length;
              return (
                <article key={task.id} className="flex min-h-52 flex-col bg-card p-5">
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={cn(
                        'rounded-full px-2 py-1 text-[11px] font-medium',
                        task.status === 'reviewed'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'bg-primary/10 text-primary',
                      )}
                    >
                      {STATUS_LABELS[task.status]}
                    </span>
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Clock3 className="size-3" />
                      {new Date(task.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="mt-4 text-xs text-muted-foreground">{task.courseName}</p>
                  <h3 className="mt-1 line-clamp-2 font-semibold leading-6">
                    {task.knowledgePoint}
                  </h3>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {task.learningGoal}
                  </p>
                  <div className="mt-auto flex items-center justify-between pt-5">
                    <span className="text-[11px] text-muted-foreground">
                      {visitedCount} 个已访问 · {noteCount} 条笔记
                    </span>
                    <button
                      type="button"
                      onClick={() => continueTask(task)}
                      className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                    >
                      {task.classroomId ? (
                        <>
                          继续学习 <ArrowRight className="size-3.5" />
                        </>
                      ) : (
                        <>
                          继续创建 <RotateCcw className="size-3.5" />
                        </>
                      )}
                    </button>
                  </div>
                  {task.classroomId ? (
                    <button
                      type="button"
                      onClick={() => router.push(`/learn/${task.id}/review`)}
                      className="mt-3 flex items-center justify-center gap-1.5 rounded-lg border border-border/70 py-2 text-xs text-muted-foreground transition hover:border-primary/30 hover:text-primary"
                    >
                      <BookOpenCheck className="size-3.5" /> 查看学习回顾
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Target className="size-5" />
            </span>
            <h3 className="mt-4 font-semibold">从第一个明确的学习目标开始</h3>
            <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
              不只是生成一门课：把目标、课堂、笔记和复习重点连接成一条完整路径。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
