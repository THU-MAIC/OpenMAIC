// View-model types for the learning report. Single-user (this browser's local
// data), so there is no cohort/ranking dimension — every metric is derived from
// the current device's IndexedDB (stages/scenes/chats) + localStorage (quiz).
//
// Ported and trimmed from the standalone report platform's report-data.ts:
// dropped the feedback[] channel (OpenMAIC has no like/dislike feedback locally)
// and all cohort fields (rank, earnedBy, rarity).

export type AchTier = 'gold' | null;

export interface Achievement {
  id: string;
  category: 'completion';
  icon: 'progress' | 'quiz' | 'chat';
  title: string;
  desc: string;
  earned: boolean;
  tier: AchTier;
  /** First-completion time (ms), approximated from available timestamps; null if unearned. */
  earnedAt: number | null;
}

export interface StageVM {
  stageId: string;
  name: string;
  sceneCount: number;
  quizSceneCount: number;
  pblSceneCount: number;
  interactiveSceneCount: number;
  currentScenePosition: number | null;
  progressRatio: number | null;
  started: boolean;
  quizSubmissionCount: number;
  avgQuizScoreRatio: number | null;
  chatSessionCount: number;
  qaSessionCount: number;
  lectureSessionCount: number;
  totalMessageCount: number;
  updatedAt: number | null;
}

export interface QuizVM {
  stageId: string;
  stageName: string;
  sceneId: string;
  score: number;
  totalPoints: number;
  scoreRatio: number;
  /** Quiz submissions carry no local timestamp; approximated from the stage's updatedAt. */
  submittedAt: number | null;
}

export interface ChatVM {
  stageId: string;
  stageName: string;
  qa: number;
  lecture: number;
  discussion: number;
  completed: number;
  active: number;
  interrupted: number;
  total: number;
  messages: number;
}

export interface ReportMetric {
  stageCount: number;
  startedStageCount: number;
  completedStageCountProxy: number;
  avgProgressRatio: number | null;
  maxProgressRatio: number | null;
  quizAttemptCount: number;
  quizStageCount: number;
  avgQuizScoreRatio: number | null;
  bestQuizScoreRatio: number | null;
  perfectQuizAttemptCount: number;
  chatSessionCount: number;
  qaSessionCount: number;
  lectureSessionCount: number;
  totalChatMessageCount: number;
  lastActivityAt: number | null;
}

export interface LearnerReport {
  metric: ReportMetric;
  stages: StageVM[];
  quiz: QuizVM[];
  chat: ChatVM[];
  achievements: Achievement[];
  /** True when the device holds no stages yet (drives the empty state). */
  isEmpty: boolean;
}
