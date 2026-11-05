import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (_: Request, handle: (p: unknown, h: Headers) => Promise<Response>) =>
    handle({ ownerId: 'authenticated-learner' }, new Headers()),
}));
vi.mock('@/lib/server/pbl-v3/store', () => ({
  LearningStore: { open: async () => ({ completeOnboarding: mocks.complete }) },
}));
import { POST } from '@/app/api/pbl/v3/onboarding/route';
import { SandboxError } from '@/lib/sandbox/errors';
const request = (body: unknown, header = '1') =>
  new Request('http://localhost/api/pbl/v3/onboarding', {
    method: 'POST',
    headers: {
      'x-openmaic-sandbox': header,
      'content-type': 'application/json',
      origin: 'http://localhost',
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  mocks.complete.mockReset();
});
it('records completion for the authenticated owner, ignoring a forged body owner', async () => {
  const response = await POST(request({ studyId: 'study', ownerId: 'someone-else' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ onboardingCompleted: true });
  expect(mocks.complete).toHaveBeenCalledWith('study', 'authenticated-learner');
});
it('rejects invalid requests before writing completion', async () => {
  expect((await POST(request({ studyId: '' }))).status).toBe(400);
  expect((await POST(request({ studyId: 'study' }, ''))).status).toBe(403);
  expect(mocks.complete).not.toHaveBeenCalled();
});
it('does not acknowledge another owner’s inaccessible study or an unconfirmed write', async () => {
  mocks.complete.mockRejectedValueOnce(new SandboxError('SANDBOX_NOT_FOUND', 404, 'Unavailable'));
  expect((await POST(request({ studyId: 'foreign-study' }))).status).toBe(404);
  mocks.complete.mockRejectedValueOnce(Error('Unavailable'));
  const response = await POST(request({ studyId: 'study' }));
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty('onboardingCompleted');
});
