import { beforeEach, describe, expect, it, vi } from 'vitest';
const verify = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/sandbox/preview', () => ({ verifyGatewayRequest: verify }));
vi.mock('@/lib/server/sandbox/service', () => ({
  SandboxService: { openPreviewConnection: open },
}));
import { SandboxError } from '@/lib/sandbox/errors';
import { POST } from '@/app/api/sandbox/preview/tunnel/route';
beforeEach(() => vi.resetAllMocks());
function request(descriptor = '{}', body = 'hello') {
  return new Request('http://localhost/api/sandbox/preview/tunnel', {
    method: 'POST',
    headers: { 'x-openmaic-preview-request': descriptor, 'x-openmaic-preview-gateway': 'signed' },
    body,
  });
}
describe('machine preview tunnel', () => {
  it('denies unsigned input before connecting', async () => {
    verify.mockReturnValue(false);
    expect((await POST(request())).status).toBe(403);
    expect(open).not.toHaveBeenCalled();
  });
  it('refuses oversized or invalid descriptors', async () => {
    verify.mockReturnValue(true);
    for (const d of ['x'.repeat(8193), 'bad', '{}', '{"ticket":7,"host":"x"}'])
      expect((await POST(request(d))).status).toBe(403);
    expect(open).not.toHaveBeenCalled();
  });
  it('reports exhausted relay capacity as 429', async () => {
    verify.mockReturnValue(true);
    open.mockRejectedValue(new SandboxError('SANDBOX_PREVIEW_CAPACITY', 429, 'Capacity reached'));
    expect(
      (await POST(request(JSON.stringify({ ticket: 'fixture', host: 'fixture.localhost' }))))
        .status,
    ).toBe(429);
  });
  it('streams only through the authorized connection and closes it', async () => {
    verify.mockReturnValue(true);
    const close = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn().mockResolvedValue(undefined);
    open.mockResolvedValue({
      output: new ReadableStream({
        start(c) {
          c.enqueue(Uint8Array.of(2, 3));
          c.close();
        },
      }),
      write,
      close,
    });
    const r = await POST(request(JSON.stringify({ ticket: 'fixture', host: 'fixture.localhost' })));
    expect(r.status).toBe(200);
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(write).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('fixture', 'fixture.localhost', expect.any(AbortSignal));
  });
});
