/**
 * `web_search` for the agent runtime — capability-registered.
 *
 * The tool exists in the toolset exactly when this deployment has a working
 * web-search provider (the app's own server-side resolution: server-providers.yml
 * / WEB_SEARCH_* env). There is no per-session switch: a modern agent decides
 * for itself when a search is worth calling, and an unconfigured deployment
 * simply does not register the tool — the only form of "unavailable" a model
 * cannot misread.
 */
import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';

export interface WebSearchCapability {
  providerId: Parameters<typeof searchWeb>[0]['providerId'];
  apiKey: string;
  baseUrl?: string;
}

/** This deployment's web-search capability, or null when unconfigured. */
export function resolveWebSearchCapability(): WebSearchCapability | null {
  // The resolver's own per-provider rules decide usability — including
  // keyless providers (brave/searxng carry no apiKey by definition) and the
  // capability force-off plumbing (a disabled-only config resolves to nothing).
  // An extra non-empty-key check here would silently unregister web_search on
  // exactly the keyless deployments.
  const config = resolveClassroomWebSearchConfig({});
  if (!config) return null;
  return {
    providerId: config.providerId,
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  };
}

const SEARCH_SCHEMA = Type.Object({
  query: Type.String({ description: 'The search query, in the language of the course.' }),
});

export function buildWebSearchTool(
  capability: WebSearchCapability,
  onUrlsObserved?: (urls: string[]) => Promise<void>,
): AgentTool<never, never> {
  const tool: AgentTool<typeof SEARCH_SCHEMA, unknown> = {
    name: 'web_search',
    label: 'Search the web',
    description:
      'Search the web for current or factual information. Use it when the course topic needs facts ' +
      'you cannot be sure of (recent events, exact figures, product details), not for things you ' +
      'already know. Prefer one precise query over several vague ones.',
    parameters: SEARCH_SCHEMA,
    async execute(_id, params: Static<typeof SEARCH_SCHEMA>, signal) {
      // The abort signal is the pi loop's per-run signal (the same one
      // agent.abort() fires); the provider fetch below carries it too, so an
      // in-flight request is cut short rather than merely abandoned.
      if (signal?.aborted) throw new Error('aborted');
      const result = await searchWeb({
        providerId: capability.providerId,
        query: params.query,
        apiKey: capability.apiKey,
        ...(capability.baseUrl ? { baseUrl: capability.baseUrl } : {}),
        ...(signal ? { signal } : {}),
      });
      if (signal?.aborted) throw new Error('aborted');
      // Every result URL is registered with the session's durable session-urls
      // store before the tool result is returned (reference semantics): the
      // registration is awaited, so a store failure fails this tool call
      // rather than silently returning results the trust gate cannot back.
      await onUrlsObserved?.(result.sources.map((source) => source.url));
      const context = formatSearchResultsAsContext(result);
      return {
        content: [
          {
            type: 'text',
            text: context || `No results for "${params.query}".`,
          },
        ],
        details: { query: params.query, sources: result.sources.length },
      };
    },
  };
  return tool as unknown as AgentTool<never, never>;
}

/**
 * The prompt block, present exactly when the tool is. Guidance on WHEN to
 * search, not a report that somebody asked for it.
 */
export function searchPromptBlock(): string {
  return [
    '## Web search',
    '',
    'You have `web_search`. Use it when the topic needs facts you cannot be sure of — recent',
    'developments, exact figures, version-specific behaviour — and skip it for timeless material.',
    'Cite what you use in the page content naturally; do not dump raw URLs at the learner.',
  ].join('\n');
}
