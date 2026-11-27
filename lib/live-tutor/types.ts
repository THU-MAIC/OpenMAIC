export type LearningMode = 'theory-then-solve' | 'solve-only';

export interface TheorySlide {
  id: string;
  title: string;
  summary: string;
  keyPoints: string[];
  formulaLatex?: string;
  workedExample?: {
    problem: string;
    steps: string[];
  };
}

export interface PracticeProblem {
  statement: string;
  hint?: string;
  targetConcept?: string;
  formulaLatex?: string;
}

export interface HelpMeLearnPlan {
  topic: string;
  mode: LearningMode;
  slides: TheorySlide[];
  problem: PracticeProblem;
}

export interface WhiteboardStepItem {
  id: string;
  kind: 'heading' | 'text' | 'latex';
  content: string;
  color?: string;
}

export type WhiteboardOp =
  | { op: 'add_heading'; content: string }
  | { op: 'add_step'; content: string }
  | { op: 'add_formula'; content: string }
  | { op: 'clear' };

export type LiveTutorSessionResponse =
  | {
      mode: 'gemini-live';
      wsUrl: string;
      model: string;
      expiresAt: string;
    }
  | {
      mode: 'turn-based';
      providerId: string;
      modelId: string;
    };
