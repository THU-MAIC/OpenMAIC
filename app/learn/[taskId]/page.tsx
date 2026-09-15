'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookOpenCheck,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileQuestion,
  Lightbulb,
  NotebookPen,
  Play,
  Sparkles,
  Target,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useBrand } from '@/lib/brand/brand-context';
import { readSceneQuizAnswers, summarizeScenes } from '@/lib/classroom/complete-summary';
import { useI18n } from '@/lib/hooks/use-i18n';
import { buildLearningReview, type LearningReview } from '@/lib/learning/review-builder';
import {
  LEARNING_TASK_DRAFT_SESSION_KEY,
  getLearningTask,
  updateLearningTask,
} from '@/lib/learning/task-storage';
import type { LearningTaskStatus } from '@/lib/learning/types';
import { loadQuizAttemptState } from '@/lib/quiz/runtime';
import { loadStageData } from '@/lib/utils/stage-storage';

const STATUS_LABELS: Record<'zh-CN' | 'en-US', Record<LearningTaskStatus, string>> = {
  'zh-CN': { draft: '待完善', generating: '生成中', ready: '学习中', reviewed: '已回顾' },
  'en-US': {
    draft: 'Draft',
    generating: 'Generating',
    ready: 'In progress',
    reviewed: 'Reviewed',
  },
};

