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
import { openStudy } from '@/lib/server/pbl-v3/runtime';
import { SandboxStore } from '@/lib/server/sandbox/store';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('refuses an anonymous study before creating any durable PBL or sandbox ownership', async () => {
  vi.stubEnv('OWNER_SINGLE_USER', 'false');
  vi.stubEnv('OWNER_SINGLE_USER_ID', '');
  mocks.find.mockResolvedValue(null);
  await expect(
    openStudy(
      {
        ownerId: 'anonymous-a',
        kind: 'anonymous',
        assurance: 'verified',
        roles: new Set(['sandbox:use']),
      },
      'classroom',
      'scene',
    ),
  ).rejects.toMatchObject({ code: 'SANDBOX_FORBIDDEN' });
  // Owner-scoped lookup is read-only; execution denial must precede any new ownership.
  expect(mocks.find).toHaveBeenCalledWith('anonymous-a', 'classroom', 'scene');
  expect(mocks.create).not.toHaveBeenCalled();
  expect(SandboxStore.open).not.toHaveBeenCalled();
  expect(getOwnerScopedDocumentStore).not.toHaveBeenCalled();
});

it('allows owned final review after execution entitlement is removed without creating ownership', async () => {
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
