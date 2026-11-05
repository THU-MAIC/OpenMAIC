import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const state = vi.hoisted(() => ({ admin: true, reads: vi.fn(), writes: vi.fn() }));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (_req: Request, handle: (p: unknown, h: Headers) => Promise<Response>) =>
    handle(
      {
        kind: 'user',
        ownerId: 'owner',
        assurance: 'verified',
        roles: new Set(state.admin ? ['admin'] : ['sandbox:use']),
      },
      new Headers(),
    ),
}));
vi.mock('@/lib/server/sandbox/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/sandbox/settings')>();
  return { ...actual, sandboxSettingsView: state.reads, saveSandboxSettings: state.writes };
});
import { GET, PUT } from '@/app/api/sandbox/settings/route';
function req(method = 'GET', headers: Record<string, string> = {}, body?: string) {
  return new Request('http://localhost:3200/api/sandbox/settings', {
    method,
    headers: {
      'X-OpenMAIC-Sandbox': '1',
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3200',
      ...headers,
    },
    body,
  });
}
afterEach(() => {
  vi.unstubAllEnvs();
  state.admin = true;
  vi.clearAllMocks();
});
describe('sandbox settings route', () => {
  it('refuses non-admin reads and writes before accessing settings', async () => {
    state.admin = false;
    expect((await GET(req())).status).toBe(403);
    expect((await PUT(req('PUT', {}, '{}'))).status).toBe(403);
    expect(state.reads).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });
  it('enforces same-origin and explicit header', async () => {
    expect((await GET(req('GET', { 'X-OpenMAIC-Sandbox': '' }))).status).toBe(403);
    expect((await PUT(req('PUT', { Origin: 'https://other.example' }, '{}'))).status).toBe(403);
    expect((await GET(req('GET', { 'Sec-Fetch-Site': 'cross-site' }))).status).toBe(403);
    expect(state.reads).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });
  it('returns safe view and never caches settings', async () => {
    state.reads.mockResolvedValue({ keySet: true });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ success: true, data: { keySet: true } });
  });
  it('caps input and hides unexpected errors', async () => {
    expect((await PUT(req('PUT', {}, JSON.stringify({ x: 'x'.repeat(9000) })))).status).toBe(413);
    state.writes.mockRejectedValue(new Error('secret-sensitive-detail'));
    const res = await PUT(req('PUT', {}, '{}'));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('secret-sensitive-detail');
  });
});

it('shows a read-only deployment view to admins without a separate UI opt-in', async () => {
  state.reads.mockResolvedValue({ locked: true, source: 'deployment', keySet: true });
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect((await res.json()).data.locked).toBe(true);
});
