import type { EditBlockReason } from './edit-access';
import type { SandboxCommandResult, SandboxTerminal } from '@/lib/sandbox/types';
export interface LearningWorkbench {
  environmentId: string;
  revision: number;
  epoch: number;
  canEdit: boolean;
  editReason?: EditBlockReason | null;
  canManageFiles: boolean;
  canRun: boolean;
  planning: boolean;
  commands: SandboxCommandResult[];
  terminals: SandboxTerminal[];
}
