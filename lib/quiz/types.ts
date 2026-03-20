export type QuizTrack = 'placement-aptitude' | 'coding-examination';
export type PlacementTopic = 'quant' | 'logical' | 'verbal' | 'data-interpretation';
export type CodingTopic =
  | 'arrays'
  | 'strings'
  | 'trees'
  | 'graphs'
  | 'dynamic-programming'
  | 'sorting'
  | 'complexity'
  | 'output-prediction'
  | 'debugging'
  | 'fill-in-the-blank';

export type PlacementDifficulty = 'easy' | 'medium' | 'hard';
export type CodingDifficulty = 'easy' | 'medium' | 'hard';
export type CodingLanguage = 'python' | 'java' | 'cpp' | 'javascript';

export interface PlacementQuestion {
  id: string;
  type: 'mcq';
  topic: PlacementTopic;
  difficulty: PlacementDifficulty;
  question: string;
  options: Array<{ id: string; text: string }>;
  correctAnswer: string;
  explanation: string;
}

export interface CodingProblem {
  id: string;
  type: 'coding';
  title: string;
  topic: CodingTopic;
  difficulty: CodingDifficulty;
  prompt: string;
  inputFormat?: string;
  outputFormat?: string;
  constraints?: string[];
  examples: Array<{ input: string; output: string; explanation?: string }>;
  hints?: string[];
  starterCode: string;
}

export interface PlacementQuizSession {
  track: 'placement-aptitude';
  title: string;
  company: 'TCS' | 'Infosys' | 'Wipro' | 'Cognizant' | 'Accenture' | 'General';
  difficulty: PlacementDifficulty;
  durationMinutes: 30;
  questions: PlacementQuestion[];
}

export interface CodingQuizSession {
  track: 'coding-examination';
  title: string;
  language: CodingLanguage;
  difficulty: CodingDifficulty;
  durationMinutes: 60;
  problems: CodingProblem[];
}

export type QuizSession = PlacementQuizSession | CodingQuizSession;

export interface QuizHistoryItem {
  id: string;
  track: QuizTrack;
  title: string;
  score: number;
  total: number;
  percentage: number;
  weakAreas: string[];
  createdAt: number;
  metadata?: Record<string, string | number | string[]>;
}

export interface WeakAreaSummary {
  area: string;
  misses: number;
  attempts: number;
}

export interface PlacementDebrief {
  summary: string;
  revisionTopics: string[];
  percentileEstimate: string;
}

export interface CodeReviewResult {
  summary: string;
  strengths: string[];
  missingPoints: string[];
  optimalApproach: string;
  timeComplexity: string;
  spaceComplexity: string;
  cleanerVersion?: string;
}
