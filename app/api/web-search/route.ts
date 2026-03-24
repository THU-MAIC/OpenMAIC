/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response using Tavily search.
 * When pdfText is provided, enhances the query using LLM to extract
 * meaningful keywords from the document.
 */

import { searchWithTavily, formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { enhanceSearchQuery } from '@/lib/web-search/query-enhancer';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';

const log = createLogger('WebSearch');

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      query,
      apiKey: clientApiKey,
      pdfText,
      modelConfig,
    } = body as {
      query?: string;
      apiKey?: string;
      pdfText?: string;
      modelConfig?: {
        modelString?: string;
        apiKey?: string;
        baseUrl?: string;
        providerType?: string;
        requiresApiKey?: boolean;
      };
    };

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    const apiKey = resolveWebSearchApiKey(clientApiKey);
    if (!apiKey) {
      return apiError(
        'MISSING_API_KEY',
        400,
        'Tavily API key is not configured. Set it in Settings → Web Search or set TAVILY_API_KEY env var.',
      );
    }

    // Enhance query with PDF context if available
    const effectiveQuery = await enhanceSearchQuery(query.trim(), pdfText, modelConfig);

    const result = await searchWithTavily({ query: effectiveQuery, apiKey });
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
