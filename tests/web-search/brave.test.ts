import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { parseBraveSearchHtml, searchWithBrave } from '@/lib/web-search/brave';

describe('parseBraveSearchHtml', () => {
  it('extracts web results, decodes entities, strips date prefixes, and skips Brave links', () => {
    const html = `
      <div class="snippet svelte-abc" data-pos="0" data-type="web">
        <a href="https://example.com/a?x=1&amp;y=2">
          <span class="search-snippet-title">Example &amp; Title</span>
        </a>
        <div class="generic-snippet">Jan 1, 2026 - Result <strong>content</strong> &amp; more</div>
      </div>
      <div class="snippet svelte-def" data-pos="1" data-type="web">
        <a href="https://search.brave.com/help"><span class="search-snippet-title">Brave Help</span></a>
        <div class="generic-snippet">Internal Brave result</div>
      </div>
      <div class="snippet svelte-ghi" data-pos="2" data-type="web">
        <a href="https://second.example.com">
          <span class="search-snippet-title">Second result</span>
        </a>
        <p class="snippet-description">2 days ago - Secondary description</p>
      </div>
      <footer>footer</footer>
    `;

    expect(parseBraveSearchHtml(html, 5)).toEqual([
      {
        title: 'Example & Title',
        url: 'https://example.com/a?x=1&y=2',
        content: 'Result content & more',
        score: 1,
      },
      {
        title: 'Second result',
        url: 'https://second.example.com',
        content: 'Secondary description',
        score: 0.9,
      },
    ]);
  });
});

describe('searchWithBrave', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('uses Brave public search without an API key and clamps long queries', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        `
          <div class="snippet" data-type="web">
            <a href="https://example.com"><span class="search-snippet-title">Example</span></a>
            <div class="generic-snippet">Content</div>
          </div>
        `,
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    );

    const result = await searchWithBrave({
      query: 'x'.repeat(500),
      maxResults: 3,
    });

    const requestedUrl = new URL(proxyFetchMock.mock.calls[0][0]);
    expect(requestedUrl.origin).toBe('https://search.brave.com');
    expect(requestedUrl.pathname).toBe('/search');
    expect(requestedUrl.searchParams.get('q')).toHaveLength(400);
    expect(proxyFetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    expect(result.sources).toHaveLength(1);
    expect(result.query).toHaveLength(400);
  });
});
