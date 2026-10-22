import type { AgentRole } from './domain/project/project-schema';

export type LearningRunFailure = 'authentication' | 'timeout' | 'incomplete' | 'unavailable';

/** Learner-owned conversation, with explicit display fields rather than raw runner payloads. */
export interface LearningConversationEntry {
  id: string;
  at?: number;
  status?: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  failure?: LearningRunFailure;
  speaker: 'user' | AgentRole;
  boundary?: {
    milestoneId: string;
    milestoneTitle: string;
    milestoneIndex: number;
    stageIndex: number;
    step: string;
    total: number;
  };
  parts: (
    | { kind: 'text'; id: string; text: string; streaming?: boolean }
    | {
        kind: 'thinking';
        id: string;
        text: string;
        streaming?: boolean;
        startedAt?: number;
        endedAt?: number;
      }
    | {
        kind: 'tool';
        id: string;
        action:
          | 'read'
          | 'write'
          | 'build'
          | 'collect'
          | 'review'
          | 'complete'
          | 'list'
          | 'manage'
          | 'skill';
        name?: string;
        args?: Record<string, string>;
        result?: string;
        startedAt?: number;
        endedAt?: number;
        status: 'running' | 'succeeded' | 'failed' | 'interrupted';
      }
  )[];
}
