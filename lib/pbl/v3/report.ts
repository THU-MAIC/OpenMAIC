/** Student-safe report projection; never contains answer keys or provider diagnostics. */
export interface LearningReport {
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
    milestoneId?: string;
    kind: string;
    detail: string;
    version?: string;
  }[];
  conversations: {
    role: string;
    milestone: string;
    messages: { sequence: number; role: 'user' | 'assistant'; text: string }[];
    truncated: boolean;
  }[];
  truncated: boolean;
}
