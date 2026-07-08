// Completion achievements — fixed-threshold badges computed from a single
// learner's own metrics. Pure & synchronous (client-side): no server, no db.
//
// Ported from the report platform's achievements.ts. The cohort-ranked
// "competition" medals (rankProgress/rankQuiz/rankChat) and Steam-style rarity
// are intentionally dropped: with only this device's data there is no cohort to
// rank against, so those degrade to meaningless "rank 1 of 1". Titles/desc are
// i18n keys resolved by the UI layer (learningReport.ach.*), not literals.

import type { Achievement } from './types';

export interface MetricInput {
  stageCount: number;
  startedStageCount: number;
  completedStageCountProxy: number;
  quizAttemptCount: number;
  perfectQuizAttemptCount: number;
  avgQuizScoreRatio: number | null;
  chatSessionCount: number;
  totalChatMessageCount: number;
}

interface CompletionSpec {
  id: string;
  icon: Achievement['icon'];
  test: (m: MetricInput) => boolean;
}

// Order here is the display order in the grid. `test` mirrors the original
// production thresholds verbatim.
export const COMPLETION_SPECS: CompletionSpec[] = [
  { id: 'start', icon: 'progress', test: (m) => m.startedStageCount >= 1 },
  { id: 'finish1', icon: 'progress', test: (m) => m.completedStageCountProxy >= 1 },
  {
    id: 'finish3',
    icon: 'progress',
    test: (m) => m.stageCount > 0 && m.completedStageCountProxy / m.stageCount >= 0.8,
  },
  { id: 'quiz1', icon: 'quiz', test: (m) => m.quizAttemptCount >= 1 },
  { id: 'perfect', icon: 'quiz', test: (m) => m.perfectQuizAttemptCount >= 1 },
  { id: 'quiz80', icon: 'quiz', test: (m) => (m.avgQuizScoreRatio ?? 0) >= 0.8 },
  { id: 'chat1', icon: 'chat', test: (m) => m.chatSessionCount >= 1 },
  { id: 'chat20', icon: 'chat', test: (m) => m.chatSessionCount >= 20 },
  { id: 'msg100', icon: 'chat', test: (m) => m.totalChatMessageCount >= 100 },
];

/**
 * Compute completion achievements for the current learner. `earnedAt` is left
 * null here and filled in by the report builder from event timestamps (the
 * package has no per-event history, so it's an approximation).
 */
export function computeAchievements(m: MetricInput): Achievement[] {
  return COMPLETION_SPECS.map((spec) => {
    const earned = spec.test(m);
    return {
      id: spec.id,
      category: 'completion' as const,
      icon: spec.icon,
      // title/desc are resolved via i18n in the UI; keep the id as the key.
      title: spec.id,
      desc: spec.id,
      earned,
      tier: earned ? ('gold' as const) : null,
      earnedAt: null,
    };
  });
}
