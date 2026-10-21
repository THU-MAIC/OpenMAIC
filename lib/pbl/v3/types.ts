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
  role: AgentRole | null;
  actions: string[];
  files: string[];
  busy: boolean;
  messages: { role: 'user' | 'assistant'; text: string }[];
  roleRun: {
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'missing';
    failure: 'authentication' | 'timeout' | 'unavailable' | null;
    canRetry: boolean;
  } | null;
  decisions: { id: string; prompt: string; options: { id: string; label: string }[] }[];
  questions: { q: string; options: string[] }[];
  evaluation: { id: string; state: string; stdout: string; stderr: string } | null;
}
