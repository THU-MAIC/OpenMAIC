import { withAbort } from '../abort';
import type { WebFetchProvider } from '../types';
import {
  FIRECRAWL_DEFAULT_BASE_URL,
  firecrawlEndpoint,
  isOfficialFirecrawlBaseUrl,
} from '@/lib/web-search/firecrawl-endpoint';

/** Endpoint identity comes from the configured API base; a self-hosted base keeps its path. */
export function firecrawlScrapeEndpoint(baseUrl: string): string {
  return firecrawlEndpoint(baseUrl, 'scrape');
}

/**
 * Firecrawl Scrape (`POST /v2/scrape`): returns the page's main content as Markdown.
 * It shares the `firecrawl` provider (key and base URL) with Firecrawl web search.
 * Docs: https://docs.firecrawl.dev/features/scrape?utm_source=openmaic&utm_medium=integration
 */
export const firecrawl: Extract<WebFetchProvider, { hosted: true }> = {
  id: 'firecrawl',
  name: 'Firecrawl',
  hosted: true,
  requiresApiKey: true,
  defaultBaseUrl: FIRECRAWL_DEFAULT_BASE_URL,
  acceptsWorkspaceBaseUrl: isOfficialFirecrawlBaseUrl,
  resolveCredentials: (credentials = {}) => ({
    ...credentials,
    baseUrl: credentials.baseUrl ?? FIRECRAWL_DEFAULT_BASE_URL,
  }),
  extract: async (url, options) => {
    const credentials = firecrawl.resolveCredentials(options.credentials);
    if (!credentials.apiKey) throw new Error('Web fetch provider requires an API key');
    const bodyTimeoutMs = options.bodyTimeoutMs ?? 30_000;
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(bodyTimeoutMs)])
      : AbortSignal.timeout(bodyTimeoutMs);
    signal.throwIfAborted();
    const { Agent } = await import('undici');
    const { proxyFetch } = await import('@/lib/server/proxy-fetch');
    const agent = new Agent({
      connect: { timeout: 5_000 },
      // The scrape renders the page before answering, so headers arrive with the body.
      headersTimeout: bodyTimeoutMs,
      bodyTimeout: bodyTimeoutMs,
    });
    try {
      const endpoint = firecrawlScrapeEndpoint(credentials.baseUrl!);
      // No transport retry: a scrape is a billed request that may already have run.
      const response = await withAbort(
        proxyFetch(
          endpoint,
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${credentials.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              url,
              formats: ['markdown'],
              onlyMainContent: true,
              // Stop the scrape server-side at the same deadline the caller enforces.
              timeout: bodyTimeoutMs,
              origin: 'openmaic',
            }),
            signal,
            dispatcher: agent,
          } as RequestInit & { dispatcher: typeof agent },
          {
            proxy: credentials.proxy,
            timeouts: {
              connectTimeout: 5_000,
              headersTimeout: bodyTimeoutMs,
              bodyTimeout: bodyTimeoutMs,
            },
          },
        ),
        signal,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // Do not relay vendor messages, which can echo credentials or request data.
        throw new Error(`Web fetch provider returned HTTP ${response.status}`);
      }
      const { readWithTruncation } = await import('../builtin-extraction');
      const body = await readWithTruncation(
        response,
        4 * (options.maxBytes ?? 5 * 1024 * 1024) + 65_536,
        signal,
        bodyTimeoutMs,
      );
      if (body.truncated) throw new Error('Web fetch response exceeds the transport byte limit');
      let result: unknown;
      try {
        result = JSON.parse(body.bytes.toString('utf8'));
      } catch {
        throw new Error('Invalid web fetch JSON response');
      }
      signal.throwIfAborted();
      if (!result || typeof result !== 'object') throw new Error('Invalid web fetch response');
      const { success, data } = result as { success?: unknown; data?: unknown };
      if (success !== true || !data || typeof data !== 'object') {
        throw new Error('Invalid web fetch response');
      }
      const { markdown, metadata } = data as { markdown?: unknown; metadata?: unknown };
      const meta = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<
        string,
        unknown
      >;
      // Firecrawl answers 200 for a page that failed upstream; report it like the builtin reader.
      if (typeof meta.statusCode === 'number' && meta.statusCode >= 400) {
        throw new Error(`Remote server returned HTTP ${meta.statusCode}`);
      }
      if (typeof markdown !== 'string')
        throw new Error('Web fetch response has no Markdown content');
      return {
        markdown,
        ...(typeof meta.title === 'string' ? { title: meta.title } : {}),
        ...(typeof meta.url === 'string' ? { finalUrl: meta.url } : {}),
      };
    } finally {
      await agent.destroy();
    }
  },
};

export default firecrawl;
