// Build the learning report for the current device from local data only:
//   - stages / scenes / chats  → IndexedDB (Dexie) via stage-storage helpers
//   - quiz submissions          → localStorage via quiz/persistence
// No server, no import step. Runs client-side (guards localStorage access).
//
// Metric formulas mirror the original export pipeline (single-user subset):
// see export-learning-dashboard-package.mjs in the report toolkit.

import { db } from '@/lib/utils/database';
import { listStages, loadStageData } from '@/lib/utils/stage-storage';
import { readSubmittedState } from '@/lib/quiz/persistence';
import type { QuizContent } from '@/lib/types/stage';
import { computeAchievements, type MetricInput } from './achievements';
import type { Achievement, ChatVM, LearnerReport, QuizVM, ReportMetric, StageVM } from './types';

const round4 = (v: number | null): number | null =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(4));

const avg = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

const max = (xs: number[]): number | null => (xs.length ? Math.max(...xs) : null);
const min = (xs: number[]): number | null => (xs.length ? Math.min(...xs) : null);

/** A stage counts as "completed" when the learner reached (essentially) the end. */
const COMPLETE_THRESHOLD = 0.999;

export async function buildLearnerReport(): Promise<LearnerReport> {
  const list = await listStages();
  if (list.length === 0) return emptyReport();

  const stages: StageVM[] = [];
  const quiz: QuizVM[] = [];
  const chat: ChatVM[] = [];
  let totalSlideSceneCount = 0;

  // Timestamp pools for approximating achievement earnedAt.
  const stageTimes: number[] = [];
  const quizTimes: number[] = [];
  const perfectTimes: number[] = [];
  const chatTimes: number[] = [];

  for (const item of list) {
    const raw = await db.stages.get(item.id);
    const data = await loadStageData(item.id);
    if (!data) continue;
    const scenes = data.scenes; // Scene[], sorted by order
    const stageName = item.name || raw?.name || item.id;
    const updatedAt = raw?.updatedAt ?? item.updatedAt ?? null;
    if (updatedAt != null) stageTimes.push(updatedAt);
    if (raw?.createdAt != null) stageTimes.push(raw.createdAt);

    const sceneCount = scenes.length;
    const quizSceneCount = scenes.filter((s) => s.type === 'quiz').length;
    const pblSceneCount = scenes.filter((s) => s.type === 'pbl').length;
    const interactiveSceneCount = scenes.filter((s) => s.type === 'interactive').length;
    totalSlideSceneCount += scenes.filter((s) => s.type === 'slide').length;

    // Progress signal. OpenMAIC's local build does NOT persist a learner's
    // playback position (currentSceneId is reset to scene[0] on every classroom
    // load and only advanced in memory; the playbackState table is never
    // written). The only durable signals are the generation state: whether the
    // course finished generating (stageOutlines.generationComplete) and how many
    // of the planned scenes exist. So "progress" here = course build completeness.
    const outlinesRec = await db.stageOutlines.get(item.id);
    const plannedSceneCount = outlinesRec?.outlines?.length ?? sceneCount;
    const generationComplete = outlinesRec?.generationComplete === true;
    const started = sceneCount > 0;
    const progressRatio = generationComplete
      ? 1
      : plannedSceneCount > 0
        ? round4(Math.min(1, sceneCount / plannedSceneCount))
        : null;

    // Quiz: each quiz scene with a graded ("reviewing") submission is one attempt.
    const stageQuizRatios: number[] = [];
    for (const scene of scenes) {
      if (scene.type !== 'quiz') continue;
      const state = readSubmittedState(scene.id);
      if (!state || state.kind !== 'reviewing') continue;
      const questions = (scene.content as QuizContent).questions ?? [];
      const totalPoints = questions.reduce((sum, q) => sum + (q.points ?? 1), 0);
      const score = state.results.reduce((sum, r) => sum + (r.earned || 0), 0);
      const scoreRatio = totalPoints > 0 ? Math.min(1, score / totalPoints) : 0;
      const submittedAt = updatedAt;
      quiz.push({
        stageId: item.id,
        stageName,
        sceneId: scene.id,
        score,
        totalPoints,
        scoreRatio,
        submittedAt,
      });
      stageQuizRatios.push(scoreRatio);
      if (submittedAt != null) {
        quizTimes.push(submittedAt);
        if (scoreRatio >= COMPLETE_THRESHOLD) perfectTimes.push(submittedAt);
      }
    }

    // Chat: aggregate this stage's sessions by type and status.
    const chats = data.chats;
    const qa = chats.filter((c) => c.type === 'qa').length;
    const lecture = chats.filter((c) => c.type === 'lecture').length;
    const discussion = chats.filter((c) => c.type === 'discussion').length;
    const completed = chats.filter((c) => c.status === 'completed').length;
    const active = chats.filter((c) => c.status === 'active').length;
    const interrupted = chats.filter((c) => c.status === 'interrupted').length;
    const messages = chats.reduce((sum, c) => sum + (c.messages?.length ?? 0), 0);
    for (const c of chats) if (c.updatedAt != null) chatTimes.push(c.updatedAt);
    if (chats.length > 0) {
      chat.push({
        stageId: item.id,
        stageName,
        qa,
        lecture,
        discussion,
        completed,
        active,
        interrupted,
        total: chats.length,
        messages,
      });
    }

    stages.push({
      stageId: item.id,
      name: stageName,
      sceneCount,
      plannedSceneCount,
      quizSceneCount,
      pblSceneCount,
      interactiveSceneCount,
      generationComplete,
      progressRatio,
      started,
      quizSubmissionCount: stageQuizRatios.length,
      avgQuizScoreRatio: round4(avg(stageQuizRatios)),
      chatSessionCount: chats.length,
      qaSessionCount: qa,
      lectureSessionCount: lecture,
      totalMessageCount: messages,
      updatedAt,
    });
  }

  const progressValues = stages.map((s) => s.progressRatio).filter((r): r is number => r != null);
  const quizRatios = quiz.map((q) => q.scoreRatio);

  const metric: ReportMetric = {
    stageCount: stages.length,
    startedStageCount: stages.filter((s) => s.started).length,
    completedStageCountProxy: progressValues.filter((r) => r >= COMPLETE_THRESHOLD).length,
    avgProgressRatio: round4(avg(progressValues)),
    maxProgressRatio: round4(max(progressValues)),
    totalSceneCount: stages.reduce((sum, s) => sum + s.sceneCount, 0),
    slideSceneCount: totalSlideSceneCount,
    quizSceneCount: stages.reduce((sum, s) => sum + s.quizSceneCount, 0),
    pblSceneCount: stages.reduce((sum, s) => sum + s.pblSceneCount, 0),
    interactiveSceneCount: stages.reduce((sum, s) => sum + s.interactiveSceneCount, 0),
    quizAttemptCount: quiz.length,
    quizStageCount: new Set(quiz.map((q) => q.stageId)).size,
    avgQuizScoreRatio: round4(avg(quizRatios)),
    bestQuizScoreRatio: round4(max(quizRatios)),
    perfectQuizAttemptCount: quizRatios.filter((r) => r >= COMPLETE_THRESHOLD).length,
    chatSessionCount: chat.reduce((sum, c) => sum + c.total, 0),
    qaSessionCount: chat.reduce((sum, c) => sum + c.qa, 0),
    lectureSessionCount: chat.reduce((sum, c) => sum + c.lecture, 0),
    discussionSessionCount: chat.reduce((sum, c) => sum + c.discussion, 0),
    totalChatMessageCount: chat.reduce((sum, c) => sum + c.messages, 0),
    lastActivityAt: max([...stageTimes, ...quizTimes, ...chatTimes]),
  };

  const metricInput: MetricInput = {
    stageCount: metric.stageCount,
    startedStageCount: metric.startedStageCount,
    completedStageCountProxy: metric.completedStageCountProxy,
    totalSceneCount: metric.totalSceneCount,
    slideSceneCount: metric.slideSceneCount,
    quizSceneCount: metric.quizSceneCount,
    pblSceneCount: metric.pblSceneCount,
    interactiveSceneCount: metric.interactiveSceneCount,
    quizAttemptCount: metric.quizAttemptCount,
    perfectQuizAttemptCount: metric.perfectQuizAttemptCount,
    avgQuizScoreRatio: metric.avgQuizScoreRatio,
    chatSessionCount: metric.chatSessionCount,
    qaSessionCount: metric.qaSessionCount,
    lectureSessionCount: metric.lectureSessionCount,
    discussionSessionCount: metric.discussionSessionCount,
    totalChatMessageCount: metric.totalChatMessageCount,
  };
  const achievements = computeAchievements(metricInput);
  fillEarnedAt(achievements, {
    stageTimes,
    quizTimes,
    perfectTimes,
    chatTimes,
    lastActivity: metric.lastActivityAt,
  });

  return { metric, stages, quiz, chat, achievements, isEmpty: false };
}

