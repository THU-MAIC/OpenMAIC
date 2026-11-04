import { expect, it, vi } from 'vitest';
import { readPblJson } from '@/lib/pbl/v3/response';
import { pblRequest } from '@/components/scene-renderers/pbl/v3/request';
import { SandboxRequestError } from '@/components/sandbox/client';

it.each([524, 502, 200])(
  'preserves unknown outcomes for empty HTTP %s without a raw JSON exception',
  async (status) => {
    await expect(readPblJson(new Response(null, { status }))).rejects.toMatchObject({
      status,
      code: 'SANDBOX_UNAVAILABLE',
    });
  },
);
it.each(['<html>upstream failure</html>', '{"incomplete":', 'null', '"text"'])(
  'handles non-JSON or invalid API data safely',
  async (body) => {
    await expect(readPblJson(new Response(body))).rejects.toBeInstanceOf(SandboxRequestError);
  },
);
it('retains structured errors and arrays for their existing caller handling', async () => {
  const body = { error: { code: 'SANDBOX_CONFLICT', reason: 'PROGRESS_CHANGED' } };
  expect(await readPblJson(Response.json(body, { status: 409 }))).toEqual(body);
  expect(await readPblJson(Response.json(['sample']))).toEqual(['sample']);
});
it('preserves deliberate cancellation', async () => {
  const aborted = new DOMException('Cancelled', 'AbortError');
  const response = new Response();
  vi.spyOn(response, 'json').mockRejectedValueOnce(aborted);
  await expect(readPblJson(response)).rejects.toBe(aborted);
});
it('never replays a mutation after a lost response', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 524 }));
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(
      pblRequest('/api/pbl/v3', { command: { id: 'stable-command', type: 'quiz' } }),
    ).rejects.toBeInstanceOf(SandboxRequestError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body).command.id).toBe('stable-command');
  } finally {
    vi.unstubAllGlobals();
  }
});
