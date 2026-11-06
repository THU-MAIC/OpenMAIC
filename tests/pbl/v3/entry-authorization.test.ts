import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn() }));
vi.mock('@/lib/server/sandbox/settings', () => ({ resolvedSandboxConfig: vi.fn() }));
vi.mock('@/lib/server/sandbox/store', () => ({ SandboxStore: { open: vi.fn() } }));
vi.mock('@/lib/server/pbl-v3/store', () => ({
  LearningStore: { open: vi.fn(async () => ({ findForScene: mocks.find, create: mocks.create })) },
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: vi.fn(),
}));
vi.mock('@/lib/server/sandbox/providers/e2b-compatible', () => ({
  E2BCompatibleSandboxProvider: class {},
}));
import { openStudy } from '@/lib/server/pbl-v3/runtime';
import { SandboxStore } from '@/lib/server/sandbox/store';
import { resolvedSandboxConfig } from '@/lib/server/sandbox/settings';
import { SandboxError } from '@/lib/sandbox/errors';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const anonymous = {
  ownerId: 'anonymous-a',
  kind: 'anonymous' as const,
  assurance: 'unverified-legacy' as const,
  roles: new Set<string>(),
};
it('refuses a new study while sandboxes are disabled, before creating any ownership', async () => {
  vi.mocked(resolvedSandboxConfig).mockRejectedValue(
    new SandboxError('SANDBOX_DISABLED', 503, 'Sandbox provider is not configured.'),
  );
  mocks.find.mockResolvedValue(null);
  await expect(openStudy(anonymous, 'classroom', 'scene')).rejects.toMatchObject({
    code: 'SANDBOX_DISABLED',
  });
  // Owner-scoped lookup is read-only; execution denial must precede any new ownership.
  expect(mocks.find).toHaveBeenCalledWith('anonymous-a', 'classroom', 'scene');
  expect(mocks.create).not.toHaveBeenCalled();
  expect(getOwnerScopedDocumentStore).not.toHaveBeenCalled();
});

it.each([
  ['anonymous', anonymous],
  ['shared', { ...anonymous, ownerId: 'team', kind: 'shared' as const }],
  ['role-less user', { ...anonymous, ownerId: 'learner', kind: 'user' as const }],
])('lets a %s owner start a study once sandboxes are enabled', async (_, principal) => {
  vi.mocked(resolvedSandboxConfig).mockResolvedValue({} as never);
  vi.mocked(SandboxStore.open).mockResolvedValue({} as never);
  vi.mocked(getOwnerScopedDocumentStore).mockResolvedValue({
    getScene: vi.fn(async () => null),
  } as never);
  mocks.find.mockResolvedValue(null);
  // Past the sandbox gate the study reads the owner's own classroom; this one has no project.
  await expect(openStudy(principal, 'classroom', 'scene')).rejects.toMatchObject({
    code: 'PBL_NOT_FOUND',
  });
  expect(mocks.find).toHaveBeenCalledWith(principal.ownerId, 'classroom', 'scene');
  expect(getOwnerScopedDocumentStore).toHaveBeenCalledWith(principal);
  expect(mocks.create).not.toHaveBeenCalled();
});

it('allows owned final review without consulting the sandbox or creating ownership', async () => {
  vi.stubEnv('OWNER_SINGLE_USER', 'false');
  const completed = { id: 'completed-study', state: { status: 'completed' } };
  mocks.find.mockResolvedValue(completed);
  expect(
    await openStudy(
      {
        ownerId: 'former-learner',
        kind: 'user',
        assurance: 'verified',
        roles: new Set(),
      },
      'classroom',
      'scene',
    ),
  ).toBe(completed);
  expect(mocks.find).toHaveBeenCalledWith('former-learner', 'classroom', 'scene');
  expect(mocks.create).not.toHaveBeenCalled();
  expect(SandboxStore.open).not.toHaveBeenCalled();
  expect(getOwnerScopedDocumentStore).not.toHaveBeenCalled();
});
