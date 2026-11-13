import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEY = 'NEXT_PUBLIC_APP_BASE_PATH';
const originalBasePath = process.env[ENV_KEY];

/** Load a fresh module instance: the helper reads the basePath at import time. */
async function appUrlWith(basePath: string | undefined) {
  vi.resetModules();
  if (basePath === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = basePath;
  const { appUrl } = await import('@/lib/utils/app-url');
  return appUrl;
}

afterEach(() => {
  if (originalBasePath === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalBasePath;
});

describe('appUrl', () => {
  it('leaves every path untouched when no basePath is configured', async () => {
    const appUrl = await appUrlWith(undefined);
    expect(appUrl('/api/health')).toBe('/api/health');
    expect(appUrl('/classroom/abc')).toBe('/classroom/abc');
  });

  it('prefixes an app-local absolute path', async () => {
    const appUrl = await appUrlWith('/openmaic');
    expect(appUrl('/api/health')).toBe('/openmaic/api/health');
    expect(appUrl('/')).toBe('/openmaic/');
  });

  it('normalises a trailing slash in the configured basePath', async () => {
    const appUrl = await appUrlWith('/openmaic/');
    expect(appUrl('/api/health')).toBe('/openmaic/api/health');
  });

  it('is idempotent for a path that already carries the prefix', async () => {
    const appUrl = await appUrlWith('/openmaic');
    expect(appUrl('/openmaic')).toBe('/openmaic');
    expect(appUrl('/openmaic/api/health')).toBe('/openmaic/api/health');
  });

  it('does not mistake a sibling path for the prefix', async () => {
    const appUrl = await appUrlWith('/openmaic');
    expect(appUrl('/openmaicish/x')).toBe('/openmaic/openmaicish/x');
  });

  it('does not prefix addresses that are not app-local', async () => {
    const appUrl = await appUrlWith('/openmaic');
    expect(appUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(appUrl('//cdn.example.com/a.png')).toBe('//cdn.example.com/a.png');
    expect(appUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(appUrl('blob:http://localhost/1234')).toBe('blob:http://localhost/1234');
    expect(appUrl('🎓')).toBe('🎓');
  });

  it('treats a "/" basePath as no prefix', async () => {
    const appUrl = await appUrlWith('/');
    expect(appUrl('/api/health')).toBe('/api/health');
  });
});
