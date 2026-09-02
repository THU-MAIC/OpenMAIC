import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  class UserSkillError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    withRequestOwnerId: vi.fn(),
    findUserSkill: vi.fn(),
    deleteUserSkill: vi.fn(),
    UserSkillError,
  };
});
vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => true,
  isAgentRuntimeConfigured: () => true,
}));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/user-skills', () => ({
  findUserSkill: mocks.findUserSkill,
  deleteUserSkill: mocks.deleteUserSkill,
  UserSkillError: mocks.UserSkillError,
}));

import { DELETE, GET } from '@/app/api/agent/skills/[id]/route';

const request = () => new NextRequest('http://localhost/api/agent/skills/usk_1');
const context = { params: Promise.resolve({ id: 'usk_1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withRequestOwnerId.mockImplementation(
    async (
      _req: NextRequest,
      handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
    ) => handler('user:u1', new Headers()),
  );
  mocks.findUserSkill.mockResolvedValue({
    id: 'usk_1',
    content: '# Full body\n\nNone of it missing',
  });
});

describe('GET agent skill detail', () => {
  it('returns the complete body only for the current owner', async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.findUserSkill).toHaveBeenCalledWith('usk_1', 'user:u1');
    await expect(response.json()).resolves.toEqual({
      id: 'usk_1',
      content: '# Full body\n\nNone of it missing',
    });
  });

  it('uses the same 404 for an absent or foreign Skill', async () => {
    mocks.findUserSkill.mockResolvedValue(null);
    expect((await GET(request(), context)).status).toBe(404);
  });
});

describe('DELETE agent skill detail', () => {
  it('deletes only inside the request owner partition', async () => {
    const response = await DELETE(
      new NextRequest('http://localhost/api/agent/skills/usk_1', { method: 'DELETE' }),
      context,
    );
    expect(response.status).toBe(204);
    expect(mocks.deleteUserSkill).toHaveBeenCalledWith('user:u1', 'usk_1');
  });

  it('rejects built-ins without calling the owner store', async () => {
    const response = await DELETE(
      new NextRequest('http://localhost/api/agent/skills/stage-design', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'stage-design' }) },
    );
    expect(response.status).toBe(405);
    expect(await response.text()).toMatch(/Built-in skills cannot be deleted/);
    expect(mocks.deleteUserSkill).not.toHaveBeenCalled();
  });

  it('uses the same 404 for absent, foreign, and already-deleted owner ids', async () => {
    mocks.deleteUserSkill.mockRejectedValueOnce(
      new mocks.UserSkillError('No Skill was found for this owner.', 'not-found'),
    );
    const response = await DELETE(
      new NextRequest('http://localhost/api/agent/skills/usk_missing', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'usk_missing' }) },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });
});
