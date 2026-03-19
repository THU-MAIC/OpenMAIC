/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response supporting multiple search providers.
 */

import { searchWithTavily } from '@/lib/web-search/tavily';
import { searchWithBrave } from '@/lib/web-search/brave';
import { searchWithBaidu } from '@/lib/web-search/baidu';
import { formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import type { WebSearchProviderId } from '@/lib/web-search/types';

const log = createLogger('WebSearch');

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      query,
      apiKey: clientApiKey,
      provider = 'tavily',
      baiduSubSources,
    } = body as {
      query?: string;
      apiKey?: string;
      provider?: WebSearchProviderId;
      baiduSubSources?: { webSearch?: boolean; baike?: boolean; scholar?: boolean };
    };

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    // Brave Search doesn't require an API key
    const needsApiKey = provider !== 'brave';
    const apiKey = needsApiKey ? resolveWebSearchApiKey(provider, clientApiKey) : '';

    if (needsApiKey && !apiKey) {
      const providerNames: Record<string, string> = {
        tavily: 'Tavily',
        baidu: 'Baidu',
      };
      const name = providerNames[provider] || provider;
      return apiError(
        'MISSING_API_KEY',
        400,
        `${name} API key is not configured. Set it in Settings → Web Search or set the corresponding env var.`,
      );
    }

    let result;
    switch (provider) {
      case 'brave':
        result = await searchWithBrave({ query: query.trim() });
        break;
      case 'baidu':
        result = await searchWithBaidu({
          query: query.trim(),
          apiKey,
          subSources: baiduSubSources,
        });
        break;
      case 'tavily':
      default:
        result = await searchWithTavily({ query: query.trim(), apiKey });
        break;
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
