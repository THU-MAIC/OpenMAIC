import {
  resolveServerWebSearchProviderId,
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveWebSearchApiKey,
  resolveWebSearchBaseUrl,
  resolveWebSearchModel,
} from '@/lib/server/provider-config';
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import {
  RequestedProviderRefusedError,
  resolveMediaSlot,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import { apiError } from '@/lib/server/api-response';
import { SlotDisabledError, SlotUnassignedError } from '@/lib/server/model-config/runtime';
import type { searchWeb } from '@/lib/web-search';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';

const OFFICIAL_CLIENT_BASE_URLS: Record<WebSearchProviderId, string[]> = {
  tavily: ['https://api.tavily.com', 'https://api.tavily.com/search'],
  exa: ['https://api.exa.ai', 'https://api.exa.ai/search'],
  firecrawl: ['https://api.firecrawl.dev', 'https://api.firecrawl.dev/v2/search'],
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

/**
 * Base URLs that a built-in token plan writes into client settings are curated
 * in-repo endpoints too, so applying a plan never produces a rejected config.
 */
function tokenPlanClientBaseUrls(providerId: WebSearchProviderId): string[] {
  return TOKEN_PLAN_PRESETS.flatMap((preset) => {
    const target = preset.modalities.webSearch;
    return target?.providerId === providerId ? [target.baseUrl] : [];
  });
}

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

  const allowed = [
    ...OFFICIAL_CLIENT_BASE_URLS[providerId],
    ...tokenPlanClientBaseUrls(providerId),
  ].map(normalizeBaseUrl);
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

export interface RequestedWebSearch {
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  webSearchBaseUrl?: string;
  webSearchModelId?: string;
  baiduSubSources?: BaiduSubSources;
}

/** What searchWeb needs besides the query. */
export type WebSearchConfig = Omit<Parameters<typeof searchWeb>[0], 'query' | 'apiKey'> & {
  apiKey: string;
};

/** Why a resolved web search provider cannot be used, in the route's terms. */
export class WebSearchConfigError extends Error {
  constructor(
    readonly code: 'MISSING_API_KEY' | 'MISSING_REQUIRED_FIELD' | 'INVALID_REQUEST',
    message: string,
    readonly providerId?: WebSearchProviderId,
  ) {
    super(message);
    this.name = 'WebSearchConfigError';
  }
}

interface LegacySearchRules {
  /** Refuse a force-disabled provider (403) instead of skipping it. */
  refuseDisabled?: boolean;
  /**
   * Prefer the operator's configured backend over an unmanaged request
   * choice, as the 1.1.x `/api/web-search` route did; classroom search honored the
   * request's own provider and key.
   */
  preferServerProvider?: boolean;
  /**
   * The provider a request that names none means, after the server's own
   * (the 1.1.x `/api/web-search` route searched with one, using the request's key).
   */
  fallbackProviderId?: WebSearchProviderId;
}

/** The search model a request names the old way, under the server's pins (one provider has models). */
function requestedSearchModel(
  providerId: WebSearchProviderId,
  input: RequestedWebSearch,
): string | undefined {
  return providerId === 'claude'
    ? resolveWebSearchModel(providerId, input.webSearchModelId)
    : undefined;
}

/**
 * The provider a request names the old way (deprecated), with its key and base
 * URL for an unmanaged provider, under the caller's legacy rules.
 */
function requestedWebSearchConnection(
  input: RequestedWebSearch,
  { refuseDisabled = false, preferServerProvider = false, fallbackProviderId }: LegacySearchRules,
): MediaConnection | undefined {
  const serverProviderId = resolveServerWebSearchProviderId() as WebSearchProviderId | undefined;
  const requested = assertWebSearchProviderId(input.webSearchProviderId)
    ? input.webSearchProviderId
    : fallbackProviderId && (serverProviderId ?? fallbackProviderId);
  if (!requested) return undefined;
  let providerId: WebSearchProviderId = requested;
  if (
    preferServerProvider &&
    serverProviderId &&
    isServerConfiguredProvider('webSearch', serverProviderId) &&
    providerId !== serverProviderId &&
    !isServerConfiguredProvider('webSearch', providerId)
  ) {
    providerId = serverProviderId;
  }
  // A force-disabled provider is off for everyone (#665): refused, or passed
  // over for the server's own default where the caller simply skips search.
  if (isServerProviderDisabled('webSearch', providerId)) {
    if (!refuseDisabled) return undefined;
    throw new RequestedProviderRefusedError(
      apiError('PROVIDER_DISABLED', 403, 'This web search provider is disabled by the server'),
    );
  }
  const managed = isServerConfiguredProvider('webSearch', providerId);
  // SearXNG base URLs are operator-managed only; never trust client input.
  const clientBaseUrl = managed || providerId === 'searxng' ? undefined : input.webSearchBaseUrl;
  const baseUrl = resolveWebSearchRouteBaseUrl(providerId, clientBaseUrl);
  const model = requestedSearchModel(providerId, input);
  return {
    providerId,
    apiKey: resolveWebSearchApiKey(providerId, managed ? undefined : input.webSearchApiKey),
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { modelId: model } : {}),
    managed,
    userEndpoint: Boolean(clientBaseUrl?.trim()),
    origin: 'request',
  };
}

/**
 * The search configuration for a resolved connection. A base URL from a
 * workspace provider is held to the same official endpoints as a client one
 * (SearXNG aside, which the workspace names itself and resolveMediaSlot checks).
 */
export function webSearchConfigFromConnection(
  connection: MediaConnection,
  requested: RequestedWebSearch = {},
): WebSearchConfig {
  if (!assertWebSearchProviderId(connection.providerId)) {
    throw new WebSearchConfigError('INVALID_REQUEST', 'Unsupported web search provider');
  }
  const providerId = connection.providerId;
  const provider = WEB_SEARCH_PROVIDERS[providerId];
  const apiKey = connection.apiKey ?? '';
  if (provider.requiresApiKey && !apiKey) {
    throw new WebSearchConfigError(
      'MISSING_API_KEY',
      `${provider.name} API key is not configured.`,
      providerId,
    );
  }
  let baseUrl = connection.baseUrl;
  if (
    connection.origin === 'configuration' &&
    !connection.managed &&
    baseUrl &&
    // A provider the operator must point at (self-hosted search) has no
    // official endpoint to hold a user-typed one to.
    !provider.requiresBaseUrl
  ) {
    baseUrl = resolveSafeClientWebSearchBaseUrl(providerId, baseUrl);
  }
  if (provider.requiresBaseUrl && !baseUrl) {
    throw new WebSearchConfigError(
      'MISSING_REQUIRED_FIELD',
      `${provider.name} needs a base URL.`,
      providerId,
    );
  }
  // On the legacy default provider the request's model still applies through
  // its allowlist, as before slots.
  const model =
    connection.origin === 'default'
      ? requestedSearchModel(providerId, requested)
      : connection.modelId;
  return {
    providerId,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(requested.baiduSubSources ? { baiduSubSources: requested.baiduSubSources } : {}),
    ...(model ? { claudeModelId: model } : {}),
  };
}

/**
 * The web search connection for a workspace: the webSearch slot, else the
 * provider a request names (deprecated), else the server's configured one.
 * Throws what resolveMediaSlot throws (turned off, unassigned) and
 * WebSearchConfigError.
 */
export async function resolveWebSearchConnection(
  workspaceId: string | null,
  requested: RequestedWebSearch = {},
  rules: LegacySearchRules = {},
): Promise<WebSearchConfig> {
  const connection = await resolveMediaSlot('webSearch', {
    workspaceId,
    legacyRequest: async () => requestedWebSearchConnection(requested, rules),
  });
  return webSearchConfigFromConnection(connection, requested);
}

/**
 * {@link resolveWebSearchConnection} for work that simply skips search when it
 * is unavailable: undefined when the slot is off, unassigned or incomplete.
 * An invalid base URL still throws.
 */
export async function resolveClassroomWebSearchConfig(
  workspaceId: string | null,
  requested: RequestedWebSearch = {},
): Promise<WebSearchConfig | undefined> {
  try {
    return await resolveWebSearchConnection(workspaceId, requested);
  } catch (error) {
    if (error instanceof SlotDisabledError || error instanceof SlotUnassignedError)
      return undefined;
    if (error instanceof WebSearchConfigError && error.code !== 'INVALID_REQUEST') return undefined;
    throw error;
  }
}
