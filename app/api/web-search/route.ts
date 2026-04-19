/**
 * Web Search API
 *
 * POST /api/web-search
 * Supports multiple search providers (Tavily, Claude).
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { searchWithTavily, formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { searchWithClaude } from '@/lib/web-search/claude';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import { resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { createLogger } from '@/lib/logger';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import {
  buildSearchQuery,
  SEARCH_QUERY_REWRITE_EXCERPT_LENGTH,
} from '@/lib/server/search-query-builder';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { WebSearchProviderId } from '@/lib/web-search/types';

const log = createLogger('WebSearch');

export async function POST(req: NextRequest) {
  let query: string | undefined;
  try {
    const body = await req.json();
    const {
      query: requestQuery,
      pdfText,
      apiKey: clientApiKey,
      providerId: requestProviderId,
      providerConfig,
    } = body as {
      query?: string;
      pdfText?: string;
      apiKey?: string;
      providerId?: WebSearchProviderId;
      providerConfig?: {
        modelId?: string;
        baseUrl?: string;
        tools?: Array<{ type: string; name: string }>;
      };
    };
    query = requestQuery;

    // Provider must be explicitly specified
    const providerId: WebSearchProviderId | null = requestProviderId ?? null;

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    if (!providerId) {
      return apiError(
        'MISSING_PROVIDER',
        400,
        'Web search provider is not selected. Please select a provider in the toolbar.',
      );
    }

    if (!(providerId in WEB_SEARCH_PROVIDERS)) {
      return apiError('INVALID_REQUEST', 400, `Unknown web search provider: ${providerId}`);
    }

    const apiKey = resolveWebSearchApiKey(providerId, clientApiKey);
    if (!apiKey) {
      const envVar = providerId === 'claude' ? 'ANTHROPIC_API_KEY' : 'TAVILY_API_KEY';
      return apiError(
        'MISSING_API_KEY',
        400,
        `${providerId} API key is not configured. Set it in Settings → Web Search or set ${envVar} env var.`,
      );
    }

    // Clamp rewrite input at the route boundary; framework body limits still apply to total request size.
    const boundedPdfText = pdfText?.slice(0, SEARCH_QUERY_REWRITE_EXCERPT_LENGTH);

    let aiCall: AICallFn | undefined;
    try {
      const { model: languageModel } = await resolveModelFromHeaders(req);
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
        );
        return result.text;
      };
    } catch (error) {
      log.warn('Search query rewrite model unavailable, falling back to raw requirement:', error);
    }

    const searchQuery = await buildSearchQuery(query, boundedPdfText, aiCall);

    log.info('Running web search API request', {
      provider: providerId,
      hasPdfContext: searchQuery.hasPdfContext,
      rawRequirementLength: searchQuery.rawRequirementLength,
      rewriteAttempted: searchQuery.rewriteAttempted,
      finalQueryLength: searchQuery.finalQueryLength,
    });

    // Validate client-supplied base URL against SSRF in all environments
    if (providerConfig?.baseUrl) {
      const ssrfError = await validateUrlForSSRF(providerConfig.baseUrl);
      if (ssrfError) {
        return apiError(API_ERROR_CODES.INVALID_URL, 400, ssrfError);
      }
    }

    const baseUrl =
      providerConfig?.baseUrl || WEB_SEARCH_PROVIDERS[providerId].defaultBaseUrl || '';

    let result;
    switch (providerId) {
      case 'claude': {
        result = await searchWithClaude({
          query: searchQuery.query,
          apiKey,
          baseUrl,
          modelId: providerConfig?.modelId,
          tools: providerConfig?.tools,
        });
        break;
      }
      case 'tavily': {
        result = await searchWithTavily({
          query: searchQuery.query,
          apiKey,
          baseUrl,
        });
        break;
      }
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
    log.error(`Web search failed [query="${query?.substring(0, 60) ?? 'unknown'}"]:`, err);
    const message = err instanceof Error ? err.message : 'Web search failed';
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
