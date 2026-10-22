import type { PblSessionState } from './domain/orchestration/types';
import type { AgentRole, StageDefinition } from './domain/project/project-schema';

export { isPBLV3Reference } from '@openmaic/dsl';
export type { PBLV3Reference } from '@openmaic/dsl';
export interface LearningView {
  id: string;
  revision: number;
  title: string;
  environmentId: string | null;
  environment: { state: import('@/lib/sandbox/types').SandboxState; ready: boolean } | null;
  recovery: { checkpointRevision: number; progressReset: boolean } | null;
  state: PblSessionState;
  stage: StageDefinition;
  milestones?: { id: string; title: string; optional: boolean; stages: string[] }[];
  role: AgentRole | null;
  actions: string[];
  files: string[];
  busy: boolean;
  conversation?: import('./conversation').LearningConversationEntry[];
  activitySequence?: number;
  task?: { title: string; goal: string };
  messages: { role: 'user' | 'assistant'; text: string }[];
  needsOpening?: boolean;
  roleRun: {
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'missing';
    failure: import('./conversation').LearningRunFailure | null;
    canRetry: boolean;
  } | null;
  decisions: { id: string; prompt: string; options: { id: string; label: string }[] }[];
  decisionSummary?: { id: string; prompt: string; choice: string }[];
  questions: { q: string; options: string[] }[];
  evaluation: { id: string; state: string; stdout: string; stderr: string } | null;
}
