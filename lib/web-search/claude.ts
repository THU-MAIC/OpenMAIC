/**
 * Claude Web Search integration.
 *
 * Uses the AI SDK Anthropic provider with Anthropic's native server-side
 * web_search tool: Claude runs the searches and the adapter returns the
 * model's synthesized answer plus its cited sources. Result pages are never
 * fetched by this server — the answer already incorporates their content,
 * and a page-content enrichment fetch would be an SSRF vector.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { callLLM } from '@/lib/ai/llm';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { createLogger } from '@/lib/logger';
import { CLAUDE_WEB_SEARCH_DEFAULT_MODEL, WEB_SEARCH_PROVIDERS } from './constants';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const CLAUDE_MAX_OUTPUT_TOKENS = 4096;

/** Anthropic's basic web-search tool, for models without dynamic filtering. */
const BASIC_WEB_SEARCH_TOOL_TYPE = 'web_search_20250305';

const CLAUDE_DEFAULT_BASE_URL = WEB_SEARCH_PROVIDERS.claude.defaultBaseUrl ?? '';

const log = createLogger('ClaudeSearch');

/**
 * Anthropic's dynamic-filtering web_search_20260209 tool is limited to the 4.6+
 * Opus/Sonnet models and the 5 series (Opus 5, Sonnet 5, Fable 5, Mythos 5).
 * Everything else — Haiku, Claude 4.5 and older (including dated ids such as
 * `claude-sonnet-4-20250514`), and any id we don't recognize — takes the basic
 * web_search_20250305 tool, which the newer models accept too.
 */
const DYNAMIC_WEB_SEARCH_MODEL =
  /^claude-(?:opus|sonnet)-4-[6-9](?:-|$)|^claude-(?:opus|sonnet|fable|mythos)-[5-9](?:-|$)/;

function usesBasicWebSearchTool(modelId: string): boolean {
  return !DYNAMIC_WEB_SEARCH_MODEL.test(modelId);
}

/**
 * The AI SDK serializes its provider-defined web_search tools without
 * `allowed_callers`, but Anthropic requires `allowed_callers: ["direct"]` on the
 * basic tool, whose models have no programmatic tool support (the request 400s
 * otherwise). Patch it into outgoing request bodies at the fetch layer. The
 * dynamic-filtering tool is left alone: it runs searches through the
 * code-execution caller, which pinning to "direct" would disable.
 */
async function fetchWithAllowedCallers(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST' && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      if (Array.isArray(body?.tools)) {
        let patched = false;
        body.tools = body.tools.map((tool: Record<string, unknown>) => {
          if (tool.type !== BASIC_WEB_SEARCH_TOOL_TYPE || tool.allowed_callers) return tool;
          patched = true;
          return { ...tool, allowed_callers: ['direct'] };
        });
        if (patched) init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      /* leave body unchanged if it can't be parsed */
    }
  }
  return proxyFetch(url, init);
}

/**
 * `@ai-sdk/anthropic` appends `/messages` to the base URL verbatim, so the bare
 * Anthropic root would request `https://api.anthropic.com/messages` and 404.
 * Both Settings and the server allowlist accept that form, so restore the
 * versioned root before handing it to the SDK. Other hosts (self-hosted
 * gateways) are passed through untouched.
 */
function resolveClaudeBaseUrl(baseUrl?: string): string {
  const normalized = (baseUrl || CLAUDE_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const official = new URL(CLAUDE_DEFAULT_BASE_URL);
    if (parsed.origin === official.origin && parsed.pathname === '/') {
      return CLAUDE_DEFAULT_BASE_URL;
    }
  } catch {
    /* unparsable base URL: leave it for the SDK to surface */
  }
  return normalized;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Search the web using Claude's native web search tool via the AI SDK.
 */
export async function searchWithClaude(params: {
  query: string;
  apiKey: string;
  modelId?: string;
  baseUrl?: string;
  maxResults?: number;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const { query, maxResults } = params;
  const modelId = params.modelId?.trim() || CLAUDE_WEB_SEARCH_DEFAULT_MODEL;
  // Keys and URLs are pasted by hand into Settings; surrounding whitespace
  // would otherwise be sent verbatim and come back as "invalid x-api-key".
  const apiKey = params.apiKey.trim();
  const baseUrl = params.baseUrl?.trim();

  const provider = createAnthropic({
    apiKey,
    baseURL: resolveClaudeBaseUrl(baseUrl),
    fetch: fetchWithAllowedCallers as typeof fetch,
  });

  const toolArgs = maxResults && maxResults > 0 ? { maxUses: maxResults } : {};
  const webSearch = usesBasicWebSearchTool(modelId)
    ? provider.tools.webSearch_20250305(toolArgs)
    : provider.tools.webSearch_20260209(toolArgs);

  const startTime = Date.now();
  try {
    const result = await callLLM(
      {
        model: provider(modelId),
        messages: [
          {
            role: 'user',
            content: `Search for the following and provide a comprehensive summary with source links: ${query}.`,
          },
        ],
        maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
        tools: { web_search: webSearch },
        ...(params.signal ? { abortSignal: params.signal } : {}),
      },
      'web-search-claude',
    );

    // The AI SDK surfaces the tool's citations as sources (url + title only).
    // Claude's answer already synthesizes the page contents, so sources are
    // returned as references, deduplicated by URL.
    const sources = new Map<string, WebSearchSource>();
    for (const source of result.sources) {
      if (source.sourceType !== 'url') continue;
      if (!isHttpUrl(source.url) || sources.has(source.url)) continue;
      sources.set(source.url, {
        title: source.title?.trim() || new URL(source.url).hostname,
        url: source.url,
        content: 'Referenced by the Claude web-search answer.',
        score: 1,
      });
    }

    return {
      answer: result.text,
      sources: [...sources.values()],
      query,
      // Seconds, matching every sibling adapter's WebSearchResult contract.
      responseTime: (Date.now() - startTime) / 1000,
    };
  } catch (e) {
    log.error(`Claude web search failed [model="${modelId}"]:`, e);
    throw e;
  }
}
