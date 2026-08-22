import {
  resolveServerWebSearchProviderId,
  isServerConfiguredProvider,
  resolveWebSearchApiKey,
  resolveWebSearchBaseUrl,
  resolveWebSearchModel,
} from '@/lib/server/provider-config';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';

const OFFICIAL_CLIENT_BASE_URLS: Record<WebSearchProviderId, string[]> = {
  tavily: ['https://api.tavily.com', 'https://api.tavily.com/search'],
  bocha: [
    'https://api.bocha.cn',
    'https://api.bocha.cn/v1',
    'https://api.bocha.cn/v1/web-search',
    'https://api.bochaai.com',
    'https://api.bochaai.com/v1',
    'https://api.bochaai.com/v1/web-search',
  ],
  brave: [
    'https://search.brave.com',
    'https://search.brave.com/search',
    'https://api.search.brave.com',
  ],
  baidu: ['https://qianfan.baidubce.com'],
  // The bare root is accepted for convenience; the Claude adapter normalizes it
  // to the /v1 root, since the AI SDK appends "/messages" to the base URL.
  claude: ['https://api.anthropic.com', 'https://api.anthropic.com/v1'],
  minimax: [
    'https://api.minimaxi.com',
    'https://api.minimaxi.com/v1',
    'https://api.minimaxi.com/v1/coding_plan',
    'https://api.minimaxi.com/v1/coding_plan/search',
    'https://api.minimax.io',
    'https://api.minimax.io/v1',
    'https://api.minimax.io/v1/coding_plan',
    'https://api.minimax.io/v1/coding_plan/search',
  ],
  doubao: ['https://open.feedcoopapi.com', 'https://open.feedcoopapi.com/search_api/web_search'],
  searxng: [],
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function assertWebSearchProviderId(
  providerId: string | undefined,
): providerId is WebSearchProviderId {
  return !!providerId && providerId in WEB_SEARCH_PROVIDERS;
}

export function resolveSafeClientWebSearchBaseUrl(
  providerId: WebSearchProviderId,
  clientBaseUrl?: string,
): string | undefined {
  const trimmed = clientBaseUrl?.trim();
  if (!trimmed) return undefined;

  let normalized: string;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid protocol');
    }
    normalized = normalizeBaseUrl(parsed.toString());
  } catch {
    throw new Error(`Unsupported ${WEB_SEARCH_PROVIDERS[providerId].name} base URL`);
  }

  const allowed = OFFICIAL_CLIENT_BASE_URLS[providerId].map(normalizeBaseUrl);
  if (!allowed.includes(normalized)) {
    throw new Error(`Unsupported ${WEB_SEARCH_PROVIDERS[providerId].name} base URL`);
  }
  return normalized;
}

export function resolveWebSearchRouteBaseUrl(
  providerId: WebSearchProviderId,
  clientBaseUrl?: string,
): string | undefined {
  const safeClientBaseUrl = resolveSafeClientWebSearchBaseUrl(providerId, clientBaseUrl);
  return resolveWebSearchBaseUrl(providerId, safeClientBaseUrl);
}

export function resolveClassroomWebSearchConfig(input: {
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  webSearchBaseUrl?: string;
  webSearchModelId?: string;
  baiduSubSources?: BaiduSubSources;
}):
  | {
      providerId: WebSearchProviderId;
      apiKey: string;
      baseUrl?: string;
      baiduSubSources?: BaiduSubSources;
      claudeModelId?: string;
    }
  | undefined {
  const requestedProviderId = assertWebSearchProviderId(input.webSearchProviderId)
    ? input.webSearchProviderId
    : undefined;
  const providerId =
    requestedProviderId ?? (resolveServerWebSearchProviderId() as WebSearchProviderId | undefined);
  if (!providerId) return undefined;

  const provider = WEB_SEARCH_PROVIDERS[providerId];
  const apiKey = resolveWebSearchApiKey(providerId, input.webSearchApiKey);
  if (provider.requiresApiKey && !apiKey) return undefined;

  const managed = isServerConfiguredProvider('webSearch', providerId);
  const clientBaseUrl = managed || providerId === 'searxng' ? undefined : input.webSearchBaseUrl;
  const baseUrl = resolveWebSearchRouteBaseUrl(providerId, clientBaseUrl);
  if (provider.requiresBaseUrl && !baseUrl) return undefined;

  return {
    providerId,
    apiKey,
    baseUrl,
    ...(providerId === 'baidu' && input.baiduSubSources
      ? { baiduSubSources: input.baiduSubSources }
      : {}),
    ...(providerId === 'claude'
      ? { claudeModelId: resolveWebSearchModel('claude', input.webSearchModelId) }
      : {}),
  };
}
