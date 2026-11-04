import { describe, expect, it, vi } from 'vitest';
// The gateway runs as plain Node, deliberately outside the app/SDK bundle.
import {
  previewAuthorizationCookies,
  previewContentDisposition,
  validatePreviewTarget,
} from '../../scripts/sandbox-preview-policy.mjs';
describe('cross-site preview authorization cookie', () => {
  it.each(['openmaic_preview', '__Host-openmaic_preview'])(
    'uses a secure host-only partitioned cookie for %s',
    (name) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
      try {
        const cookies = previewAuthorizationCookies(name, 'signed-ticket', 6500);
        expect(cookies[0]).toBe(`${name}=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`);
        expect(cookies[1]).toBe(
          `${name}=signed-ticket; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=5`,
        );
        expect(previewAuthorizationCookies(name, 'signed-ticket', 999)[1]).toContain('Max-Age=0');
      } finally {
        clock.mockRestore();
      }
    },
  );
});
const native = () => ({
  transport: 'native',
  url: 'https://3000-example.provider.test',
  headers: { 'e2b-traffic-access-token': 'sandbox-token' },
  expiresAt: Date.now() + 10000,
});
describe('native HTML document preview', () => {
  it.each(['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml'])(
    'renders %s inline despite a bare ingress attachment header',
    (mime) => {
      expect(previewContentDisposition('native', mime, 'attachment')).toBe('inline');
    },
  );
  it('preserves named downloads, non-HTML, SDK responses and absent headers', () => {
    expect(
      previewContentDisposition('native', 'text/html', 'attachment; filename="page.html"'),
    ).toBe('attachment; filename="page.html"');
    expect(previewContentDisposition('native', 'application/zip', 'attachment')).toBe('attachment');
    expect(previewContentDisposition('sdk', 'text/html', 'attachment')).toBe('attachment');
    expect(previewContentDisposition('native', 'text/html', undefined)).toBeUndefined();
  });
});
describe('preview descriptor policy', () => {
  it('accepts authenticated native HTTPS and explicit SDK loopback', () => {
    expect(() => validatePreviewTarget(native())).not.toThrow();
    expect(() =>
      validatePreviewTarget({
        transport: 'sdk',
        url: 'http://127.0.0.1:3000',
        expiresAt: Date.now() + 10000,
      }),
    ).not.toThrow();
  });
  it.each([
    { url: 'http://host' },
    { url: 'https://user:password@host' },
    { url: 'https://host/evil' },
    { url: 'https://host?secret=x' },
    { expiresAt: 0 },
    { headers: {} },
    { headers: { 'e2b-traffic-access-token': 'x\r\nHeader:bad' } },
    { transport: 'unknown' },
  ])('rejects invalid descriptors %j', (delta) => {
    expect(() => validatePreviewTarget({ ...native(), ...delta })).toThrow();
  });
  it('never permits an SDK connection to another host or its control port', () => {
    for (const url of ['http://127.0.0.1:49983', 'http://host:3000', 'https://127.0.0.1:3000'])
      expect(() =>
        validatePreviewTarget({ transport: 'sdk', url, expiresAt: Date.now() + 10000 }),
      ).toThrow();
  });
});
