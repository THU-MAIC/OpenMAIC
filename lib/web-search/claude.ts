/**
 * Claude Web Search Integration
 *
 * Uses Anthropic's Messages API with the built-in server-side web search tool.
 * Endpoint: POST https://api.anthropic.com/v1/messages
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Search the web using Claude's built-in web search tool.
 * Note: The API automatically executes searches server-side and synthesizes
 * an answer. We parse the message response to extract both.
 */
export async function searchWithClaude(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
}): Promise<WebSearchResult> {
  const { query, apiKey, maxResults = 5 } = params;
  const startTime = Date.now();

  const res = await proxyFetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-latest', // Anthropic recommended model for web search capabilities
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Search the web for the following query and provide a detailed summary of the findings: ${query}`,
        },
      ],
      tools: [
        {
          type: 'web_search_20250305', // Current stable server-side web search tool definition
          name: 'web_search',
        },
      ],
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Claude API error (${res.status}): ${errorText || res.statusText}`);
  }

  const data = (await res.json()) as {
    content?: Array<{
      type: string;
      text?: string;
      content?: Array<{
        type: string;
        uri?: string;
        url?: string;
        title?: string;
        cited_text?: string;
      }>;
    }>;
  };

  const responseTime = Date.now() - startTime;

  let answer = '';
  const sourcesMap = new Map<string, WebSearchSource>();

  // Parse Anthropic's multi-block message response
  if (data.content && Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        // Collect Claude's synthesized text response intent/answer
        answer += block.text + '\n';
      } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        // Extract URLs and titles from the server-executed search result blocks
        for (const result of block.content) {
          if (result.type === 'web_search_result') {
            const url = result.url || result.uri;
            if (url && !sourcesMap.has(url)) {
              sourcesMap.set(url, {
                title: result.title || 'Untitled',
                url: url,
                // Claude encrypts raw content snippets for security, so we extract cited text if available
                content: result.cited_text || '',
                score: 1, // Claude doesn't provide relevance scores
              });
            }
          }
        }
      }
    }
  }

  return {
    answer: answer.trim(),
    sources: Array.from(sourcesMap.values()).slice(0, maxResults),
    query,
    responseTime,
  };
}

/**
 * Format search results into a markdown context block for LLM prompts.
 */
export function formatClaudeSearchResultsAsContext(result: WebSearchResult): string {
  if (!result.answer && result.sources.length === 0) {
    return '';
  }

  const lines: string[] = [];

  if (result.answer) {
    lines.push(result.answer);
    lines.push('');
  }

  if (result.sources.length > 0) {
    lines.push('Sources:');
    for (const src of result.sources) {
      // Snippets aren't completely exposed by Anthropic by default, prioritize Title + URL
      const contextStr = src.content ? `: ${src.content.slice(0, 200)}` : '';
      lines.push(`- [${src.title}](${src.url})${contextStr}`);
    }
  }

  return lines.join('\n');
}
