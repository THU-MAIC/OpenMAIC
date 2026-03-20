export type InterviewType = 'technical' | 'hr' | 'both';
export type InterviewRole = 'software-engineer' | 'data-analyst' | 'product-manager' | 'general';
export type InterviewDifficulty = 'fresher' | '2-3-years' | 'senior';

export interface InterviewConfig {
  interviewType: InterviewType;
  role: InterviewRole;
  difficulty: InterviewDifficulty;
  language: string;
}

export interface InterviewTurn {
  id: string;
  question: string;
  answer?: string;
  feedback?: {
    good: string[];
    missing: string[];
    strongAnswer: string;
  };
}

export interface InterviewSessionSummary {
  overallScore: number;
  communicationRating: number;
  technicalAccuracyRating: number;
  topImprovements: string[];
  summary: string;
}

export interface InterviewHistoryItem {
  id: string;
  config: InterviewConfig;
  createdAt: number;
  summary: InterviewSessionSummary;
}
