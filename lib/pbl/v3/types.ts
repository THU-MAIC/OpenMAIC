import type { PblSessionState } from './domain/orchestration/types';
import type { AgentRole, StageDefinition } from './domain/project/project-schema';

export { isPBLV3Reference } from '@openmaic/dsl';
export type { PBLV3Reference } from '@openmaic/dsl';
export interface ArchiveFailure {
  environmentId: string;
  reason: import('@/lib/server/sandbox/checkpoint-errors').CheckpointFailureReason;
  stage: import('@/lib/server/sandbox/checkpoint-errors').CheckpointStage;
  retryable: boolean;
  firstIdleFailureAt: string | null;
  dirtyAt: string | null;
}
export interface ArchiveDiscard {
  environmentId: string;
  at: string;
  checkpointRevision: number;
  checkpointAt: string | null;
  reason: ArchiveFailure['reason'];
}
export interface LearningView {
  id: string;
  revision: number;
  title: string;
  reportAvailable: boolean;
  completedFilesAvailable?: boolean;
  lifecycleError?: string | null;
  checkpointFailure?: ArchiveFailure | null;
  archiveDiscard?: ArchiveDiscard | null;
  environmentId: string | null;
  environment: {
    state: import('@/lib/sandbox/types').SandboxState;
    ready: boolean;
    releasing?: boolean;
  } | null;
  recovery: { checkpointRevision: number; progressReset: boolean } | null;
  state: PblSessionState;
  stage: StageDefinition;
  milestones?: { id: string; title: string; optional: boolean; stages: string[] }[];
  role: AgentRole | null;
  actions: string[];
  files: string[];
  busy: boolean;
  conversation?: import('./conversation').LearningConversationEntry[];
  conversationHistory?: { sessionId: string; through: number; role: AgentRole }[];
  activitySequence?: number;
  task?: { title: string; goal: string };
  messages: { role: 'user' | 'assistant'; text: string }[];
  needsOpening?: boolean;
  roleRun: {
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'missing';
    failure: import('./conversation').LearningRunFailure | null;
    failureCode?: import('@/lib/agent/runtime/request-failure').ExecutionFailureCode | null;
    canRetry: boolean;
  } | null;
  decisions: {
    id: string;
    prompt: string;
    responseType?: 'choice' | 'text';
    requiresRationale?: boolean;
    options: { id: string; label: string }[];
  }[];
  decisionSummary?: { id: string; prompt: string; choice: string; rationale?: string }[];
  questions: { q: string; options: string[] }[];
  evaluation: {
    id: string;
    state: string;
    stdout: string;
    stderr: string;
    purpose?: 'compile';
  } | null;
}
