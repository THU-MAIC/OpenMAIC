import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { abortable } from '@/lib/server/agent-runtime/abortable';
import { SandboxError } from '@/lib/sandbox/errors';

export type WorkspaceMutation =
  | 'create'
  | 'write'
  | 'command'
  | 'terminal'
  | 'desktop'
  | 'checkpoint'
  | 'restore'
  | 'destroy'
  | 'delegate'
  | 'preview';

interface WorkspaceAccess {
  ownerId: string;
  workspaceId: string;
  environmentIds: () => readonly (string | null | undefined)[];
  operations: readonly WorkspaceMutation[];
  signal?: AbortSignal;
}
const access = new AsyncLocalStorage<WorkspaceAccess & { active: boolean }>();

export function learningWorkspaceId(studyId: string) {
  return `pbl-${studyId}`;
}

/** The PBL allocator owns this namespace, including not-yet-created and retired environments. */
export function isLearningWorkspace(workspaceId: string) {
  return /^pbl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(workspaceId);
}

/** Server-only scope. Use inside the learning lock after ownership checks. Terminal input is also allowed under the environment lock with a fresh study/permission check before provider dispatch; it never changes learning state. Validate actions/roles before mutation.
 * The sandbox service still checks owner/resource bindings. This grants no caller identity.
 * A scope cannot leak to detached work after the awaited operation completes.
 */
export async function withLearningWorkspaceAccess<T>(
  scope: WorkspaceAccess,
  run: () => Promise<T>,
) {
  const current = { ...scope, active: true };
  return access.run(current, async () => {
    try {
      return await (scope.signal ? abortable(run(), scope.signal) : run());
    } finally {
      current.active = false;
    }
  });
}

export function assertWorkspaceMutation(
  ownerId: string,
  workspaceId: string,
  environmentId: string | null,
  operation: WorkspaceMutation,
) {
  if (!isLearningWorkspace(workspaceId)) return;
  const current = access.getStore();
  if (
    current?.active &&
    !current.signal?.aborted &&
    current.ownerId === ownerId &&
    current.workspaceId === workspaceId &&
    environmentId !== null &&
    current.environmentIds().includes(environmentId) &&
    current.operations.includes(operation)
  )
    return;
  throw new SandboxError(
    'PBL_WORKSPACE_MANAGED',
    409,
    'This workspace is managed by a learning project. Use the learning workspace controls.',
  );
}
