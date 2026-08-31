import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  deleteOwnedSessionWithMaterials: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('@/lib/server/agent-runtime/session-materials', () => ({
  deleteOwnedSessionWithMaterials: mocks.deleteOwnedSessionWithMaterials,
}));

import { deleteWorkspaceSession } from '@/lib/workbench/workspace-actions';

describe('workspace session deletion lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue({
      get: () => ({ value: '00000000-0000-4000-8000-000000000001' }),
      set: vi.fn(),
    });
    mocks.deleteOwnedSessionWithMaterials.mockResolvedValue(true);
  });

  it('uses the owner-bound material cleanup path', async () => {
    await expect(deleteWorkspaceSession(' session-a ')).resolves.toEqual({ deleted: true });
    expect(mocks.deleteOwnedSessionWithMaterials).toHaveBeenCalledWith(
      'session-a',
      'anon:00000000-0000-4000-8000-000000000001',
    );
  });

  it('does not resolve an owner for an empty session id', async () => {
    await expect(deleteWorkspaceSession(' ')).resolves.toEqual({ deleted: false });
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.deleteOwnedSessionWithMaterials).not.toHaveBeenCalled();
  });
});
