/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response using Tavily search.
 */

import { searchWithTavily, formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { searchWithSearXNG } from '@/lib/web-search/searxng';
import { resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';

const log = createLogger('WebSearch');

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { query, apiKey: clientApiKey, providerId, baseUrl } = body as {
      query?: string;
      apiKey?: string;
      providerId?: string;
      baseUrl?: string;
    };

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    let result;
    if (providerId === 'searxng') {
      result = await searchWithSearXNG({
        query: query.trim(),
        baseUrl: baseUrl || process.env.SEARXNG_URL || 'http://127.0.0.1:8080/search'
      });
    } else {
      const apiKey = resolveWebSearchApiKey(clientApiKey);
      if (!apiKey) {
        return apiError(
          'MISSING_API_KEY',
          400,
          'Tavily API key is not configured. Set it in Settings → Web Search or set TAVILY_API_KEY env var.',
        );
      }
      result = await searchWithTavily({ query: query.trim(), apiKey });
    }

    const context = formatSearchResultsAsContext(result);

    return apiSuccess({
      answer: result.answer,
      sources: result.sources,
      context,
      query: result.query,
      responseTime: result.responseTime,
    });
  } catch (err) {
    log.error('[WebSearch] Error:', err);
    const message = err instanceof Error ? err.message : 'Web search failed';
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
