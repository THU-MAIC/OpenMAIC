/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response using the configured web search provider.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  buildSearchQuery,
  SEARCH_QUERY_REWRITE_EXCERPT_LENGTH,
} from '@/lib/server/search-query-builder';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { AICallFn } from '@openmaic/generation';
import { DEFAULT_WEB_SEARCH_PROVIDER_ID, WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import {
  resolveWebSearchConnection,
  WebSearchConfigError,
  type WebSearchConfig,
} from '@/lib/server/web-search-config';
import { mediaResolutionResponse } from '@/lib/server/model-config/media';
import { requestWorkspaceId } from '@/lib/server/model-config/runtime';

const log = createLogger('WebSearch');

export async function POST(req: NextRequest) {
  let query: string | undefined;
  try {
    const body = await req.json();
    const {
      query: requestQuery,
      pdfText,
      providerId: requestProviderId,
      apiKey: bodyApiKey,
      baseUrl: bodyBaseUrl,
      baiduSubSources,
      claudeModelId,
    } = body as {
      query?: string;
      pdfText?: string;
      providerId?: WebSearchProviderId;
      apiKey?: string;
      baseUrl?: string;
      baiduSubSources?: BaiduSubSources;
      claudeModelId?: string;
    };
    query = requestQuery;

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    // The webSearch slot decides; the provider, key and base URL a request
    // names (deprecated) count only when it is unassigned.
    let config: WebSearchConfig;
    try {
      config = await resolveWebSearchConnection(
        await requestWorkspaceId(req),
        {
          webSearchProviderId: requestProviderId,
          webSearchApiKey: bodyApiKey,
          webSearchBaseUrl: bodyBaseUrl,
          webSearchModelId: claudeModelId,
          baiduSubSources,
        },
        {
          refuseDisabled: true,
          preferServerProvider: true,
          fallbackProviderId: DEFAULT_WEB_SEARCH_PROVIDER_ID,
        },
      );
    } catch (error) {
      const refused = mediaResolutionResponse(error, 'Web search');
      if (refused) return refused;
      if (error instanceof WebSearchConfigError) {
        const provider = error.providerId ? WEB_SEARCH_PROVIDERS[error.providerId] : undefined;
        const message =
          error.providerId && provider && error.code === 'MISSING_API_KEY'
            ? `${provider.name} API key is not configured. Set it in the model settings or configure ${getWebSearchEnvKey(error.providerId)} on the server.`
            : error.providerId && provider && error.code === 'MISSING_REQUIRED_FIELD'
              ? getMissingBaseUrlMessage(error.providerId, provider.name)
              : error.message;
        return apiError(error.code, 400, message);
      }
      if (error instanceof Error && /base URL/.test(error.message)) {
        return apiError('INVALID_REQUEST', 400, error.message);
      }
      throw error;
    }

    // Clamp rewrite input at the route boundary; framework body limits still apply to total request size.
    const boundedPdfText = pdfText?.slice(0, SEARCH_QUERY_REWRITE_EXCERPT_LENGTH);

    let aiCall: AICallFn | undefined;
    try {
      const {
        model: languageModel,
        thinkingConfig,
        serverManaged,
      } = await resolveModelFromRequest(req, body, 'web-search-query-rewrite');
      aiCall = async (systemPrompt, userPrompt) => {
        const result = await callLLM(
          {
            model: languageModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            maxOutputTokens: 256,
          },
          'web-search-query-rewrite',
          undefined,
          thinkingConfig,
          { serverManaged },
        );
        return result.text;
      };
    } catch (error) {
      log.warn('Search query rewrite model unavailable, falling back to raw requirement:', error);
    }

    const searchQuery = await buildSearchQuery(query, boundedPdfText, aiCall);

    log.info('Running web search API request', {
      hasPdfContext: searchQuery.hasPdfContext,
      rawRequirementLength: searchQuery.rawRequirementLength,
      rewriteAttempted: searchQuery.rewriteAttempted,
      finalQueryLength: searchQuery.finalQueryLength,
    });

    const result = await searchWeb({ ...config, query: searchQuery.query });
    const context = formatSearchResultsAsContext(result);

    return apiSuccess({
      answer: result.answer,
      sources: result.sources,
      context,
      query: result.query,
      responseTime: result.responseTime,
    });
  } catch (err) {
    log.error(`Web search failed [query="${query?.substring(0, 60) ?? 'unknown'}"]:`, err);
    const message = err instanceof Error ? err.message : 'Web search failed';
    return apiError('INTERNAL_ERROR', 500, message);
  }
}

function getMissingBaseUrlMessage(providerId: WebSearchProviderId, providerName: string): string {
  if (providerId === 'searxng') {
    return `${providerName} base URL is not configured. Set SEARXNG_BASE_URL on the server.`;
  }
  return `${providerName} base URL is not configured. Set ${getWebSearchEnvKey(providerId)} on the server or configure the base URL in the model settings.`;
}

function getWebSearchEnvKey(providerId: WebSearchProviderId): string {
  switch (providerId) {
    case 'exa':
      return 'EXA_API_KEY';
    case 'baidu':
      return 'BAIDU_API_KEY';
    case 'bocha':
      return 'BOCHA_API_KEY';
    case 'brave':
      return 'BRAVE_API_KEY';
    case 'claude':
      return 'WEB_SEARCH_CLAUDE_API_KEY';
    case 'minimax':
      return 'WEB_SEARCH_MINIMAX_API_KEY';
    case 'doubao':
      return 'WEB_SEARCH_DOUBAO_API_KEY';
    case 'searxng':
      return 'SEARXNG_BASE_URL';
    case 'tavily':
    default:
      return 'TAVILY_API_KEY';
  }
}
