import type { QuizQuestion } from '@/lib/types/stage';

export type QuizAnswerMap = Record<string, string | string[]>;

export interface QuizQuestionResult {
  questionId: string;
  correct: boolean | null;
  status: 'correct' | 'incorrect';
  earned: number;
  aiComment?: string;
}

export interface AssessmentContext {
  attemptId: string;
  stageId: string;
  sceneId: string;
  latestQuizScore: number;
  maxScore: number;
  incorrectQuestions: string[];
  weakConcepts: string[];
  masteryLevel: 'high' | 'medium' | 'low';
  recommendedNextStep: 'advance' | 'review' | 'remediate';
  submittedAt: number;
}

export interface QuizAttempt {
  attemptId: string;
  stageId: string;
  sceneId: string;
  answers: QuizAnswerMap;
  results: QuizQuestionResult[];
  totalScore: number;
  maxScore: number;
  questions?: QuizQuestion[];
  assessmentContext: AssessmentContext;
  submittedAt: number;
}
