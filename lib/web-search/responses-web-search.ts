import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const RESPONSES_WEB_SEARCH_MAX_QUERY_LENGTH = 400;
const RESPONSES_WEB_SEARCH_TIMEOUT_MS = 20_000;

type ResponsesWebSearchResponse = {
  error?: { message?: string } | null;
  output?: Array<{
    type?: string;
    status?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ title?: string; url?: string }>;
    }>;
  }>;
  status?: string;
};

function hasCompletedWebSearchCall(data: ResponsesWebSearchResponse): boolean {
  return (data.output || []).some(
    (item) => item.type === 'web_search_call' && item.status === 'completed',
  );
}

function buildResponsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Responses web search base URL is required');
  return trimmed.endsWith('/responses') ? trimmed : `${trimmed}/responses`;
}

function extractOutputText(data: ResponsesWebSearchResponse): string {
  return (data.output || [])
    .filter((item) => item.type === 'message' || item.type == null)
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
    .map((content) => content.text?.trim() || '')
    .filter(Boolean)
    .join('\n\n');
}

function validHttpUrl(urlValue: string): string | undefined {
  try {
    const parsed = new URL(urlValue);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? urlValue : undefined;
  } catch {
    return undefined;
  }
}

function cleanFreeTextUrl(urlValue: string): string {
  let cleaned = urlValue.trim().replace(/[.,;:。，；：】`]+$/, '');
  while (cleaned.endsWith(')')) {
    const opens = [...cleaned].filter((char) => char === '(').length;
    const closes = [...cleaned].filter((char) => char === ')').length;
    if (closes <= opens) break;
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

function extractSources(
  data: ResponsesWebSearchResponse,
  answer: string,
  maxResults: number,
): WebSearchSource[] {
  const sources = new Map<string, WebSearchSource>();
  const addSource = (urlValue: string, titleValue?: string, structured = false) => {
    const candidate = structured ? urlValue.trim() : cleanFreeTextUrl(urlValue);
    const exactUrl = validHttpUrl(candidate);
    if (!exactUrl || sources.has(exactUrl)) return;
    sources.set(exactUrl, {
      title: titleValue?.trim() || new URL(exactUrl).hostname,
      url: exactUrl,
      content: 'Referenced by the Responses API web-search result.',
      score: 1,
    });
  };

  for (const item of data.output || []) {
    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) {
        // Annotation URLs are structured provider data. Preserve their exact value;
        // punctuation cleanup is only safe for URLs discovered in free-form text.
        if (annotation.url) addSource(annotation.url, annotation.title, true);
      }
    }
  }

  for (const match of answer.matchAll(/\[([^\]]+)]\((https?:\/\/[^\s]+)\)/g)) {
    addSource(match[2], match[1]);
  }
  for (const match of answer.matchAll(/https?:\/\/[^\s<>\]]+/g)) {
    addSource(match[0]);
  }

  return [...sources.values()].slice(0, maxResults);
}

function createRequestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Responses web search timed out', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

/**
 * Execute server-side web search through an OpenAI-compatible Responses API.
 * The deployment endpoint may be an official API or an OpenAI-compatible proxy;
 * the adapter contract is the Responses `web_search` tool, not a vendor identity.
 */
export async function searchWithResponsesWebSearch(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl: string;
  model: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<WebSearchResult> {
  const {
    query,
    apiKey,
    maxResults = 5,
    baseUrl,
    model,
    signal,
    timeoutMs = RESPONSES_WEB_SEARCH_TIMEOUT_MS,
  } = params;
  const startedAt = Date.now();
  const request = createRequestSignal(signal, timeoutMs);
  try {
    const res = await proxyFetch(buildResponsesUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [
          `Current date: ${new Date().toISOString()}.`,
          'Search the public web for the query below.',
          'You must use the web-search evidence; do not answer from a stale training cutoff.',
          'Return a concise factual answer and include the source URLs used.',
          'Prefer primary or authoritative sources. If the evidence is insufficient, say so explicitly.',
          `Query: ${query.trim().slice(0, RESPONSES_WEB_SEARCH_MAX_QUERY_LENGTH)}`,
        ].join('\n'),
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
      }),
      signal: request.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`Responses web search error (${res.status}): ${errorText || res.statusText}`);
    }

    const data = (await res.json()) as ResponsesWebSearchResponse;
    if (data.status && data.status !== 'completed') {
      throw new Error(
        `Responses web search did not complete: ${data.error?.message || data.status}`,
      );
    }
    if (!hasCompletedWebSearchCall(data)) {
      throw new Error('Responses web search returned no completed web_search_call');
    }

    const answer = extractOutputText(data);
    if (!answer) throw new Error('Responses web search returned no answer text');

    return {
      answer,
      sources: extractSources(data, answer, maxResults),
      query,
      responseTime: (Date.now() - startedAt) / 1000,
    };
  } finally {
    request.cleanup();
  }
}
