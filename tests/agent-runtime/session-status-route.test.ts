import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  runtimeEnabled: true,
  listSessionsByOwner: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => mocks.runtimeEnabled,
  isAgentRuntimeConfigured: () => mocks.runtimeEnabled,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: () => 'owner-1',
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({ listSessionsByOwner: mocks.listSessionsByOwner }),
}));

import { GET } from '@/app/api/agent/sessions/status/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeEnabled = true;
  mocks.listSessionsByOwner.mockResolvedValue([
    { id: 'session-queued', status: 'queued' },
    { id: 'session-running', status: 'running' },
    { id: 'session-done', status: 'succeeded' },
  ]);
});

describe('GET agent session status map', () => {
  it('builds an id-to-status mapping from the owner session list', async () => {
    const response = await GET(new NextRequest('http://localhost/api/agent/sessions/status'));

    expect(response.status).toBe(200);
    expect(mocks.listSessionsByOwner).toHaveBeenCalledWith('owner-1');
    await expect(response.json()).resolves.toEqual({
      'session-queued': 'queued',
      'session-running': 'running',
      'session-done': 'succeeded',
    });
  });

  it('stays behind the runtime feature gate', async () => {
    mocks.runtimeEnabled = false;

    expect((await GET(new NextRequest('http://localhost/api/agent/sessions/status'))).status).toBe(
      404,
    );
    expect(mocks.listSessionsByOwner).not.toHaveBeenCalled();
  });
});
