/**
 * Live SearXNG smoke test — runs only when SEARXNG_BASE_URL is set.
 *
 * Example:
 *   SEARXNG_BASE_URL=https://searxng.10000.wiki npm test -- tests/web-search/searxng.smoke.test.ts
 */
import { describe, expect, it } from 'vitest';
import { searchWithSearxng } from '@/lib/web-search/searxng';

const searxngBaseUrl = process.env.SEARXNG_BASE_URL?.trim();
const describeSmoke = searxngBaseUrl ? describe : describe.skip;

describeSmoke('SearXNG live smoke', () => {
  it('returns structured sources from the JSON API', async () => {
    const result = await searchWithSearxng({
      query: 'open source software',
      baseUrl: searxngBaseUrl,
      maxResults: 3,
    });

    expect(result.sources.length).toBeGreaterThan(0);
    for (const source of result.sources) {
      expect(source.title).toEqual(expect.any(String));
      expect(source.title.length).toBeGreaterThan(0);
      expect(source.url).toMatch(/^https?:\/\//);
    }
    expect(result.query).toEqual(expect.any(String));
    expect(result.responseTime).toBeGreaterThan(0);
  }, 30_000);
});
