import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ remove: vi.fn(async () => true) }));
vi.mock('@/lib/server/identity/resolve', () => ({
  requireContextOwner: async () => ({ ownerId: 'owner-a' }),
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({ softDeleteSession: mocks.remove }),
}));
import { deleteWorkspaceSession } from '@/lib/workbench/workspace-actions';
beforeEach(() => vi.clearAllMocks());
it('refuses deletion of internal teaching sessions on the server', async () => {
  expect(await deleteWorkspaceSession('pbl-role-internal')).toEqual({ deleted: false });
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('preserves owner-scoped deletion of ordinary chats', async () => {
  expect(await deleteWorkspaceSession('chat-a')).toEqual({ deleted: true });
  expect(mocks.remove).toHaveBeenCalledWith('chat-a', 'owner-a');
});
