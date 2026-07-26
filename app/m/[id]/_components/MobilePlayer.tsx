'use client';

/**
 * _components/MobilePlayer.tsx
 *
 * Mobile playback surface (client). Combines:
 *   - TextScript     (current chapter text, auto-scroll)
 *   - AudioPlayer    (TTS audio with playback rate, prev/next)
 *   - ProgressBar    (overall course progress)
 *   - AIQuestionDialog (half-sheet for AI Q&A)
 *
 * State is local — no Redux / Zustand needed for a single-screen
 * surface. localStorage persists sceneIndex + audioOffset for
 * resume-on-next-visit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MobileChapter } from '@/lib/mobile/scene-helpers';
import {
  getProgress,
  setProgress,
  markSceneComplete,
  type CourseProgress,
} from '@/lib/mobile/progress';
import {
  getQuestionCount,
  incrementQuestionCount,
  questionsRemaining,
  QUESTION_LIMIT,
} from '@/lib/mobile/question-limit';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { TextScript } from './TextScript';
import { AudioPlayer } from './AudioPlayer';
import { AIQuestionDialog } from './AIQuestionDialog';
import { ProgressBar } from './ProgressBar';

interface MobilePlayerProps {
  courseId: string;
  courseTitle: string;
  chapters: MobileChapter[];
  /** When true, always start from chapter 0 (ignore localStorage progress) */
  isShareMode?: boolean;
}

