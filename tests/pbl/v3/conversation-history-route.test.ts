import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ page: vi.fn(), resolve: vi.fn() }));
vi.mock('@/lib/server/pbl-v3/conversation-page', () => ({ conversationPage: mocks.page }));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../../helpers/owner-resolution-mock')).ownerResolveModule(mocks.resolve),
);
import { GET } from '@/app/api/pbl/v3/history/route';
import { SandboxError } from '@/lib/sandbox/errors';
afterEach(() => vi.clearAllMocks());
it('keeps passive conversation history behind the same owner and CSRF boundary', async () => {
  mocks.resolve.mockReturnValue('user:mine');
  const url = 'http://localhost/api/pbl/v3/history?id=study&sessionId=role&through=50';
  expect((await GET(new Request(url))).status).toBe(403);
  expect(
    (
      await GET(
        new Request(url, {
          headers: { 'x-openmaic-sandbox': '1', 'sec-fetch-site': 'cross-site' },
        }),
      )
    ).status,
  ).toBe(403);
  expect(mocks.page).not.toHaveBeenCalled();
  mocks.page.mockResolvedValue({ conversation: [], nextBefore: null, through: 50 });
  const response = await GET(new Request(url, { headers: { 'x-openmaic-sandbox': '1' } }));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mocks.page).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: 'user:mine' }),
    expect.any(URLSearchParams),
  );
  mocks.page.mockRejectedValue(
    new SandboxError('PBL_NOT_FOUND', 404, 'Conversation is unavailable.'),
  );
  expect((await GET(new Request(url, { headers: { 'x-openmaic-sandbox': '1' } }))).status).toBe(
    404,
  );
});
