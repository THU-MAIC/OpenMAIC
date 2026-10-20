import type { SandboxCommandResult, SandboxTerminal } from '@/lib/sandbox/types';
export interface LearningWorkbench {
  environmentId: string;
  revision: number;
  epoch: number;
  canEdit: boolean;
  canManageFiles: boolean;
  canRun: boolean;
  planning: boolean;
  ports: number[];
  commands: SandboxCommandResult[];
  terminals: SandboxTerminal[];
  checkpoint: { revision: number; createdAt: string } | null;
}
