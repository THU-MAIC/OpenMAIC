import { parseJsonResponse } from '@/lib/generation/json-repair';
import { PROMPT_IDS, buildPrompt } from '@/lib/prompts';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import { createLogger } from '@/lib/logger';

const log = createLogger('SearchQueryBuilder');
const TAVILY_SOFT_MAX_QUERY_LENGTH = 350;
export const SEARCH_QUERY_REWRITE_EXCERPT_LENGTH = 7000;

interface SearchQueryRewriteResponse {
  query: string;
}

export interface SearchQueryBuildResult {
  query: string;
  rewriteAttempted: boolean;
  rawRequirementLength: number;
  finalQueryLength: number;
  hasPdfContext: boolean;
}

function normalizeSearchRequirement(requirement: string): string {
  return requirement.replace(/\s+/g, ' ').trim();
}

function normalizePdfExcerpt(pdfText?: string): string {
  if (!pdfText) {
    return '';
  }

  return pdfText.replace(/\s+/g, ' ').trim().slice(0, SEARCH_QUERY_REWRITE_EXCERPT_LENGTH);
}

function shouldRewriteSearchQuery(
  normalizedRequirement: string,
  normalizedPdfExcerpt: string,
): boolean {
  return normalizedRequirement.length > 400 || Boolean(normalizedPdfExcerpt);
}

export async function buildSearchQuery(
  requirement: string,
  pdfText: string | undefined,
  aiCall?: AICallFn,
): Promise<SearchQueryBuildResult> {
  const normalizedRequirement = normalizeSearchRequirement(requirement);
  const pdfExcerpt = normalizePdfExcerpt(pdfText);
  const hasPdfContext = Boolean(pdfExcerpt);
  const rewriteAttempted = shouldRewriteSearchQuery(normalizedRequirement, pdfExcerpt);

  const fallback = {
    query: normalizedRequirement,
    rewriteAttempted,
    rawRequirementLength: normalizedRequirement.length,
    finalQueryLength: normalizedRequirement.length,
    hasPdfContext,
  } satisfies SearchQueryBuildResult;

  if (!normalizedRequirement || !rewriteAttempted) {
    return fallback;
  }

  if (!aiCall) {
    log.warn('Query rewrite AI call unavailable, falling back to raw requirement');
    return fallback;
  }

  const prompts = buildPrompt(PROMPT_IDS.WEB_SEARCH_QUERY_REWRITE, {
    requirement: normalizedRequirement,
    pdfExcerpt: pdfExcerpt || 'None',
  });

  if (!prompts) {
    log.warn('Query rewrite prompt not found, falling back to raw requirement');
    return fallback;
  }

  try {
    const response = await aiCall(prompts.system, prompts.user);
    const parsed = parseJsonResponse<SearchQueryRewriteResponse>(response);
    const rewrittenQuery = normalizeSearchRequirement(parsed?.query || '').slice(
      0,
      TAVILY_SOFT_MAX_QUERY_LENGTH,
    );
    if (!rewrittenQuery) {
      log.warn('Query rewrite returned empty output, falling back to raw requirement');
      return fallback;
    }

    return {
      ...fallback,
      query: rewrittenQuery,
      finalQueryLength: rewrittenQuery.length,
    };
  } catch (error) {
    log.warn('Query rewrite failed, falling back to raw requirement:', error);
    return fallback;
  }
}
