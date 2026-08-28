import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => true,
  isAgentRuntimeConfigured: () => true,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: () => 'owner-1',
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({ getSession: mocks.getSession }),
}));

import { GET } from '@/app/api/agent/sessions/[id]/route';

function call() {
  return GET(new NextRequest('http://localhost/api/agent/sessions/session-1'), {
    params: Promise.resolve({ id: 'session-1' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-1', status: 'running' });
});

describe('GET one agent session', () => {
  it('returns an owned session', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 'session-1', status: 'running' });
  });

  it('does not expose a foreign session', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-2' });
    expect((await call()).status).toBe(404);
  });

  it.each(['not-a-real-id', 'x'.repeat(4096)])(
    'answers a malformed or oversized session id (%s) with not found',
    async (id) => {
      mocks.getSession.mockResolvedValue(null);

      const response = await GET(new NextRequest(`http://localhost/api/agent/sessions/${id}`), {
        params: Promise.resolve({ id }),
      });

      expect(mocks.getSession).toHaveBeenCalledWith(id);
      expect(response.status).toBe(404);
    },
  );
});
