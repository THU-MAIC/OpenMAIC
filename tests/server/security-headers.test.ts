import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextConfig } from 'next';

async function loadConfig(): Promise<NextConfig> {
  vi.resetModules();
  const mod = await import('@/next.config');
  return mod.default;
}

describe('Security response headers', () => {
  afterEach(() => {
    delete process.env.ALLOWED_FRAME_ANCESTORS;
  });

  describe('default (no ALLOWED_FRAME_ANCESTORS)', () => {
    it('nextConfig.headers() is defined', async () => {
      const config = await loadConfig();
      expect(config.headers).toBeDefined();
      expect(typeof config.headers).toBe('function');
    });

    it('includes X-Frame-Options SAMEORIGIN on all routes', async () => {
      const config = await loadConfig();
      const headerGroups = await config.headers!();
      const allRouteGroup = headerGroups.find((g) => g.source === '/(.*)')!;

      expect(allRouteGroup).toBeDefined();
      expect(allRouteGroup.headers).toContainEqual({
        key: 'X-Frame-Options',
        value: 'SAMEORIGIN',
      });
    });

    it("includes Content-Security-Policy frame-ancestors 'self'", async () => {
      const config = await loadConfig();
      const headerGroups = await config.headers!();
      const allRouteGroup = headerGroups.find((g) => g.source === '/(.*)')!;

      expect(allRouteGroup).toBeDefined();
      expect(allRouteGroup.headers).toContainEqual({
        key: 'Content-Security-Policy',
        value: "frame-ancestors 'self'",
      });
    });
  });

  describe('with ALLOWED_FRAME_ANCESTORS', () => {
    it('appends allowed origins to frame-ancestors', async () => {
      process.env.ALLOWED_FRAME_ANCESTORS = 'https://partner.example.com';
      const config = await loadConfig();
      const headerGroups = await config.headers!();
      const allRouteGroup = headerGroups.find((g) => g.source === '/(.*)')!;

      expect(allRouteGroup.headers).toContainEqual({
        key: 'Content-Security-Policy',
        value: "frame-ancestors 'self' https://partner.example.com",
      });
    });

    it('omits X-Frame-Options when custom ancestors are set', async () => {
      process.env.ALLOWED_FRAME_ANCESTORS = 'https://partner.example.com';
      const config = await loadConfig();
      const headerGroups = await config.headers!();
      const allRouteGroup = headerGroups.find((g) => g.source === '/(.*)')!;

      const xfo = allRouteGroup.headers.find((h) => h.key === 'X-Frame-Options');
      expect(xfo).toBeUndefined();
    });

    it('supports multiple space-separated origins', async () => {
      process.env.ALLOWED_FRAME_ANCESTORS = 'https://a.example.com https://b.example.com';
      const config = await loadConfig();
      const headerGroups = await config.headers!();
      const allRouteGroup = headerGroups.find((g) => g.source === '/(.*)')!;

      expect(allRouteGroup.headers).toContainEqual({
        key: 'Content-Security-Policy',
        value: "frame-ancestors 'self' https://a.example.com https://b.example.com",
      });
    });
  });
});
