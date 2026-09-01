import type { ThinkingEffort, ModelInfo } from '@/lib/types/provider';
import type {
  CodexAccountInfo,
  CodexLoginStart,
  CodexProviderStatus,
  CodexRateLimitSnapshot,
} from '@/lib/types/codex';
import { getCodexAppServer, type CodexAppServer } from './app-server-client';

interface AccountReadResponse {
  account: CodexAccountInfo | null;
  requiresOpenaiAuth: boolean;
}

interface AppServerModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
  inputModalities: string[];
}

interface ModelListResponse {
  data: AppServerModel[];
  nextCursor: string | null;
}

interface RateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot | undefined> | null;
}

const OPENMAIC_THINKING_EFFORTS = new Set<ThinkingEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export function isCodexProviderEnabled(): boolean {
  return process.env.CODEX_PROVIDER_ENABLED?.trim().toLowerCase() === 'true';
}

export function assertCodexProviderEnabled(): void {
  if (!isCodexProviderEnabled()) {
    throw new Error('Codex subscription provider is disabled by the server operator.');
  }
}

function toModelInfo(model: AppServerModel): ModelInfo {
  const effortValues = model.supportedReasoningEfforts
    .map(({ reasoningEffort }) => reasoningEffort)
    .filter((effort): effort is ThinkingEffort =>
      OPENMAIC_THINKING_EFFORTS.has(effort as ThinkingEffort),
    );
  const defaultEffort = OPENMAIC_THINKING_EFFORTS.has(
    model.defaultReasoningEffort as ThinkingEffort,
  )
    ? (model.defaultReasoningEffort as ThinkingEffort)
    : effortValues[0];

  return {
    id: model.model || model.id,
    name: model.displayName || model.model || model.id,
    source: 'probed',
    capabilities: {
      streaming: true,
      tools: false,
      vision: model.inputModalities.includes('image'),
      ...(effortValues.length > 0
        ? {
            thinking: {
              control: 'effort' as const,
              requestAdapter: 'none' as const,
              effortValues,
              defaultEffort,
              toggleable: false,
              budgetAdjustable: true,
              defaultEnabled: true,
            },
          }
        : {}),
    },
  };
}

async function listModels(client: CodexAppServer): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  let cursor: string | null = null;

  do {
    const response: ModelListResponse = await client.request<ModelListResponse>('model/list', {
      cursor,
      limit: 100,
      includeHidden: false,
    });
    models.push(...response.data.filter((model) => !model.hidden).map(toModelInfo));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
}

export async function readCodexAccount(
  client: CodexAppServer = getCodexAppServer(),
): Promise<CodexAccountInfo | null> {
  assertCodexProviderEnabled();
  const response = await client.request<AccountReadResponse>('account/read', {
    refreshToken: false,
  });
  return response.account;
}

export async function requireCodexChatgptAccount(
  client: CodexAppServer = getCodexAppServer(),
): Promise<CodexAccountInfo> {
  const account = await readCodexAccount(client);
  if (account?.type !== 'chatgpt') {
    throw new Error('Sign in with ChatGPT in the Codex provider settings before generating.');
  }
  return account;
}

export async function readCodexProviderStatus(
  client: CodexAppServer = getCodexAppServer(),
): Promise<CodexProviderStatus> {
  if (!isCodexProviderEnabled()) {
    return { enabled: false, account: null, rateLimits: null, models: [] };
  }

  const account = await readCodexAccount(client);
  if (account?.type !== 'chatgpt') {
    return { enabled: true, account, rateLimits: null, models: [] };
  }

  const [modelResult, limitResult] = await Promise.allSettled([
    listModels(client),
    client.request<RateLimitsResponse>('account/rateLimits/read'),
  ]);
  if (modelResult.status === 'rejected') throw modelResult.reason;
  const limits = limitResult.status === 'fulfilled' ? limitResult.value : null;

  return {
    enabled: true,
    account,
    rateLimits: limits?.rateLimitsByLimitId?.codex ?? limits?.rateLimits ?? null,
    models: modelResult.value,
  };
}

export async function startCodexLogin(
  mode: 'browser' | 'device' = 'browser',
  client: CodexAppServer = getCodexAppServer(),
): Promise<CodexLoginStart> {
  assertCodexProviderEnabled();
  if (mode === 'device') {
    return client.request<CodexLoginStart>('account/login/start', {
      type: 'chatgptDeviceCode',
    });
  }
  return client.request<CodexLoginStart>('account/login/start', {
    type: 'chatgpt',
    useHostedLoginSuccessPage: true,
    appBrand: 'chatgpt',
  });
}

export async function logoutCodexAccount(
  client: CodexAppServer = getCodexAppServer(),
): Promise<void> {
  assertCodexProviderEnabled();
  await client.request('account/logout');
}
