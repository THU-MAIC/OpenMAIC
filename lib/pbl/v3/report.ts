/** Owner-scoped, saved project report. Public evidence never contains course protocols or answer keys. */
export interface LearningReport {
  formatVersion?: number;
  responseLocale?: string;
  studyId: string;
  project: { id: string; version: string; title: string };
  revision: number;
  requiredComplete: boolean;
  milestones: { id: string; title: string; optional: boolean; status: string; stages: string[] }[];
  outcomes?: {
    milestoneId: string;
    tests: string | null;
    quiz: { score: number; total: number; attempt: number } | null;
    reflected: boolean;
  }[];
  counts: Record<string, number>;
  evidence: {
    sequence: number;
    at: number;
    milestoneId?: string;
    kind: string;
    detail: string;
    /** Retained literal learner input only; excludes course prompts and option labels. */
    learnerText?: { answer: string; rationale?: string };
    /** Separately bounded authored context; never learner quote evidence. */
    decisionContext?: { question: string; answerLabel: string };
    version?: string;
    truncated?: boolean;
  }[];
  conversations: {
    role: string;
    milestone: string;
    messages: { sequence: number; at: number; role: 'user' | 'assistant'; text: string }[];
    truncated: boolean;
  }[];
  truncated: boolean;
  facts?: {
    learnerTurns: number;
    assistantTurns: number;
    decisions: number;
    decisionChanges: number;
    testRuns: number;
    quizAttempts: number;
    fileEdits: number;
    interruptedRuns: number;
  };
  summary?: {
    completedMilestones: number;
    totalMilestones: number;
    completedSteps: number;
    totalSteps: number;
    /** Authored concepts practiced in completed milestones, never a mastery score. */
    concepts: string[];
    skills: {
      id: 'decisions' | 'planReview' | 'codeReview' | 'verification' | 'reflection';
      milestoneIds: string[];
    }[];
  };
  analysis?: {
    status: 'not_generated' | 'generating' | 'ready' | 'failed';
    generatedAt?: string;
    findings: ReportFinding[];
    omitted: boolean;
    canRetry: boolean;
  };
}

/** Bound report text in UTF-16 units without cutting a valid surrogate pair. */
export function reportTextExcerpt(text: string, limit: number): string {
  let end = Math.min(text.length, Math.max(0, Math.floor(limit)));
  const before = text.charCodeAt(end - 1),
    after = text.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  return text.slice(0, end);
}

/** Keep citation IDs tied to their retained source while interleaving shared mentor and milestone roles. */
export function reportConversationMessages(report: LearningReport) {
  return report.conversations
    .flatMap((c, i) =>
      c.messages.map((m) => ({
        id: `turn:${i}:${m.sequence}`,
        at: m.at,
        milestone: c.milestone,
        role: m.role === 'user' ? 'learner' : c.role,
        text: m.text,
      })),
    )
    .sort((a, b) => a.at - b.at);
}
export interface ReportFinding {
  category: 'journey' | 'strength' | 'change' | 'collaboration' | 'next';
  title: string;
  detail: string;
  evidence: string[];
  quote?: string;
}
