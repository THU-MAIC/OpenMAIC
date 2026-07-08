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

    // Progress: use the RAW currentSceneId (loadStageData falls back to scene[0],
    // which would mark every stage as "started"). Position is the 1-based index
    // of that scene in the order-sorted list.
    const currentSceneId = raw?.currentSceneId;
    const started = !!currentSceneId;
    let currentScenePosition: number | null = null;
    let progressRatio: number | null = null;
    if (started) {
      const idx = scenes.findIndex((s) => s.id === currentSceneId);
      if (idx >= 0) {
        currentScenePosition = idx + 1;
        progressRatio = sceneCount > 0 ? round4(currentScenePosition / sceneCount) : null;
      }
    }

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
      quizSceneCount,
      pblSceneCount,
      interactiveSceneCount,
      currentScenePosition,
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
    quizAttemptCount: quiz.length,
    quizStageCount: new Set(quiz.map((q) => q.stageId)).size,
    avgQuizScoreRatio: round4(avg(quizRatios)),
    bestQuizScoreRatio: round4(max(quizRatios)),
    perfectQuizAttemptCount: quizRatios.filter((r) => r >= COMPLETE_THRESHOLD).length,
    chatSessionCount: chat.reduce((sum, c) => sum + c.total, 0),
    qaSessionCount: chat.reduce((sum, c) => sum + c.qa, 0),
    lectureSessionCount: chat.reduce((sum, c) => sum + c.lecture, 0),
    totalChatMessageCount: chat.reduce((sum, c) => sum + c.messages, 0),
    lastActivityAt: max([...stageTimes, ...quizTimes, ...chatTimes]),
  };

  const metricInput: MetricInput = {
    stageCount: metric.stageCount,
    startedStageCount: metric.startedStageCount,
    completedStageCountProxy: metric.completedStageCountProxy,
    quizAttemptCount: metric.quizAttemptCount,
    perfectQuizAttemptCount: metric.perfectQuizAttemptCount,
    avgQuizScoreRatio: metric.avgQuizScoreRatio,
    chatSessionCount: metric.chatSessionCount,
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
  const at = (id: string): number | null => {
    switch (id) {
      case 'start':
        return min(t.stageTimes);
      case 'finish1':
      case 'finish3':
        return max(t.stageTimes);
      case 'quiz1':
        return min(t.quizTimes);
      case 'perfect':
        return min(t.perfectTimes);
      case 'quiz80':
        return max(t.quizTimes);
      case 'chat1':
        return min(t.chatTimes);
      case 'chat20':
      case 'msg100':
        return max(t.chatTimes);
      default:
        return t.lastActivity;
    }
  };
  for (const a of achievements) {
    a.earnedAt = a.earned ? (at(a.id) ?? t.lastActivity) : null;
  }
}

function emptyReport(): LearnerReport {
  return {
    metric: {
      stageCount: 0,
      startedStageCount: 0,
      completedStageCountProxy: 0,
      avgProgressRatio: null,
      maxProgressRatio: null,
      quizAttemptCount: 0,
      quizStageCount: 0,
      avgQuizScoreRatio: null,
      bestQuizScoreRatio: null,
      perfectQuizAttemptCount: 0,
      chatSessionCount: 0,
      qaSessionCount: 0,
      lectureSessionCount: 0,
      totalChatMessageCount: 0,
      lastActivityAt: null,
    },
    stages: [],
    quiz: [],
    chat: [],
    achievements: computeAchievements({
      stageCount: 0,
      startedStageCount: 0,
      completedStageCountProxy: 0,
      quizAttemptCount: 0,
      perfectQuizAttemptCount: 0,
      avgQuizScoreRatio: null,
      chatSessionCount: 0,
      totalChatMessageCount: 0,
    }),
    isEmpty: true,
  };
}
