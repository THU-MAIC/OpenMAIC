/**
 * Research: search the web for a course requirement, the query first
 * rewritten from the requirement and an excerpt of the material when a
 * rewrite model is available. The logic of 1.1.x's POST /api/web-search; the
 * caller resolves the webSearch slot and the rewrite model.
 */
import type { AICallFn } from '@openmaic/generation';

import { callLLM } from '@/lib/ai/llm';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import type { WebSearchResult } from '@/lib/types/web-search';
import {
  buildSearchQuery,
  SEARCH_QUERY_REWRITE_EXCERPT_LENGTH,
} from '@/lib/server/search-query-builder';
import type { WebSearchConfig } from '@/lib/server/web-search-config';

import type { StepContext, StepLanguageModel } from './context';

export interface ResearchInput {
  /** The course requirement to research. */
  query: string;
  /** The material's text, of which an excerpt informs the query rewrite. */
  pdfText?: string;
  /** The resolved webSearch slot. */
  config: WebSearchConfig;
  /** The model that rewrites the query; without one the raw requirement is searched. */
  rewriteModel?: Pick<StepLanguageModel, 'model' | 'thinkingConfig' | 'serverManaged'>;
}

export interface ResearchResult extends WebSearchResult {
  /** The results formatted as prompt context for the outline. */
  context: string;
}

export async function research(input: ResearchInput, ctx: StepContext): Promise<ResearchResult> {
  // Only an excerpt informs the rewrite, however much material there is.
  const boundedPdfText = input.pdfText?.slice(0, SEARCH_QUERY_REWRITE_EXCERPT_LENGTH);

  const rewriteModel = input.rewriteModel;
  const aiCall: AICallFn | undefined = rewriteModel
    ? async (systemPrompt, userPrompt) => {
        const result = await callLLM(
          {
            model: rewriteModel.model,
            abortSignal: ctx.signal,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            maxOutputTokens: 256,
          },
          'web-search-query-rewrite',
          undefined,
          rewriteModel.thinkingConfig,
          { serverManaged: rewriteModel.serverManaged },
        );
        return result.text;
      }
    : undefined;

  const searchQuery = await buildSearchQuery(input.query, boundedPdfText, aiCall);

  ctx.log.info('Running web search API request', {
    hasPdfContext: searchQuery.hasPdfContext,
    rawRequirementLength: searchQuery.rawRequirementLength,
    rewriteAttempted: searchQuery.rewriteAttempted,
    finalQueryLength: searchQuery.finalQueryLength,
  });

  const result = await searchWeb({ ...input.config, query: searchQuery.query });
  const context = formatSearchResultsAsContext(result);

  return {
    answer: result.answer,
    sources: result.sources,
    context,
    query: result.query,
    responseTime: result.responseTime,
  };
}