export function MobilePlayer({
  courseId,
  courseTitle,
  chapters,
  isShareMode = false,
}: MobilePlayerProps) {
  // === Hydrate from localStorage ===
  const [hydrated, setHydrated] = useState(false);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [audioOffset, setAudioOffset] = useState(0);

  useEffect(() => {
    // Share/learner mode: always start from chapter 0, don't restore progress.
    // This matches the classroom page fix where share=1 forces first scene.
    if (isShareMode) {
      setSceneIndex(0);
      setAudioOffset(0);
      setHydrated(true);
      return;
    }

    const saved = getProgress(courseId);
    if (saved && saved.totalScenes === chapters.length) {
      setSceneIndex(Math.min(saved.sceneIndex, chapters.length - 1));
      setAudioOffset(saved.audioOffset ?? 0);
    }
    setHydrated(true);
  }, [courseId, chapters.length, isShareMode]);

  // Persist whenever sceneIndex or audioOffset changes (after hydration).
  useEffect(() => {
    if (!hydrated) return;
    const p: CourseProgress = {
      courseId,
      sceneIndex,
      audioOffset,
      totalScenes: chapters.length,
      updatedAt: new Date().toISOString(),
    };
    setProgress(p);
  }, [courseId, sceneIndex, audioOffset, chapters.length, hydrated]);

  // === AI dialog state ===
  const [dialogOpen, setDialogOpen] = useState(false);
  const [questionsLeft, setQuestionsLeft] = useState(QUESTION_LIMIT);

  useEffect(() => {
    setQuestionsLeft(questionsRemaining(courseId));
  }, [courseId, dialogOpen]);

  // === Playback rate (single source of truth, shared between AudioPlayer + buttons) ===
  const [rate, setRate] = useState<1 | 0.75 | 1.25 | 1.5 | 2>(1);

  // === Audio element ref so we can pause/resume from outside ===
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const handleAudioRef = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
  }, []);

  const current = chapters[sceneIndex];
  const hasPrev = sceneIndex > 0;
  const hasNext = sceneIndex < chapters.length - 1;

  const goPrev = useCallback(() => {
    if (!hasPrev) return;
    setAudioOffset(0);
    setSceneIndex((i) => Math.max(0, i - 1));
  }, [hasPrev]);

  const goNext = useCallback(() => {
    if (!hasNext) return;
    setAudioOffset(0);
    if (hasNext) {
      markSceneComplete(courseId, chapters.length);
    }
    setSceneIndex((i) => Math.min(chapters.length - 1, i + 1));
  }, [hasNext, courseId, chapters.length]);

  const handleEnded = useCallback(() => {
    if (hasNext) {
      markSceneComplete(courseId, chapters.length);
      setSceneIndex((i) => Math.min(chapters.length - 1, i + 1));
      setAudioOffset(0);
    }
  }, [hasNext, courseId, chapters.length]);

  // === AI question flow ===
  const handleAskQuestion = useCallback(
    async (question: string): Promise<string> => {
      const remaining = questionsRemaining(courseId);
      if (remaining <= 0) {
        throw new Error('本课程提问次数已用完');
      }

    const mc = getCurrentModelConfig();

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            id: `user-${Date.now()}`,
            role: 'user',
            parts: [{ type: 'text', text: question }],
          },
        ],
        // Build minimal but valid Scene objects for the AI to know the
        // current chapter context. Type is preserved from the original
        // scene (slide / quiz / interactive / pbl).
        storeState: {
          scenes: chapters.map((c) => ({
            id: c.sceneId,
            stageId: '',
            title: c.title,
            order: c.order,
            type: c.sceneType,
            content: { type: c.sceneType },
          })),
          currentSceneId: current?.sceneId ?? null,
          mode: 'autonomous',
          whiteboardOpen: false,
        },
        config: {
          // Pass empty agentIds so the server picks the user's default
          // agent set from their profile. This is the safest path
          // because we don't know the exact id format used here.
          agentIds: [],
          sessionType: 'qa',
        },
        directorState: { turnCount: 0 },
        // Server-side LLM config — mirrors what use-chat-sessions sends
        // in the PC flow so the mobile Q&A endpoint behaves identically.
        apiKey: mc.apiKey,
        baseUrl: mc.baseUrl,
        model: mc.modelString,
        providerType: mc.providerType,
      }),
    });

      if (!res.ok) {
        throw new Error(`提问失败：HTTP ${res.status}`);
      }

      // Consume SSE stream — collect text from text chunks. We treat the
      // entire stream as the combined "teacher + companion" reply.
      const reader = res.body?.getReader();
      if (!reader) throw new Error('无响应流');

      const decoder = new TextDecoder();
      let buffer = '';
      let combined = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === 'text_delta' && typeof evt.data === 'string') {
              combined += evt.data;
            } else if (
              evt.type === 'agent_message_complete' &&
              typeof evt.data?.text === 'string'
            ) {
              // Use the final text if delta chunks are missing.
              combined = evt.data.text;
            }
          } catch {
            // skip malformed
          }
        }
      }

      // Increment counter only after we got a successful reply
      const newCount = incrementQuestionCount(courseId);
      setQuestionsLeft(QUESTION_LIMIT - newCount);

      return combined || '（AI 没有返回内容，请重试）';
    },
    [courseId, chapters, current],
  );

  // === Loading state during hydration ===
  const heading = useMemo(() => {
    if (!hydrated) return '加载中…';
    if (!current) return '没有章节';
    return current.title;
  }, [hydrated, current]);

  if (!hydrated) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        正在加载课程…
      </div>
    );
  }

  if (!current) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
        这门课件还没有可播放的音频章节。
        <br />
        （所有章节均为交互式内容，暂不支持移动端播客模式）
      </div>
    );
  }

  return (
    <>
      {/* Top: chapter title + status (sticky just below the page header) */}
      <div className="mx-auto max-w-md w-full px-5 pt-4 pb-2 shrink-0">
        <h2 className="text-base font-medium leading-tight">{heading}</h2>
        <p className="text-xs text-muted-foreground mt-1">
          第 {sceneIndex + 1} 章 / 共 {chapters.length} 章
        </p>
      </div>

      {/* Middle: scrolling text. flex-1 + overflow so it takes remaining
          vertical space between the top heading and the bottom dock. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <TextScript text={current.text} active={!dialogOpen} />
      </div>

      {/* Bottom dock: progress + audio player + chapter controls.
          Sticky to the bottom of the viewport so users never have to
          scroll to find the play button — same pattern as 小宇宙.
          pb-safe accounts for iPhone home indicator. */}
      <div className="sticky bottom-0 bg-background border-t shadow-[0_-2px_8px_rgba(0,0,0,0.04)] shrink-0 pb-safe">
        <div className="mx-auto max-w-md w-full">
          <ProgressBar
            current={sceneIndex + 1}
            total={chapters.length}
            completed={Math.min(
              chapters.length,
              Math.max(0, (sceneIndex + 1)),
            )}
          />

          <AudioPlayer
            audioUrl={current.audioUrl}
            fallbackText={current.text}
            rate={rate}
            onRateChange={setRate}
            onTimeUpdate={(t) => setAudioOffset(t)}
            onEnded={handleEnded}
            registerAudio={handleAudioRef}
            sceneId={current.sceneId}
            stageId={courseId}
            audioSourceField={current.audioSourceField}
            audioSegments={current.audioSegments}
            fallbackAudioSegments={current.fallbackAudioSegments}
          />

          <div className="px-4 py-3 flex items-center justify-between border-t">
            <button
              onClick={goPrev}
              disabled={!hasPrev}
              className="text-sm text-muted-foreground disabled:opacity-40 px-3 py-2"
              style={{ minHeight: '44px' }}
            >
              ◀ 上一章
            </button>
            <button
              onClick={() => setDialogOpen(true)}
              disabled={questionsLeft <= 0}
              className="rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40 active:scale-95 transition-transform"
              style={{ minHeight: '44px' }}
            >
              💬 提问（{questionsLeft}/{QUESTION_LIMIT}）
            </button>
            <button
              onClick={goNext}
              disabled={!hasNext}
              className="text-sm text-muted-foreground disabled:opacity-40 px-3 py-2"
              style={{ minHeight: '44px' }}
            >
              下一章 ▶
            </button>
          </div>
        </div>
      </div>

      {/* AI dialog */}
      <AIQuestionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAsk={handleAskQuestion}
        courseTitle={courseTitle}
        chapterTitle={current.title}
        chapterText={current.text}
        remaining={questionsLeft}
      />
    </>
  );
}
