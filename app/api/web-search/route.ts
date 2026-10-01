/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response using the configured web search provider.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest, type ResolvedModel } from '@/lib/server/resolve-model';
import { DEFAULT_WEB_SEARCH_PROVIDER_ID, WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import {
  resolveWebSearchConnection,
  WebSearchConfigError,
  type WebSearchConfig,
} from '@/lib/server/web-search-config';
import { mediaResolutionResponse } from '@/lib/server/model-config/media';
import { requestWorkspaceId } from '@/lib/server/model-config/runtime';
import { research } from '@/lib/server/generation/steps/research';

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

    let rewriteModel: ResolvedModel | undefined;
    try {
      rewriteModel = await resolveModelFromRequest(req, body, 'web-search-query-rewrite');
    } catch (error) {
      log.warn('Search query rewrite model unavailable, falling back to raw requirement:', error);
    }

    const result = await research({ query, pdfText, config, rewriteModel }, { log });
    return apiSuccess({ ...result });
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
