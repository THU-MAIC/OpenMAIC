import { searchWithBaidu } from './baidu';
import { searchWithBocha } from './bocha';
import { searchWithBrave } from './brave';
import { searchWithClaude } from './claude';
import { searchWithDoubao } from './doubao';
import { searchWithMiniMax } from './minimax';
import { searchWithSearxng } from './searxng';
import { searchWithTavily } from './tavily';
import type { WebSearchResult } from '@/lib/types/web-search';
import type { BaiduSubSources, WebSearchProviderId } from './types';

export { formatSearchResultsAsContext } from './format';

export async function searchWeb(params: {
  providerId: WebSearchProviderId;
  query: string;
  apiKey?: string;
  maxResults?: number;
  baseUrl?: string;
  baiduSubSources?: BaiduSubSources;
  claudeModelId?: string;
}): Promise<WebSearchResult> {
  const {
    providerId,
    query,
    apiKey = '',
    maxResults,
    baseUrl,
    baiduSubSources,
    claudeModelId,
  } = params;

  switch (providerId) {
    case 'baidu':
      return searchWithBaidu({ query, apiKey, maxResults, baseUrl, subSources: baiduSubSources });
    case 'bocha':
      return searchWithBocha({ query, apiKey, maxResults, baseUrl });
    case 'brave':
      return searchWithBrave({ query, apiKey: apiKey || undefined, maxResults, baseUrl });
    case 'claude':
      return searchWithClaude({ query, apiKey, modelId: claudeModelId, baseUrl, maxResults });
    case 'doubao':
      return searchWithDoubao({ query, apiKey, maxResults, baseUrl });
    case 'minimax':
      return searchWithMiniMax({ query, apiKey, maxResults, baseUrl });
    case 'searxng':
      return searchWithSearxng({ query, maxResults, baseUrl });
    case 'tavily':
      return searchWithTavily({ query, apiKey, maxResults, baseUrl });
    default: {
      const exhaustive: never = providerId;
      throw new Error(`Unsupported web search provider: ${exhaustive}`);
    }
  }
}
