import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Scene } from '@/lib/types/stage';

const fetchMock = vi.hoisted(() => vi.fn());
const providers = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/audio-provider-fetch', () => ({
  audioProviderFetch: (...args: unknown[]) => fetchMock(...args),
  audioEndpointPolicy: () => ({}),
}));
vi.mock('@/lib/server/provider-config', () => ({
  resolveTTSModel: vi.fn(() => ''),
  slotTTSModel: vi.fn(() => ''),
}));
vi.mock('@/lib/server/model-config/media', async (original) => ({
  ...(await original<typeof import('@/lib/server/model-config/media')>()),
  serverMediaConnection: (...args: unknown[]) => providers(...args),
}));
vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: vi.fn(),
}));

import {
  resetAgentTtsProviderGatesForTests,
  synthesizeSceneNarration,
} from '@/lib/server/agent-runtime/scene-tts';

function scene(ids: string[]): Scene {
  return {
    id: 'scene-page',
    stageId: 'stage-a',
    order: 1,
    title: 'A',
    type: 'slide',
    content: { type: 'slide' },
    actions: ids.map((id) => ({ id, type: 'speech', text: id })),
  } as Scene;
}

function quotaResponse(body: unknown): Response {
  return Response.json(body, {
    status: 429,
    headers: { 'retry-after': '5' },
  });
}

function requestText(call: unknown[]): string {
  const init = call[1] as RequestInit | undefined;
  const parsed = JSON.parse(String(init?.body)) as { input?: string; text?: string };
  return parsed.input ?? parsed.text ?? '';
}

describe('quota HTTP 429 with Retry-After does not pace later narration', () => {
  beforeEach(() => {
    resetAgentTtsProviderGatesForTests();
    fetchMock.mockReset();
    providers.mockReset();
  });

  it.each([
    {
      providerId: 'openai-tts',
      apiKey: 'key-openai-quota-wire',
      baseUrl: 'https://tts.example/v1',
      url: 'https://tts.example/v1/audio/speech',
      body: { error: { code: 'insufficient_quota', message: 'Request refused' } },
      leaked: 'Request refused',
    },
    {
      providerId: 'custom-tts-lab',
      apiKey: 'key-custom-quota-wire',
      baseUrl: 'https://tts.example/v1',
      url: 'https://tts.example/v1/audio/speech',
      body: { error: { code: 'insufficient_quota', message: 'Request refused' } },
      leaked: 'Request refused',
    },
    {
      providerId: 'minimax-tts',
      apiKey: 'key-minimax-1008-wire',
      baseUrl: 'https://tts.example',
      url: 'https://tts.example/v1/t2a_v2',
      body: { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } },
      leaked: 'insufficient balance',
    },
    {
      providerId: 'minimax-tts',
      apiKey: 'key-minimax-2056-wire',
      baseUrl: 'https://tts.example',
      url: 'https://tts.example/v1/t2a_v2',
      body: { base_resp: { status_code: 2056, status_msg: 'usage limit exceeded' } },
      leaked: 'usage limit exceeded',
    },
  ])(
    '$providerId keeps both lines and a later call on the provider ($url)',
    async ({ providerId, apiKey, baseUrl, url, body, leaked }) => {
      providers.mockResolvedValue({
        providerId,
        managed: false,
        userEndpoint: true,
        origin: 'settings',
        apiKey,
        baseUrl,
        modelId: 'tts-1',
      });
      fetchMock.mockImplementation(async () => quotaResponse(body));
      const sleeps: number[] = [];

      const summary = await synthesizeSceneNarration({
        scene: scene(['speech-1', 'speech-2']),
        force: false,
        ownerId: `user:${apiKey}`,
        budgetMs: 1_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      expect(sleeps).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([url, url]);
      expect(fetchMock.mock.calls.map(requestText)).toEqual(['speech-1', 'speech-2']);
      expect(summary.failed).toEqual([
        { id: 'speech-1', reason: 'PROVIDER_QUOTA_EXHAUSTED' },
        { id: 'speech-2', reason: 'PROVIDER_QUOTA_EXHAUSTED' },
      ]);
      expect(summary.generated).toBe(0);
      expect(JSON.stringify(summary)).not.toContain(leaked);

      fetchMock.mockClear();
      const later = await synthesizeSceneNarration({
        scene: scene(['speech-later']),
        force: false,
        ownerId: `user:${apiKey}`,
        budgetMs: 1_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      expect(sleeps).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(requestText(fetchMock.mock.calls[0] ?? [])).toBe('speech-later');
      expect(later.failed).toEqual([{ id: 'speech-later', reason: 'PROVIDER_QUOTA_EXHAUSTED' }]);
      expect(JSON.stringify(later)).not.toContain(leaked);
    },
  );
});