/** Approximate each earned achievement's completion time from available events. */
function fillEarnedAt(
  achievements: Achievement[],
  t: {
    stageTimes: number[];
    quizTimes: number[];
    perfectTimes: number[];
    chatTimes: number[];
    lastActivity: number | null;
  },
): void {
  const at = (a: Achievement): number | null => {
    // "first-earned" ids anchor to the earliest event; the rest to the latest.
    switch (a.id) {
      case 'start':
        return min(t.stageTimes);
      case 'quiz1':
        return min(t.quizTimes);
      case 'perfect':
        return min(t.perfectTimes);
      case 'chat1':
        return min(t.chatTimes);
    }
    switch (a.group) {
      case 'quiz':
        return max(t.quizTimes);
      case 'chat':
        return max(t.chatTimes);
      default: // course + explore anchor to stage activity
        return max(t.stageTimes);
    }
  };
  for (const a of achievements) {
    a.earnedAt = a.earned ? (at(a) ?? t.lastActivity) : null;
  }
}

function emptyReport(): LearnerReport {
  const zero: MetricInput = {
    stageCount: 0,
    startedStageCount: 0,
    completedStageCountProxy: 0,
    totalSceneCount: 0,
    slideSceneCount: 0,
    quizSceneCount: 0,
    pblSceneCount: 0,
    interactiveSceneCount: 0,
    quizAttemptCount: 0,
    perfectQuizAttemptCount: 0,
    avgQuizScoreRatio: null,
    chatSessionCount: 0,
    qaSessionCount: 0,
    lectureSessionCount: 0,
    discussionSessionCount: 0,
    totalChatMessageCount: 0,
  };
  return {
    metric: {
      ...zero,
      avgProgressRatio: null,
      maxProgressRatio: null,
      quizStageCount: 0,
      bestQuizScoreRatio: null,
      lastActivityAt: null,
    },
    stages: [],
    quiz: [],
    chat: [],
    achievements: computeAchievements(zero),
    isEmpty: true,
  };
}
