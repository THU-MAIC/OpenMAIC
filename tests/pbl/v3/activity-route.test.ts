import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const calls = vi.hoisted(() => ({
  recordActivity: vi.fn(async () => {}),
  waitForExclusive: vi.fn(async () => {
    throw new Error('Study mutex is occupied by a long teaching tool.');
  }),
}));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (
    _: Request,
    handle: (principal: unknown, headers: Headers) => Promise<Response>,
  ) => handle({ ownerId: 'learner' }, new Headers()),
}));
vi.mock('@/lib/server/sandbox/service', () => ({ SandboxService: { forOwner: async () => ({}) } }));
vi.mock('@/lib/server/pbl-v3/store', () => ({
  LearningStore: {
    open: async () => ({
      findForScene: async () => ({ id: 'study' }),
      ...calls,
    }),
  },
}));
import { POST } from '@/app/api/pbl/v3/activity/route';

it('records returning-user activity even when teaching holds the Study mutex', async () => {
  const response = await POST(
    new Request('http://localhost/api/pbl/v3/activity', {
      method: 'POST',
      headers: {
        'x-openmaic-sandbox': '1',
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ stageId: 'course', sceneId: 'project' }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ recorded: true });
  expect(calls.recordActivity).toHaveBeenCalledWith('study', 'learner');
});
