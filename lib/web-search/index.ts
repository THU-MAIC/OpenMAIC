import { searchWithBocha } from './bocha';
import { searchWithTavily } from './tavily';
import type { WebSearchResult } from '@/lib/types/web-search';
import type { WebSearchProviderId } from './types';

export { formatSearchResultsAsContext } from './format';

export async function searchWeb(params: {
  providerId: WebSearchProviderId;
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
}): Promise<WebSearchResult> {
  const { providerId, query, apiKey, maxResults, baseUrl } = params;

  switch (providerId) {
    case 'bocha':
      return searchWithBocha({ query, apiKey, maxResults, baseUrl });
    case 'tavily':
      return searchWithTavily({ query, apiKey, maxResults, baseUrl });
    default: {
      const exhaustive: never = providerId;
      throw new Error(`Unsupported web search provider: ${exhaustive}`);
    }
  }
}
