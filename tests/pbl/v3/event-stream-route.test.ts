import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ response: vi.fn(), resolve: vi.fn() }));
vi.mock('@/lib/server/pbl-v3/event-stream', () => ({ learningEventResponse: mocks.response }));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../../helpers/owner-resolution-mock')).ownerResolveModule(mocks.resolve),
);
import { GET } from '@/app/api/pbl/v3/events/route';
import { SandboxError } from '@/lib/sandbox/errors';
afterEach(() => vi.clearAllMocks());
function call(id = 'study', headers: Record<string, string> = { 'x-openmaic-sandbox': '1' }) {
  return GET(new Request(`http://localhost/api/pbl/v3/events?id=${id}`, { headers }));
}
describe('V3 SSE owner and deliberate-client boundary', () => {
  it('keeps cookie identity on the stream and passes the disconnect signal', async () => {
    mocks.resolve.mockImplementation((_request, headers: Headers) => {
      headers.set('set-cookie', 'anonymous_id=test; Path=/; HttpOnly');
      return 'user:mine';
    });
    mocks.response.mockResolvedValue(
      new Response('event: learning\ndata: {}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const response = await call();
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(mocks.response).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user:mine' }),
      'study',
      expect.any(AbortSignal),
    );
  });
  it('refuses missing headers and cross-origin attaches before opening a projection', async () => {
    mocks.resolve.mockReturnValue('user:mine');
    expect((await call('study', {})).status).toBe(403);
    expect(
      (await call('study', { 'x-openmaic-sandbox': '1', 'sec-fetch-site': 'cross-site' })).status,
    ).toBe(403);
    expect(mocks.response).not.toHaveBeenCalled();
  });
  it('keeps another owner indistinguishable from an unavailable study', async () => {
    mocks.resolve.mockReturnValue('user:mine');
    mocks.response.mockRejectedValue(
      new SandboxError('PBL_NOT_FOUND', 404, 'Learning session is unavailable.'),
    );
    expect((await call()).status).toBe(404);
  });
});
