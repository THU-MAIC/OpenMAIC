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
  /** A periodic attempt that ran beside an application; quiescing it may clear the cause. */
  besideApplication?: boolean;
}
export interface ArchiveDiscard {
  environmentId: string;
  at: string;
  checkpointRevision: number;
  checkpointAt: string | null;
  reason: ArchiveFailure['reason'];
}
export interface LearningView {
  /** Server-owned learner-wide V3 guide receipt, including prior V3 learning progress. */
  onboardingCompleted?: boolean;
  id: string;
  revision: number;
  title: string;
  application?: {
    title: string;
    description: string;
    standaloneFrontend?: true;
    choices?: { id: string; label: string; choice: string }[];
  };
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
  milestones?: {
    id: string;
    title: string;
    goal?: string;
    outcome?: string;
    concepts?: string[];
    deliverables?: string[];
    optional: boolean;
    stages: string[];
  }[];
  role: AgentRole | null;
  /** The deployment lets the learner start this project over (a testing aid). */
  canReset?: boolean;
  /**
   * The current stage's explanation board. Present only when the deployment teaches with a
   * board; the workbench then shows the role as a companion beside it.
   */
  explainBoard?: {
    whiteboard: import('@openmaic/dsl').Whiteboard | null;
    lastSeq: number | null;
    /** Oldest first, excluding the current board's latest state; at most 24 pages. */
    pages?: {
      id: string;
      milestoneIndex: number;
      stageIndex: number;
      step: string;
      whiteboard: import('@openmaic/dsl').Whiteboard;
    }[];
  };
  actions: string[];
  files: string[];
  busy: boolean;
  conversation?: import('./conversation').LearningConversationEntry[];
  conversationHistory?: {
    sessionId: string;
    through: number;
    role: AgentRole;
    milestoneId?: string;
  }[];
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
    responseLabel?: string;
    requiresRationale?: boolean;
    rationaleLabel?: string;
    options: { id: string; label: string }[];
  }[];
  decisionSummary?: { id: string; prompt: string; choice: string; rationale?: string }[];
  questions: {
    q: string;
    options: string[];
    feedback?: {
      passed: boolean;
      selectedAnswer?: number;
      explanation?: string;
    };
  }[];
  evaluation: {
    id: string;
    state: string;
    stdout: string;
    stderr: string;
    purpose?: 'compile';
    isolatedSources?: true;
  } | null;
}
