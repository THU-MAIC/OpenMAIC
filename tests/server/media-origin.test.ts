import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import {
  LOCAL_MEDIA_ORIGIN,
  normalizeOrigin,
  resolveMediaServingOrigin,
} from '@/lib/server/media-origin';

const MAIN_SITE_ORIGIN = 'https://main-site.example';

describe('resolveMediaServingOrigin', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_MAIN_SITE_ORIGIN;
  });

  it('prefers the explicitly threaded origin', () => {
    expect(resolveMediaServingOrigin('https://app.example.com')).toBe('https://app.example.com');
  });

  it('normalizes a threaded origin with a trailing slash', () => {
    expect(resolveMediaServingOrigin('https://app.example.com/')).toBe('https://app.example.com');
  });

  it('prefers the threaded origin over a request origin', () => {
    const req = new NextRequest('http://app.internal/api/agent/sessions', {
      headers: { 'x-forwarded-host': 'app.public.example', 'x-forwarded-proto': 'https' },
    });
    expect(resolveMediaServingOrigin('https://threaded.example', req)).toBe(
      'https://threaded.example',
    );
  });

  it('uses the incoming request origin when nothing is threaded', () => {
    const req = new NextRequest('http://app.internal/api/agent/sessions', {
      headers: { 'x-forwarded-host': 'app.public.example', 'x-forwarded-proto': 'https' },
    });
    expect(resolveMediaServingOrigin(undefined, req)).toBe('https://app.public.example');
  });

  it('falls back to a local dev origin when nothing is threaded and no request exists', () => {
    expect(resolveMediaServingOrigin()).toBe(LOCAL_MEDIA_ORIGIN);
    expect(resolveMediaServingOrigin('')).toBe(LOCAL_MEDIA_ORIGIN);
    expect(resolveMediaServingOrigin(null)).toBe(LOCAL_MEDIA_ORIGIN);
    expect(resolveMediaServingOrigin('   ')).toBe(LOCAL_MEDIA_ORIGIN);
  });

  // The regression this file exists for: classroom media is served by THIS
  // app's /api/classroom-media route, so the serving origin must NEVER be the
  // main site, no matter what NEXT_PUBLIC_MAIN_SITE_ORIGIN says (it points at
  // a different product whose media route rejects every request).
  it('never returns NEXT_PUBLIC_MAIN_SITE_ORIGIN, even when it is set', () => {
    process.env.NEXT_PUBLIC_MAIN_SITE_ORIGIN = MAIN_SITE_ORIGIN;
    expect(resolveMediaServingOrigin()).not.toContain('main-site.example');
    expect(resolveMediaServingOrigin()).toBe(LOCAL_MEDIA_ORIGIN);
    const req = new NextRequest('http://app.internal/api/agent/sessions', {
      headers: { 'x-forwarded-host': 'app.public.example', 'x-forwarded-proto': 'https' },
    });
    expect(resolveMediaServingOrigin(undefined, req)).not.toContain('main-site.example');
  });

  it('normalizeOrigin strips trailing slashes and whitespace', () => {
    expect(normalizeOrigin('  https://app.example.com/// ')).toBe('https://app.example.com');
  });
});
