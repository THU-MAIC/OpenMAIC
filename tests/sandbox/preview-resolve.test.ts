import { beforeEach, expect, it, vi } from 'vitest';

const { verify, target } = vi.hoisted(() => ({ verify: vi.fn(), target: vi.fn() }));
vi.mock('@/lib/server/sandbox/preview', () => ({ verifyGatewayRequest: verify }));
vi.mock('@/lib/server/sandbox/service', () => ({ SandboxService: { previewTarget: target } }));
import { POST } from '@/app/api/sandbox/preview/resolve/route';
import {
  SandboxError,
  sandboxConflict,
  sandboxInvalid,
  sandboxNotFound,
} from '@/lib/sandbox/errors';

const descriptor = { ticket: 'test-only-grant', host: 'preview.localhost', activity: true };
function request(body = JSON.stringify(descriptor)) {
  return new Request('http://localhost/api/sandbox/preview/resolve', {
    method: 'POST',
    headers: { 'x-openmaic-preview-gateway': 'signed' },
    body,
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  verify.mockReturnValue(true);
});

it('denies unsigned and malformed input before reaching the service', async () => {
  verify.mockReturnValue(false);
  expect((await POST(request())).status).toBe(403);
  verify.mockReturnValue(true);
  for (const body of [
    'bad',
    'null',
    '{}',
    'x'.repeat(8193),
    '{"ticket":1,"host":"x"}',
    JSON.stringify({ ...descriptor, activity: false }),
  ]) {
    const response = await POST(request(body));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('');
  }
  expect(target).not.toHaveBeenCalled();
});

it('resolves authenticated activity with a non-cacheable response', async () => {
  target.mockResolvedValue({ transport: 'sdk', url: 'http://127.0.0.1:8000', expiresAt: 1 });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(target).toHaveBeenCalledWith(descriptor.ticket, descriptor.host, true);
});

it.each([
  sandboxInvalid('Invalid grant'),
  sandboxNotFound(),
  sandboxConflict('Revoked grant'),
  new SandboxError('SANDBOX_PREVIEW_FORBIDDEN', 403, 'Revoked'),
])('keeps invalid or revoked access terminal: $code', async (error) => {
  target.mockRejectedValue(error);
  expect((await POST(request())).status).toBe(403);
});

it.each([429, 500, 502, 503, 504])(
  'preserves retryable service status %s without leaking diagnostics',
  async (status) => {
    target.mockRejectedValue(new SandboxError('SANDBOX_UNAVAILABLE', status, 'private diagnostic'));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
  },
);

it('treats unexpected storage/provider errors as retryable, not revoked grants', async () => {
  target.mockRejectedValue(new Error('private connection diagnostic'));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('');
});
