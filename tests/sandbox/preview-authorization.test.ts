import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createHmac } from 'node:crypto';
import {
  issuePreviewGrant,
  previewConfig,
  verifyGatewayRequest,
  verifyPreviewGrant,
} from '@/lib/server/sandbox/preview';
beforeEach(() => {
  vi.stubEnv('OPENMAIC_SECRET_KEY', 'test-only-secret-'.repeat(3));
  vi.stubEnv('OPENMAIC_PREVIEW_GATEWAY_KEY', 'test-only-gateway-'.repeat(3));
  vi.stubEnv('OPENMAIC_SANDBOX_PREVIEW_ORIGIN', 'https://{id}.preview-example.net');
  vi.stubEnv('OPENMAIC_APP_ORIGIN', 'https://openmaic.example.com');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const input = {
  ownerId: 'owner-a',
  environmentId: '12345678-1234-1234-1234-123456789012',
  port: 3000,
  epoch: 0,
};
describe('preview grants', () => {
  it('binds the grant to an isolated origin and refuses modification', () => {
    const u = new URL(issuePreviewGrant(input).url);
    const ticket = u.hash.slice(1);
    expect(verifyPreviewGrant(ticket, u.host)).toMatchObject(input);
    expect(() => verifyPreviewGrant(ticket, 'other.preview-example.net')).toThrow();
    expect(() => verifyPreviewGrant(ticket + 'x', u.host)).toThrow();
  });
  it('keeps one origin per environment/port/epoch and changes it after revocation', () => {
    const a = new URL(issuePreviewGrant(input).url);
    expect(new URL(issuePreviewGrant(input).url).origin).toBe(a.origin);
    expect(new URL(issuePreviewGrant({ ...input, epoch: 1 }).url).origin).not.toBe(a.origin);
    expect(new URL(issuePreviewGrant({ ...input, port: 3001 }).url).origin).not.toBe(a.origin);
  });
  it('refuses expired grants', () => {
    vi.useFakeTimers();
    const u = new URL(issuePreviewGrant(input).url);
    vi.advanceTimersByTime(300001);
    expect(() => verifyPreviewGrant(u.hash.slice(1), u.host)).toThrow();
  });
  it.each([
    'https://{id}.example.com',
    'http://{id}.preview-example.net',
    'https://{id}.preview-example.net/path',
  ])('refuses unsafe origin %s', (pattern) => {
    vi.stubEnv('OPENMAIC_SANDBOX_PREVIEW_ORIGIN', pattern);
    expect(() => previewConfig()).toThrow();
  });
  it('allows a same-site preview domain only with the explicit opt-in', () => {
    vi.stubEnv('OPENMAIC_SANDBOX_PREVIEW_ORIGIN', 'https://{id}.preview.example.com');
    expect(() => previewConfig()).toThrow();
    vi.stubEnv('OPENMAIC_SANDBOX_PREVIEW_ALLOW_SAME_SITE', 'true');
    expect(previewConfig().pattern).toBe('https://{id}.preview.example.com');
    vi.stubEnv('OPENMAIC_SANDBOX_PREVIEW_ORIGIN', 'http://{id}.preview.example.com');
    expect(() => previewConfig()).toThrow();
  });
  it('requires signed machine requests with a bounded timestamp', () => {
    vi.useFakeTimers();
    const body = '{}';
    const at = String(Date.now());
    const sig = createHmac('sha256', process.env.OPENMAIC_PREVIEW_GATEWAY_KEY!)
      .update(at + '.' + body)
      .digest('hex');
    expect(verifyGatewayRequest(body, at + '.' + sig)).toBe(true);
    expect(verifyGatewayRequest('{"other":1}', at + '.' + sig)).toBe(false);
    vi.advanceTimersByTime(31000);
    expect(verifyGatewayRequest(body, at + '.' + sig)).toBe(false);
  });
});
