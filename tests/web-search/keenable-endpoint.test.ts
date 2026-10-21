import { describe, expect, it } from 'vitest';
import { keenable } from '@/lib/web-fetch/providers/keenable';
import { isOfficialKeenableBaseUrl, keenableEndpoint } from '@/lib/web-search/keenable-endpoint';
import { WEB_SEARCH_PROVIDERS, isOfficialWebSearchBaseUrl } from '@/lib/web-search/constants';

describe('Keenable endpoints shared by search and fetch', () => {
  it.each([
    'https://api.keenable.ai',
    'https://api.keenable.ai/',
    'https://api.keenable.ai/v1',
    'https://api.keenable.ai/v1/search',
    'https://api.keenable.ai/v1/search/public',
    'https://api.keenable.ai/v1/fetch/',
  ])('derives both tools from one base URL: %s', (base) => {
    expect(keenableEndpoint(base, 'search', false)).toBe(
      'https://api.keenable.ai/v1/search/public',
    );
    expect(keenableEndpoint(base, 'fetch', false)).toBe('https://api.keenable.ai/v1/fetch/public');
    expect(keenableEndpoint(base, 'search', true)).toBe('https://api.keenable.ai/v1/search');
    expect(keenableEndpoint(base, 'fetch', true)).toBe('https://api.keenable.ai/v1/fetch');
  });

  it('keeps a deployment gateway path prefix', () => {
    expect(keenableEndpoint('https://gateway.example.com/keenable/v1', 'fetch', true)).toBe(
      'https://gateway.example.com/keenable/v1/fetch',
    );
  });

  it.each([
    'https://api.keenable.ai?key=secret',
    'https://user:pass@api.keenable.ai',
    'https://api.keenable.ai#fragment',
    'ftp://api.keenable.ai',
  ])('refuses ambiguous bases: %s', (base) => {
    expect(() => keenableEndpoint(base, 'search', false)).toThrow(/Invalid/);
    expect(isOfficialKeenableBaseUrl(base)).toBe(false);
  });

  it('accepts the same official workspace bases for search and fetch', () => {
    expect(WEB_SEARCH_PROVIDERS.keenable.defaultBaseUrl).toBe(keenable.defaultBaseUrl);
    for (const base of [
      'https://api.keenable.ai',
      'https://api.keenable.ai/v1/search/public',
      'https://api.keenable.ai/v1/fetch',
    ]) {
      expect(isOfficialWebSearchBaseUrl('keenable', base)).toBe(true);
      expect(keenable.acceptsWorkspaceBaseUrl?.(base)).toBe(true);
    }
    for (const base of ['https://keenable.internal.example', 'https://api.keenable.ai/v2']) {
      expect(isOfficialWebSearchBaseUrl('keenable', base)).toBe(false);
      expect(keenable.acceptsWorkspaceBaseUrl?.(base)).toBe(false);
    }
  });
});
