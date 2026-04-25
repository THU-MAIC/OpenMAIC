/**
 * Claude Web Search Integration
 *
 * Uses the AI SDK Anthropic provider with the native web_search_20260209 tool.
 */

import { generateText } from 'ai';
import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { createLogger } from '@/lib/logger';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

type ToolDef = { type: string; name: string };

const DEFAULT_TOOLS: ToolDef[] = [{ type: 'web_search_20260209', name: 'web_search' }];

function buildTools(provider: AnthropicProvider, configuredTools?: ToolDef[]) {
  const defs = configuredTools?.length ? configuredTools : DEFAULT_TOOLS;
  return Object.fromEntries(
    defs.map((t) =>
      t.type === 'web_search_20250305'
        ? [t.name, provider.tools.webSearch_20250305()]
        : [t.name, provider.tools.webSearch_20260209()],
    ),
  );
}

/**
 * Wraps proxyFetch to inject `allowed_callers: ["direct"]` on every tool in outgoing
 * Anthropic API requests. The AI SDK's provider-defined tool serialisation hard-codes the
 * tool object and never emits `allowed_callers`, so we must patch it at the fetch layer.
 */
async function fetchWithAllowedCallers(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST' && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      if (Array.isArray(body?.tools)) {
        const before = body.tools.map((t: Record<string, unknown>) => t.allowed_callers);
        body.tools = body.tools.map((tool: Record<string, unknown>) =>
          tool.allowed_callers ? tool : { ...tool, allowed_callers: ['direct'] },
        );
        const after = body.tools.map((t: Record<string, unknown>) => t.allowed_callers);
        log.debug(
          `fetchWithAllowedCallers: injecting allowed_callers url: ${url}, before: ${before}, after: ${after}`,
        );
        init = { ...init, body: JSON.stringify(body) };
      } else {
        log.debug(`fetchWithAllowedCallers: POST to ${url} — no tools array in body`);
      }
      log.debug(`final payload: ${JSON.stringify(body)}`);
    } catch {
      /* leave body unchanged if it can't be parsed */
    }
  } else {
    log.info(
      `fetchWithAllowedCallers: called [method=${init?.method} bodyType=${typeof init?.body}]`,
    );
  }
  return proxyFetch(url, init);
}

const PAGE_CONTENT_MAX_LENGTH = 2000;
const PAGE_FETCH_TIMEOUT_MS = 5000;

const log = createLogger('ClaudeSearch');

/** Fetch a URL and return plain text extracted from its HTML. Returns empty string on any failure. */
async function fetchPageContent(url: string): Promise<string> {
  const ssrfError = await validateUrlForSSRF(url);
  if (ssrfError) {
    log.warn(`Blocked page fetch due to SSRF check [url="${url}" reason="${ssrfError}"]`);
    return '';
  }
  log.info(`Fetching page content: ${url}`);
  try {
    const res = await proxyFetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; OpenMAIC/1.0)' },
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(`Failed to fetch page content [url="${url}" status=${res.status}]`);
      return '';
    }
    const html = await res.text();
    // Strip scripts, styles, and all tags; collapse whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const content = text.slice(0, PAGE_CONTENT_MAX_LENGTH);
    log.info(`Fetched page content [url="${url}" chars=${content.length}]`);
    return content;
  } catch (e) {
    log.warn(`Error fetching page content [url="${url}"]:`, e);
    return '';
  }
}

/**
 * Search the web using Claude's native web search tool via the AI SDK.
 */
export async function searchWithClaude(params: {
  query: string;
  apiKey: string;
  modelId?: string;
  baseUrl: string;
  tools?: ToolDef[];
}): Promise<WebSearchResult> {
  const { query, apiKey, modelId: rawModelId, baseUrl, tools } = params;
  const modelId = rawModelId?.trim() || 'claude-sonnet-4-6';

  const provider = createAnthropic({
    apiKey,
    baseURL: baseUrl,
    fetch: fetchWithAllowedCallers as typeof fetch,
  });

  try {
    const startTime = Date.now();

    const result = await generateText({
      model: provider(modelId),
      messages: [
        {
          role: 'user',
          content: `Search for the following and provide a comprehensive summary with source links: ${query}.`,
        },
      ],
      maxOutputTokens: 4096,
      tools: buildTools(provider, tools),
    });

    // The AI SDK surfaces web search results as sources (url + title only; no snippet content).
    // We fetch each page to populate content, then drop any that fail.
    const sources: WebSearchSource[] = result.sources.flatMap((s) => {
      if (s.sourceType !== 'url') return [];
      return [{ url: s.url, title: s.title || s.url, content: '' }];
    });

    await Promise.all(
      sources.map(async (s) => {
        s.content = await fetchPageContent(s.url);
      }),
    );

    const sourcesWithContent = sources.filter((s) => s.content);

    return {
      answer: result.text,
      sources: sourcesWithContent,
      query,
      responseTime: Date.now() - startTime,
    };
  } catch (e) {
    log.error('Claude search failed', e);
    throw e;
  }
}

/**
 * Reuse formatting logic from Tavily.
 */
export { formatSearchResultsAsContext } from './tavily';
