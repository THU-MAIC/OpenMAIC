// Completion achievements — fixed-threshold badges computed from a single
// learner's own local metrics. Pure & synchronous (no server, no db).
//
// Tailored to what OpenMAIC actually is: a multi-agent interactive classroom
// where you author/generate courses made of slide / quiz / interactive / pbl
// scenes and hold qa / lecture / discussion chat sessions. Badges span four
// groups (course · quiz · chat · explore) so the grid and star-map read rich.
// The cohort-ranked "competition" medals and rarity from the original platform
// are dropped: single-device data has no cohort to rank against.

import type { Achievement, AchGroup } from './types';

export interface MetricInput {
  stageCount: number;
  startedStageCount: number;
  completedStageCountProxy: number;
  totalSceneCount: number;
  slideSceneCount: number;
  quizSceneCount: number;
  pblSceneCount: number;
  interactiveSceneCount: number;
  quizAttemptCount: number;
  perfectQuizAttemptCount: number;
  avgQuizScoreRatio: number | null;
  chatSessionCount: number;
  qaSessionCount: number;
  lectureSessionCount: number;
  discussionSessionCount: number;
  totalChatMessageCount: number;
}

interface CompletionSpec {
  id: string;
  group: AchGroup;
  icon: Achievement['icon'];
  test: (m: MetricInput) => boolean;
}

// Order here is the display order. `test` thresholds are single-user.
export const COMPLETION_SPECS: CompletionSpec[] = [
  // ── 课程 course ──
  { id: 'start', group: 'course', icon: 'progress', test: (m) => m.startedStageCount >= 1 },
  { id: 'create3', group: 'course', icon: 'create', test: (m) => m.stageCount >= 3 },
  { id: 'content100', group: 'course', icon: 'create', test: (m) => m.totalSceneCount >= 100 },
  {
    id: 'finish1',
    group: 'course',
    icon: 'progress',
    test: (m) => m.completedStageCountProxy >= 1,
  },
  {
    id: 'finish3',
    group: 'course',
    icon: 'progress',
    test: (m) => m.stageCount > 0 && m.completedStageCountProxy / m.stageCount >= 0.8,
  },
  {
    id: 'finishAll',
    group: 'course',
    icon: 'progress',
    test: (m) => m.stageCount >= 3 && m.completedStageCountProxy === m.stageCount,
  },
  // ── 测验 quiz ──
  { id: 'quiz1', group: 'quiz', icon: 'quiz', test: (m) => m.quizAttemptCount >= 1 },
  { id: 'quiz10', group: 'quiz', icon: 'quiz', test: (m) => m.quizAttemptCount >= 10 },
  { id: 'perfect', group: 'quiz', icon: 'quiz', test: (m) => m.perfectQuizAttemptCount >= 1 },
  { id: 'perfect3', group: 'quiz', icon: 'quiz', test: (m) => m.perfectQuizAttemptCount >= 3 },
  { id: 'quiz80', group: 'quiz', icon: 'quiz', test: (m) => (m.avgQuizScoreRatio ?? 0) >= 0.8 },
  // ── 对话 chat ──
  { id: 'chat1', group: 'chat', icon: 'chat', test: (m) => m.chatSessionCount >= 1 },
  { id: 'chat20', group: 'chat', icon: 'chat', test: (m) => m.chatSessionCount >= 20 },
  { id: 'qa10', group: 'chat', icon: 'chat', test: (m) => m.qaSessionCount >= 10 },
  { id: 'lecture5', group: 'chat', icon: 'chat', test: (m) => m.lectureSessionCount >= 5 },
  { id: 'discussion3', group: 'chat', icon: 'chat', test: (m) => m.discussionSessionCount >= 3 },
  { id: 'msg100', group: 'chat', icon: 'chat', test: (m) => m.totalChatMessageCount >= 100 },
  { id: 'msg500', group: 'chat', icon: 'chat', test: (m) => m.totalChatMessageCount >= 500 },
  // ── 探索 explore ──
  { id: 'pbl1', group: 'explore', icon: 'explore', test: (m) => m.pblSceneCount >= 1 },
  {
    id: 'interactive1',
    group: 'explore',
    icon: 'explore',
    test: (m) => m.interactiveSceneCount >= 1,
  },
  {
    id: 'multimodal',
    group: 'explore',
    icon: 'explore',
    test: (m) =>
      m.slideSceneCount > 0 &&
      m.quizSceneCount > 0 &&
      m.pblSceneCount > 0 &&
      m.interactiveSceneCount > 0,
  },
];

/** The four star-map branches, in display order. */
export const ACH_GROUPS: AchGroup[] = ['course', 'quiz', 'chat', 'explore'];

// Progression chains ("承接关系"): each inner array is an ordered chain where a
// later badge builds on the earlier one (Lv.1 → Lv.2 → …). Thresholds are
// monotonic, so earning a higher level implies the lower ones. The star-map
// nests each chain as a spoke and the grid shows it as a progression row.
export const ACH_CHAINS: Record<AchGroup, string[][]> = {
  course: [
    ['start', 'finish1', 'finish3', 'finishAll'],
    ['create3', 'content100'],
  ],
  quiz: [['quiz1', 'quiz10'], ['perfect', 'perfect3'], ['quiz80']],
  chat: [['chat1', 'chat20'], ['msg100', 'msg500'], ['qa10'], ['lecture5'], ['discussion3']],
  explore: [['interactive1'], ['pbl1', 'multimodal']],
};

// id → 1-based level within its chain.
const LEVEL_BY_ID: Record<string, number> = {};
for (const chains of Object.values(ACH_CHAINS)) {
  for (const chain of chains) {
    chain.forEach((id, i) => {
      LEVEL_BY_ID[id] = i + 1;
    });
  }
}

/**
 * Compute completion achievements for the current learner. `earnedAt` is left
 * null here and filled in by the report builder from event timestamps.
 */
export function computeAchievements(m: MetricInput): Achievement[] {
  return COMPLETION_SPECS.map((spec) => {
    const earned = spec.test(m);
    return {
      id: spec.id,
      category: 'completion' as const,
      group: spec.group,
      icon: spec.icon,
      level: LEVEL_BY_ID[spec.id] ?? 1,
      // title/desc are resolved via i18n in the UI; keep the id as the key.
      title: spec.id,
      desc: spec.id,
      earned,
      tier: earned ? ('gold' as const) : null,
      earnedAt: null,
    };
  });
}
