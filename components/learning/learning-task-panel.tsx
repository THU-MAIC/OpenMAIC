'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bookmark, BookOpenCheck, Check, ChevronRight, NotebookPen, Target, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  findLearningTaskByClassroomId,
  recordVisitedScene,
  saveLearningTaskNote,
  toggleLearningTaskReviewScene,
} from '@/lib/learning/task-storage';
import type { LearningTask } from '@/lib/learning/types';
import type { Scene } from '@/lib/types/stage';
import { cn } from '@/lib/utils';

interface LearningTaskPanelProps {
  classroomId: string;
  scenes: Scene[];
  currentSceneId: string | null;
  onSelectScene: (sceneId: string) => void;
}

export function LearningTaskPanel({
  classroomId,
  scenes,
  currentSceneId,
  onSelectScene,
}: LearningTaskPanelProps) {
  const router = useRouter();
  const [task, setTask] = useState<LearningTask | null>(null);
  const [open, setOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);

  useEffect(() => {
    setTask(findLearningTaskByClassroomId(classroomId));
  }, [classroomId]);

  const taskId = task?.id;
  useEffect(() => {
    if (!taskId || !currentSceneId) return;
    const updated = recordVisitedScene(taskId, currentSceneId);
    if (updated) setTask(updated);
  }, [currentSceneId, taskId]);

  useEffect(() => {
    if (!task || !currentSceneId) {
      setNoteDraft('');
      return;
    }
    setNoteDraft(task.notes[currentSceneId]?.content ?? '');
    setNoteSaved(false);
  }, [currentSceneId, task]);

  const orderedScenes = useMemo(() => [...scenes].sort((a, b) => a.order - b.order), [scenes]);
  if (!task) return null;

  const currentMarked = !!currentSceneId && task.reviewSceneIds.includes(currentSceneId);
  const progress = scenes.length
    ? Math.round(
        (task.visitedSceneIds.filter((id) => scenes.some((scene) => scene.id === id)).length /
          scenes.length) *
          100,
      )
    : 0;

  const saveNote = () => {
    if (!currentSceneId) return;
    const updated = saveLearningTaskNote(task.id, currentSceneId, noteDraft);
    if (!updated) return;
    setTask(updated);
    setNoteSaved(true);
    window.setTimeout(() => setNoteSaved(false), 1600);
  };

  const toggleReview = () => {
    if (!currentSceneId) return;
    const updated = toggleLearningTaskReviewScene(task.id, currentSceneId);
    if (updated) setTask(updated);
  };

  return (
    <>
      <button
        type="button"
        data-testid="learning-task-panel-trigger"
        onClick={() => setOpen(true)}
        className={cn(
          'absolute right-4 top-20 z-[70] flex h-10 items-center gap-2 rounded-xl border border-primary/25 bg-background/92 px-3 text-sm font-semibold text-foreground shadow-lg backdrop-blur-xl transition hover:border-primary/50 hover:text-primary',
          open && 'pointer-events-none opacity-0',
        )}
      >
        <Target className="size-4 text-primary" aria-hidden="true" />
        <span className="hidden sm:inline">学习任务</span>
        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
          {progress}%
        </span>
      </button>

      {open ? (
        <div
          data-testid="learning-task-panel"
          className="absolute inset-x-3 bottom-3 z-[80] flex max-h-[72%] flex-col overflow-hidden rounded-2xl border border-border/80 bg-background/96 shadow-2xl backdrop-blur-xl md:inset-y-4 md:left-auto md:right-4 md:max-h-none md:w-[380px]"
        >
          <header className="flex items-start justify-between border-b border-border/70 px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                <BookOpenCheck className="size-4" aria-hidden="true" />
                目标学习任务
              </div>
              <h2 className="mt-2 truncate text-lg font-semibold">{task.knowledgePoint}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{task.courseName}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpen(false)}
              aria-label="关闭学习任务"
            >
              <X className="size-4" />
            </Button>
          </header>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <section>
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">学习进度</span>
                <span className="text-muted-foreground">{progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-3 rounded-xl bg-primary/[0.06] p-3 text-sm leading-6 text-foreground">
                {task.learningGoal}
              </p>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground">学习路径</h3>
              <div className="space-y-1">
                {orderedScenes.map((scene, index) => {
                  const visited = task.visitedSceneIds.includes(scene.id);
                  const marked = task.reviewSceneIds.includes(scene.id);
                  return (
                    <button
                      key={scene.id}
                      type="button"
                      onClick={() => onSelectScene(scene.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted',
                        currentSceneId === scene.id && 'bg-primary/10 text-primary',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground',
                          visited && 'bg-primary text-primary-foreground',
                        )}
                      >
                        {visited ? <Check className="size-3.5" /> : index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {scene.title || `环节 ${index + 1}`}
                      </span>
                      {marked ? (
                        <Bookmark className="size-3.5 fill-current text-amber-500" />
                      ) : null}
                      <ChevronRight className="size-3.5 text-muted-foreground" />
                    </button>
                  );
                })}
              </div>
            </section>

            {currentSceneId ? (
              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                    <NotebookPen className="size-3.5" /> 当前环节笔记
                  </h3>
                  <button
                    type="button"
                    onClick={toggleReview}
                    className={cn(
                      'flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors',
                      currentMarked
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'bg-muted text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Bookmark className={cn('size-3.5', currentMarked && 'fill-current')} />
                    {currentMarked ? '已加入复习' : '加入复习'}
                  </button>
                </div>
                <Textarea
                  value={noteDraft}
                  onChange={(event) => {
                    setNoteDraft(event.target.value);
                    setNoteSaved(false);
                  }}
                  onBlur={saveNote}
                  className="min-h-28 resize-none"
                  placeholder="记录你的理解、疑问或解题提示…"
                />
                <div className="mt-2 flex justify-end">
                  <Button size="sm" variant="outline" onClick={saveNote}>
                    {noteSaved ? '已保存' : '保存笔记'}
                  </Button>
                </div>
              </section>
            ) : null}
          </div>
          <footer className="border-t border-border/70 p-4">
            <Button className="w-full" onClick={() => router.push(`/learn/${task.id}/review`)}>
              查看学习回顾
            </Button>
          </footer>
        </div>
      ) : null}
    </>
  );
}
