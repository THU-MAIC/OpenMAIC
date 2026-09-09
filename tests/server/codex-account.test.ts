import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  logoutCodexAccount,
  readCodexProviderStatus,
  requireCodexChatgptAccount,
  startCodexLogin,
} from '@/lib/server/codex/account';
import type { CodexAppServer } from '@/lib/server/codex/app-server-client';

function fakeClient(responses: Record<string, unknown>): CodexAppServer & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push([method, params]);
      const response = responses[method];
      if (response instanceof Error) throw response;
      return response as T;
    },
    onNotification: () => () => undefined,
  };
}

describe('Codex account integration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('does not start App Server when the provider is disabled', async () => {
    vi.stubEnv('CODEX_PROVIDER_ENABLED', 'false');
    const client = fakeClient({});

    await expect(readCodexProviderStatus(client)).resolves.toEqual({
      enabled: false,
      account: null,
      rateLimits: null,
      models: [],
    });
    expect(client.calls).toHaveLength(0);
  });

  it('maps ChatGPT account, models, reasoning effort, vision, and rate limits', async () => {
    vi.stubEnv('CODEX_PROVIDER_ENABLED', 'true');
    const client = fakeClient({
      'account/read': {
        account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      },
      'model/list': {
        data: [
          {
            id: 'model-entry',
            model: 'gpt-5.6-sol',
            displayName: 'GPT-5.6 Sol',
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'high' },
              { reasoningEffort: 'ultra' },
            ],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
          },
          {
            id: 'hidden',
            model: 'hidden-model',
            displayName: 'Hidden',
            hidden: true,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text'],
          },
        ],
        nextCursor: null,
      },
      'account/rateLimits/read': {
        rateLimits: { limitId: 'fallback', primary: null, secondary: null },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            limitName: 'Codex',
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1234 },
            secondary: null,
          },
        },
      },
    });

    const status = await readCodexProviderStatus(client);

    expect(status.account).toMatchObject({ type: 'chatgpt', planType: 'plus' });
    expect(status.rateLimits).toMatchObject({ limitId: 'codex' });
    expect(status.models).toEqual([
      expect.objectContaining({
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        source: 'probed',
        capabilities: {
          streaming: true,
          tools: false,
          vision: true,
          thinking: expect.objectContaining({
            effortValues: ['low', 'high'],
            defaultEffort: 'high',
          }),
        },
      }),
    ]);
  });

  it('requires ChatGPT auth rather than API-key auth for subscription calls', async () => {
    vi.stubEnv('CODEX_PROVIDER_ENABLED', 'true');
    const client = fakeClient({
      'account/read': { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
    });

    await expect(requireCodexChatgptAccount(client)).rejects.toThrow(/Sign in with ChatGPT/);
  });

  it('does not report the provider as usable when model discovery fails', async () => {
    vi.stubEnv('CODEX_PROVIDER_ENABLED', 'true');
    const client = fakeClient({
      'account/read': {
        account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      },
      'model/list': new Error('model discovery failed'),
      'account/rateLimits/read': { rateLimits: null, rateLimitsByLimitId: null },
    });

    await expect(readCodexProviderStatus(client)).rejects.toThrow('model discovery failed');
  });

  it('starts both browser and device-code ChatGPT login modes', async () => {
    vi.stubEnv('CODEX_PROVIDER_ENABLED', 'true');
    const client = fakeClient({
      'account/login/start': {
        type: 'chatgpt',
        loginId: 'login-1',
        authUrl: 'https://example.test/login',
      },
    });

    await startCodexLogin('browser', client);
    await startCodexLogin('device', client);

    expect(client.calls).toEqual([
      [
        'account/login/start',
        { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' },
      ],
      ['account/login/start', { type: 'chatgptDeviceCode' }],
    ]);
  });

  it('signs out through the isolated provider App Server', async () => {
    vi.stubEnv('CODEX_PROVIDER_ENABLED', 'true');
    const client = fakeClient({ 'account/logout': {} });

    await logoutCodexAccount(client);

    expect(client.calls).toEqual([['account/logout', undefined]]);
  });
});
