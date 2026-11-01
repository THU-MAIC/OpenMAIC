import { describe, expect, it } from 'vitest';
import { firecrawl } from '@/lib/web-fetch/providers/firecrawl';
import { firecrawlEndpoint, isOfficialFirecrawlBaseUrl } from '@/lib/web-search/firecrawl-endpoint';
import { WEB_SEARCH_PROVIDERS, isOfficialWebSearchBaseUrl } from '@/lib/web-search/constants';

describe('Firecrawl endpoints shared by search and fetch', () => {
  it.each([
    'https://api.firecrawl.dev',
    'https://api.firecrawl.dev/',
    'https://api.firecrawl.dev/v2',
    'https://api.firecrawl.dev/v2/search',
    'https://api.firecrawl.dev/v2/scrape/',
  ])('derives both tools from one base URL: %s', (base) => {
    expect(firecrawlEndpoint(base, 'search')).toBe('https://api.firecrawl.dev/v2/search');
    expect(firecrawlEndpoint(base, 'scrape')).toBe('https://api.firecrawl.dev/v2/scrape');
  });

  it('keeps a self-hosted path prefix', () => {
    expect(firecrawlEndpoint('https://fc.example.com/firecrawl/v2', 'scrape')).toBe(
      'https://fc.example.com/firecrawl/v2/scrape',
    );
    expect(firecrawlEndpoint('http://10.0.0.5:3002', 'search')).toBe(
      'http://10.0.0.5:3002/v2/search',
    );
  });

  it.each([
    'https://api.firecrawl.dev?key=secret',
    'https://user:pass@api.firecrawl.dev',
    'https://api.firecrawl.dev#fragment',
    'ftp://api.firecrawl.dev',
  ])('refuses ambiguous bases: %s', (base) => {
    expect(() => firecrawlEndpoint(base, 'search')).toThrow(/Invalid/);
    expect(isOfficialFirecrawlBaseUrl(base)).toBe(false);
  });

  it('accepts the same official workspace bases for search and fetch', () => {
    expect(WEB_SEARCH_PROVIDERS.firecrawl.defaultBaseUrl).toBe(firecrawl.defaultBaseUrl);
    for (const base of [
      'https://api.firecrawl.dev',
      'https://api.firecrawl.dev/v2/search',
      'https://api.firecrawl.dev/v2/scrape',
    ]) {
      expect(isOfficialWebSearchBaseUrl('firecrawl', base)).toBe(true);
      expect(firecrawl.acceptsWorkspaceBaseUrl?.(base)).toBe(true);
    }
    for (const base of ['https://firecrawl.internal.example', 'https://api.firecrawl.dev/v1']) {
      expect(isOfficialWebSearchBaseUrl('firecrawl', base)).toBe(false);
      expect(firecrawl.acceptsWorkspaceBaseUrl?.(base)).toBe(false);
    }
  });
});
