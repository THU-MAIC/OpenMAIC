'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Bookmark,
  BookOpenCheck,
  Check,
  CheckCircle2,
  Download,
  FileQuestion,
  NotebookPen,
  Play,
  Target,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useBrand } from '@/lib/brand/brand-context';
import { readSceneQuizAnswers, summarizeScenes } from '@/lib/classroom/complete-summary';
import {
  buildLearningReview,
  buildReviewQueue,
  learningReviewToMarkdown,
  type LearningReview,
} from '@/lib/learning/review-builder';
import {
  getLearningTask,
  toggleLearningTaskReviewScene,
  updateLearningTask,
} from '@/lib/learning/task-storage';
import { loadQuizAttemptState } from '@/lib/quiz/runtime';
import { loadStageData } from '@/lib/utils/stage-storage';

export default function LearningReviewPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const router = useRouter();
  const brand = useBrand();
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
      const reviewedTask = updateLearningTask(task.id, { status: 'reviewed' }) ?? task;
      if (!reviewedTask.classroomId) {
        if (!cancelled) {
          setReview(buildLearningReview(reviewedTask, []));
          setCourseUnavailable(true);
          setLoading(false);
        }
        return;
      }

      try {
        const classroom = await loadStageData(reviewedTask.classroomId);
        if (!classroom) {
          if (!cancelled) {
            setReview(buildLearningReview(reviewedTask, []));
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
            buildLearningReview(reviewedTask, classroom.scenes, {
              courseTitle: classroom.stage.name,
              quiz: summary.quiz,
            }),
          );
        }
      } catch {
        if (!cancelled) {
          setReview(buildLearningReview(reviewedTask, []));
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

  const openScene = (sceneId?: string) => {
    if (!review?.task.classroomId) return;
    const query = sceneId ? `?scene=${encodeURIComponent(sceneId)}` : '';
    router.push(`/classroom/${review.task.classroomId}${query}`);
  };

  const exportReview = () => {
    if (!review) return;
    const blob = new Blob([learningReviewToMarkdown(review)], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${review.task.courseName}-${review.task.knowledgePoint}-学习回顾.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const completeReview = (sceneId: string) => {
    if (!review) return;
    const updatedTask = toggleLearningTaskReviewScene(review.task.id, sceneId);
    if (!updatedTask) return;
    setReview((current) => {
      if (!current) return current;
      const items = current.items.map((item) =>
        item.sceneId === sceneId ? { ...item, markedForReview: false } : item,
      );
      return { ...current, task: updatedTask, items, reviewQueue: buildReviewQueue(items) };
    });
  };

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground">
        正在整理学习回顾…
      </main>
    );
  }

  if (!review) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
          <FileQuestion className="mx-auto size-10 text-muted-foreground" />
          <h1 className="mt-4 text-xl font-semibold">没有找到这项学习任务</h1>
          <Button className="mt-6" onClick={() => router.push('/')}>
            返回课程空间
          </Button>
        </div>
      </main>
    );
  }

  const reviewItems = review.reviewQueue;
  const pendingCount = reviewItems.filter((item) => item.markedForReview).length;
  const priorityMeta = {
    high: {
      label: '优先复习',
      reason: '你主动标记了此环节并留下笔记，建议结合笔记重点复盘。',
      className: 'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300',
    },
    medium: {
      label: '建议复习',
      reason: '你在课堂中主动标记了此环节，建议重新回顾核心内容。',
      className: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    },
    reference: {
      label: '笔记参考',
      reason: '此环节保留了学习笔记，可在需要时返回查阅。',
      className: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    },
  } as const;

  return (
    <main className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 md:px-8">
          <button className="flex items-center gap-3" onClick={() => router.push('/')}>
            <ArrowLeft className="size-4 text-muted-foreground" />
            <img src={brand.logoSrc} alt={brand.productName} className="h-7 w-auto dark:hidden" />
            <img
              src={brand.darkLogoSrc}
              alt={brand.productName}
              className="hidden h-7 w-auto dark:block"
            />
          </button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={exportReview}>
              <Download className="size-4" /> 导出复习清单
            </Button>
            {!courseUnavailable ? (
              <Button size="sm" onClick={() => openScene()}>
                <Play className="size-4" /> 继续学习
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            <BookOpenCheck className="size-4" /> 学习回顾
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {review.task.knowledgePoint}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">{review.courseTitle}</p>
        </div>

        {courseUnavailable ? (
          <div className="mt-6 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            关联课堂当前不可用，任务目标和已有记录仍然保留。
          </div>
        ) : null}

        <section className="mt-8 grid gap-4 md:grid-cols-3">
          <Metric icon={Target} label="学习目标" value={review.task.learningGoal} />
          <Metric
            icon={CheckCircle2}
            label="学习进度"
            value={`${review.visitedCount}/${review.sceneCount} · ${review.progressPercent}%`}
          />
          <Metric
            icon={FileQuestion}
            label="真实测验记录"
            value={
              review.quiz
                ? `${review.quiz.correct}/${review.quiz.total} · ${review.quiz.pct}%`
                : '暂无记录'
            }
          />
        </section>

        <section className="mt-10 grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
          <div className="rounded-2xl border bg-card p-5 shadow-sm">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Bookmark className="size-4 text-primary" />
                  <h2 className="font-semibold">智能复习清单</h2>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  根据你的复习标记和课堂笔记自动排序，优先处理最需要巩固的内容。
                </p>
              </div>
              <span
                data-testid="review-pending-count"
                aria-live="polite"
                className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
              >
                待完成 {pendingCount}
              </span>
            </div>
            {reviewItems.length ? (
              <div className="space-y-3">
                {reviewItems.map((item) => {
                  const meta = priorityMeta[item.priority];
                  return (
                    <article
                      key={item.sceneId}
                      data-testid={`review-queue-item-${item.sceneId}`}
                      className="rounded-xl border border-border/70 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-medium">{item.title}</h3>
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.className}`}
                            >
                              {meta.label}
                            </span>
                          </div>
                          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                            {meta.reason}
                          </p>
                        </div>
                      </div>
                      {item.note ? (
                        <div className="mt-3 rounded-lg bg-muted/55 px-3 py-2.5">
                          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                            <NotebookPen className="size-3" /> 课堂笔记
                          </div>
                          <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/80">
                            {item.note}
                          </p>
                        </div>
                      ) : null}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={courseUnavailable || !item.available}
                          onClick={() => openScene(item.sceneId)}
                        >
                          <Play className="size-3.5" /> 回到此环节
                        </Button>
                        {item.markedForReview ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            data-testid={`complete-review-${item.sceneId}`}
                            onClick={() => completeReview(item.sceneId)}
                          >
                            <Check className="size-3.5" /> 完成复习
                          </Button>
                        ) : null}
                        {!item.available ? (
                          <span className="self-center text-xs text-muted-foreground">
                            原课堂环节已不可用
                          </span>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl bg-muted/50 px-4 py-8 text-center text-sm text-muted-foreground">
                在课堂中记录笔记或标记待复习环节后，会集中显示在这里。
              </div>
            )}
          </div>

          <aside className="rounded-2xl border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2">
              <NotebookPen className="size-4 text-primary" />
              <h2 className="font-semibold">学习路径</h2>
            </div>
            <div className="space-y-2">
              {review.items.map((item, index) => (
                <button
                  key={item.sceneId}
                  type="button"
                  disabled={courseUnavailable || !item.available}
                  onClick={() => openScene(item.sceneId)}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-default"
                >
                  <span
                    className={`flex size-6 items-center justify-center rounded-full text-[11px] ${item.visited ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
                  >
                    {item.visited ? <CheckCircle2 className="size-3.5" /> : index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </button>
              ))}
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Target;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="size-4 text-primary" /> {label}
      </div>
      <p className="mt-3 text-sm font-semibold leading-6 text-foreground">{value}</p>
    </div>
  );
}
