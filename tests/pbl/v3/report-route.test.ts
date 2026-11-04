import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const calls = vi.hoisted(() => ({ read: vi.fn(), generate: vi.fn(), after: vi.fn() }));
vi.mock('next/server', () => ({ after: calls.after }));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (
    _request: Request,
    handle: (p: unknown, h: Headers) => Promise<Response>,
  ) => handle({ ownerId: 'learner' }, new Headers()),
}));
vi.mock('@/lib/server/pbl-v3/report', () => ({
  learningReport: calls.read,
  generateLearningReport: calls.generate,
}));
import { GET, POST } from '@/app/api/pbl/v3/report/route';
afterEach(() => vi.clearAllMocks());
const request = (method: string, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/pbl/v3/report?id=study', {
    method,
    headers: {
      'x-openmaic-sandbox': '1',
      'content-type': 'application/json',
      origin: 'http://localhost',
      ...headers,
    },
  });
it('keeps report reads token-free and forwards generation only for a deliberate same-origin JSON request', async () => {
  calls.read.mockResolvedValue({ analysis: { status: 'not_generated' } });
  const read = await GET(request('GET'));
  expect(read.status).toBe(200);
  expect(read.headers.get('cache-control')).toBe('no-store');
  expect(calls.generate).not.toHaveBeenCalled();
  const rejectedHeaders: Record<string, string>[] = [
    { 'content-type': '' },
    { origin: 'https://other.example' },
    { 'x-openmaic-sandbox': '' },
  ];
  for (const headers of rejectedHeaders) {
    expect((await POST(request('POST', headers))).status).toBe(403);
  }
  expect(calls.generate).not.toHaveBeenCalled();
  calls.generate.mockResolvedValue({ analysis: { status: 'ready' } });
  expect((await POST(request('POST'))).status).toBe(200);
  expect(calls.generate).toHaveBeenCalledWith(
    { ownerId: 'learner' },
    'study',
    expect.any(AbortSignal),
    expect.any(Function),
  );
});
it('acknowledges scheduled generation with 202 instead of holding the HTTP request open', async () => {
  const work = vi.fn(async () => ({ analysis: { status: 'ready' } }));
  calls.generate.mockImplementationOnce(async (_p, _id, _signal, schedule) => {
    schedule(work);
    return { analysis: { status: 'generating' } };
  });
  const response = await POST(request('POST'));
  expect(response.status).toBe(202);
  expect((await response.json()).analysis.status).toBe('generating');
  expect(work).not.toHaveBeenCalled();
  expect(calls.after).toHaveBeenCalledOnce();
  await calls.after.mock.calls[0][0]();
  expect(work).toHaveBeenCalledOnce();
});
