import {
  resolveServerWebSearchProviderId,
  resolveWebSearchApiKey,
  resolveWebSearchBaseUrl,
} from '@/lib/server/provider-config';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';

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
}): { providerId: WebSearchProviderId; apiKey: string; baseUrl?: string } | undefined {
  const requestedProviderId = assertWebSearchProviderId(input.webSearchProviderId)
    ? input.webSearchProviderId
    : undefined;
  const providerId =
    requestedProviderId ?? (resolveServerWebSearchProviderId() as WebSearchProviderId | undefined);
  if (!providerId) return undefined;

  const apiKey = resolveWebSearchApiKey(providerId, input.webSearchApiKey);
  if (!apiKey) return undefined;

  return {
    providerId,
    apiKey,
    baseUrl: resolveWebSearchBaseUrl(providerId),
  };
}