export default function LearningTaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const router = useRouter();
  const brand = useBrand();
  const { locale } = useI18n();
  const language = locale === 'zh-CN' ? 'zh-CN' : 'en-US';
  const zh = language === 'zh-CN';
  const [review, setReview] = useState<LearningReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [courseUnavailable, setCourseUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const task = getLearningTask(taskId);
      if (!task) {
        if (!cancelled) setLoading(false);
        return;
      }

      if (!task.classroomId) {
        if (!cancelled) {
          setReview(buildLearningReview(task, []));
          setLoading(false);
        }
        return;
      }

      try {
        const classroom = await loadStageData(task.classroomId);
        if (!classroom) {
          if (!cancelled) {
            setReview(buildLearningReview(task, []));
            setCourseUnavailable(true);
          }
          return;
        }
        const summary = await summarizeScenes(classroom.scenes, async (sceneId) => {
          const scene = classroom.scenes.find((candidate) => candidate.id === sceneId);
          return readSceneQuizAnswers(scene, loadQuizAttemptState);
        });
        if (!cancelled) {
          setReview(
            buildLearningReview(task, classroom.scenes, {
              courseTitle: classroom.stage.name,
              quiz: summary.quiz,
            }),
          );
        }
      } catch {
        if (!cancelled) {
          setReview(buildLearningReview(task, []));
          setCourseUnavailable(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const continueTask = () => {
    if (!review) return;
    if (review.task.classroomId && !courseUnavailable) {
      router.push(`/classroom/${review.task.classroomId}`);
      return;
    }
    const task =
      review.task.status === 'generating'
        ? updateLearningTask(review.task.id, { status: 'draft' })
        : review.task;
    if (!task) return;
    sessionStorage.setItem(LEARNING_TASK_DRAFT_SESSION_KEY, task.id);
    router.push('/learn/new');
  };

  const openScene = (sceneId: string) => {
    if (!review?.task.classroomId || courseUnavailable) return;
    router.push(`/classroom/${review.task.classroomId}?scene=${encodeURIComponent(sceneId)}`);
  };

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
        <CircleDashed className="mr-2 size-4 animate-spin text-primary" />
        {zh ? '正在整理任务进度…' : 'Preparing task progress…'}
      </main>
    );
  }

  if (!review) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="max-w-md rounded-3xl border bg-card p-8 text-center shadow-sm">
          <FileQuestion className="mx-auto size-10 text-muted-foreground" />
          <h1 className="mt-4 text-xl font-semibold">
            {zh ? '没有找到这项学习任务' : 'Learning task not found'}
          </h1>
          <Button className="mt-6" onClick={() => router.push('/')}>
            {zh ? '返回学习空间' : 'Back to learning space'}
          </Button>
        </div>
      </main>
    );
  }

  const task = review.task;
  const notes = review.items.filter((item) => item.note);
  const markedItems = review.items.filter((item) => item.markedForReview);
  const hasClassroom = !!task.classroomId && !courseUnavailable;
  const nextItem = review.items.find((item) => item.available && !item.visited);

  return (
    <main className="min-h-dvh bg-[radial-gradient(circle_at_80%_0%,color-mix(in_oklab,var(--primary)_10%,transparent),transparent_32%),var(--background)]">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 md:px-8">
          <button
            type="button"
            className="flex items-center gap-3"
            onClick={() => router.push('/')}
          >
            <ArrowLeft className="size-4 text-muted-foreground" />
            <img src={brand.logoSrc} alt={brand.productName} className="h-7 w-auto dark:hidden" />
            <img
              src={brand.darkLogoSrc}
              alt={brand.productName}
              className="hidden h-7 w-auto dark:block"
            />
          </button>
          <div className="flex items-center gap-2">
            {task.classroomId ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push(`/learn/${task.id}/review`)}
              >
                <BookOpenCheck className="size-4" />
                <span className="hidden sm:inline">{zh ? '学习回顾' : 'Review'}</span>
              </Button>
            ) : null}
            <Button size="sm" onClick={continueTask}>
              {hasClassroom ? <Play className="size-4" /> : <Sparkles className="size-4" />}
              {hasClassroom ? (zh ? '继续学习' : 'Continue') : zh ? '继续创建' : 'Continue setup'}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-8 md:px-8 md:py-12">
        <section
          data-testid="learning-task-detail"
          className="relative overflow-hidden rounded-[32px] border border-primary/15 bg-card p-6 shadow-[0_30px_80px_-55px_color-mix(in_oklab,var(--primary)_75%,transparent)] md:p-9"
        >
          <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full border-[52px] border-primary/[0.055]" />
          <div className="relative max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                {STATUS_LABELS[language][task.status]}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock3 className="size-3.5" />
                {zh ? '更新于' : 'Updated'} {new Date(task.updatedAt).toLocaleDateString(language)}
              </span>
            </div>
            <p className="mt-6 text-sm font-medium text-primary">{task.courseName}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-foreground md:text-5xl md:leading-[1.08]">
              {task.knowledgePoint}
            </h1>
            <div className="mt-6 flex items-start gap-3 rounded-2xl border border-primary/10 bg-primary/[0.035] p-4">
              <Target className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <p className="text-xs font-semibold text-primary">
                  {zh ? '本次学习目标' : 'Learning goal'}
                </p>
                <p className="mt-1 text-sm font-medium leading-6 text-foreground">
                  {task.learningGoal}
                </p>
              </div>
            </div>
          </div>
        </section>

        {courseUnavailable ? (
          <div className="mt-5 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            {zh
              ? '关联课堂当前不可用，任务目标、笔记和复习标记仍然保留。'
              : 'The linked classroom is unavailable, but your task records are preserved.'}
          </div>
        ) : null}

        <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            icon={CheckCircle2}
            label={zh ? '学习进度' : 'Progress'}
            value={`${review.progressPercent}%`}
            detail={`${review.visitedCount}/${review.sceneCount} ${zh ? '个环节' : 'scenes'}`}
          />
          <Metric
            icon={Bookmark}
            label={zh ? '待复习重点' : 'Review points'}
            value={String(markedItems.length)}
            detail={zh ? '主动标记的环节' : 'Marked scenes'}
          />
          <Metric
            icon={NotebookPen}
            label={zh ? '学习笔记' : 'Notes'}
            value={String(notes.length)}
            detail={zh ? '已沉淀的记录' : 'Saved records'}
          />
          <Metric
            icon={FileQuestion}
            label={zh ? '测验表现' : 'Quiz result'}
            value={review.quiz ? `${review.quiz.pct}%` : '—'}
            detail={
              review.quiz
                ? `${review.quiz.correct}/${review.quiz.total} ${zh ? '题正确' : 'correct'}`
                : zh
                  ? '暂无有效记录'
                  : 'No attempts yet'
            }
          />
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
          <div className="rounded-3xl border bg-card p-5 shadow-sm md:p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <BookOpenCheck className="size-4 text-primary" />
                  <h2 className="font-semibold">{zh ? '学习路径' : 'Learning path'}</h2>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {zh
                    ? '访问记录会自动沉淀为任务进度。'
                    : 'Visits automatically become task progress.'}
                </p>
              </div>
              <span className="text-sm font-semibold tabular-nums text-primary">
                {review.progressPercent}%
              </span>
            </div>
            <Progress value={review.progressPercent} className="mt-4 h-2" />

            {review.items.length ? (
              <div className="mt-5 space-y-2">
                {review.items.map((item, index) => (
                  <button
                    key={item.sceneId}
                    type="button"
                    disabled={!item.available || !hasClassroom}
                    onClick={() => openScene(item.sceneId)}
                    className="group flex w-full items-center gap-3 rounded-2xl border border-transparent px-3 py-3 text-left transition hover:border-primary/15 hover:bg-primary/[0.035] disabled:cursor-default"
                  >
                    <span
                      className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${item.visited ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
                    >
                      {item.visited ? <CheckCircle2 className="size-4" /> : index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {item.title}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        {item.markedForReview ? (
                          <span className="text-amber-600 dark:text-amber-400">
                            {zh ? '待复习' : 'Review'}
                          </span>
                        ) : null}
                        {item.note ? <span>{zh ? '已有笔记' : 'Note saved'}</span> : null}
                      </span>
                    </span>
                    {item.available && hasClassroom ? (
                      <ArrowRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <EmptyBlock
                text={
                  zh
                    ? '完成课程创建后，学习路径会显示在这里。'
                    : 'Your learning path will appear after course creation.'
                }
              />
            )}
          </div>

          <div className="space-y-6">
            <aside className="rounded-3xl border border-primary/15 bg-[linear-gradient(145deg,color-mix(in_oklab,var(--primary)_10%,var(--card)),var(--card))] p-5 shadow-sm">
              <div className="flex size-10 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                <Lightbulb className="size-5" />
              </div>
              <h2 className="mt-4 font-semibold">{zh ? '下一步建议' : 'Suggested next step'}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {nextItem
                  ? zh
                    ? `继续完成“${nextItem.title}”，让学习路径向前推进。`
                    : `Continue with “${nextItem.title}” to move forward.`
                  : markedItems.length
                    ? zh
                      ? `你还有 ${markedItems.length} 个重点环节待复习。`
                      : `${markedItems.length} review points are waiting.`
                    : zh
                      ? '当前任务已完成，可以进入学习回顾整理成果。'
                      : 'This task is complete. Review and consolidate your results.'}
              </p>
              <Button className="mt-5 w-full" onClick={continueTask}>
                {hasClassroom
                  ? zh
                    ? '继续学习'
                    : 'Continue learning'
                  : zh
                    ? '完善并生成课程'
                    : 'Complete course setup'}
                <ArrowRight className="size-4" />
              </Button>
            </aside>

            <aside className="rounded-3xl border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <NotebookPen className="size-4 text-primary" />
                <h2 className="font-semibold">{zh ? '最近笔记' : 'Recent notes'}</h2>
              </div>
              {notes.length ? (
                <div className="mt-4 space-y-3">
                  {notes.slice(0, 3).map((item) => (
                    <button
                      key={item.sceneId}
                      type="button"
                      disabled={!hasClassroom || !item.available}
                      onClick={() => openScene(item.sceneId)}
                      className="block w-full rounded-2xl bg-muted/55 p-3 text-left disabled:cursor-default"
                    >
                      <span className="block truncate text-xs font-semibold text-foreground">
                        {item.title}
                      </span>
                      <span className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {item.note}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyBlock
                  text={
                    zh
                      ? '课堂中记录的笔记会汇总到这里。'
                      : 'Classroom notes will be collected here.'
                  }
                />
              )}
            </aside>

            <aside className="rounded-3xl border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <Sparkles className="size-4 text-primary" />
                {zh ? '学习基础' : 'Prior knowledge'}
              </div>
              <p className="mt-3 text-sm leading-6 text-foreground">
                {task.priorKnowledge || (zh ? '未填写' : 'Not provided')}
              </p>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Target;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-3xl border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="size-4 text-primary" /> {label}
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function EmptyBlock({ text }: { text: string }) {
  return (
    <div className="mt-4 rounded-2xl bg-muted/50 px-4 py-6 text-center text-xs leading-5 text-muted-foreground">
      {text}
    </div>
  );
}
