import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  runtimeEnabled: true,
  getSession: vi.fn(),
  setManualSessionTitle: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => mocks.runtimeEnabled,
  isAgentRuntimeConfigured: () => mocks.runtimeEnabled,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: (_request: NextRequest, headers: Headers) => {
    headers.append('Set-Cookie', 'anonymous_id=test; Path=/; HttpOnly');
    return 'owner-1';
  },
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    getSession: mocks.getSession,
    setManualSessionTitle: mocks.setManualSessionTitle,
  }),
}));

import { GET, PATCH } from '@/app/api/agent/sessions/[id]/route';

function call() {
  return GET(new NextRequest('http://localhost/api/agent/sessions/session-1'), {
    params: Promise.resolve({ id: 'session-1' }),
  });
}

function patch(body: BodyInit, id = 'session-1') {
  return PATCH(
    new NextRequest(`http://localhost/api/agent/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body,
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeEnabled = true;
  mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-1', status: 'running' });
  mocks.setManualSessionTitle.mockImplementation(
    async (id: string, ownerId: string, title: string | null) => ({ id, ownerId, title }),
  );
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

describe('PATCH agent session title', () => {
  it.each([
    ['trim', '  Focused question  ', 'Focused question'],
    ['explicit clear', null, null],
    ['blank clear', '   ', null],
    ['length cap', `  ${'x'.repeat(121)}  `, 'x'.repeat(120)],
    ['surrogate-pair boundary', `${'x'.repeat(119)}😀tail`, 'x'.repeat(119)],
    ['unpaired surrogate', `Safe\ud83d title`, 'Safe� title'],
    ['NUL', `Safe\u0000 title`, 'Safe� title'],
  ])('normalizes %s before persisting', async (_name, title, expected) => {
    const response = await patch(JSON.stringify({ title }));

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(mocks.setManualSessionTitle).toHaveBeenCalledWith('session-1', 'owner-1', expected);
    await expect(response.json()).resolves.toEqual({ title: expected });
  });

  it.each([
    ['malformed JSON', '{'],
    ['a missing title', JSON.stringify({})],
    ['a numeric title', JSON.stringify({ title: 42 })],
    ['an object title', JSON.stringify({ title: { value: 'nope' } })],
  ])('rejects %s', async (_name, body) => {
    const response = await patch(body);

    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
  });

  it('stays behind the runtime feature gate', async () => {
    mocks.runtimeEnabled = false;

    const response = await patch(JSON.stringify({ title: 'Hidden' }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it('hides any session rejected by the owner-scoped store as not found', async () => {
    mocks.setManualSessionTitle.mockResolvedValue(null);

    const response = await patch(JSON.stringify({ title: 'Hidden' }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
  });
});
