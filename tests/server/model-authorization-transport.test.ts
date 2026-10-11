import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';

const captures = vi.hoisted(() => ({
  calls: [] as { model?: string; target?: string; key: string | null }[],
}));
vi.mock('@/lib/server/provider-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/provider-fetch')>()),
  providerFetch: async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body || '{}'));
    captures.calls.push({ model: body.model, key: new Headers(init.headers).get('Authorization') });
    return Response.json({});
  },
}));
vi.mock('@/lib/server/audio-provider-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/audio-provider-fetch')>()),
  audioProviderFetch: async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body || '{}'));
    captures.calls.push({
      model: body.model,
      target: body.input?.target_model,
      key: new Headers(init.headers).get('Authorization'),
    });
    return String(url).includes('audio/speech')
      ? new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/wav' } })
      : Response.json({ output: { voice: 'cloned-voice' } });
  },
}));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: async () => {} }));
vi.mock('@/lib/server/identity/resolve', async (original) => ({
  ...(await original<typeof import('@/lib/server/identity/resolve')>()),
  resolveRequestOwner: async () => ({
    ok: true,
    principal: { ownerId: 'owner', assurance: 'minted' },
  }),
}));

beforeEach(() => {
  vi.resetModules();
  captures.calls = [];
  for (const key of [
    'DATABASE_URL',
    'OPENMAIC_CONFIG',
    'DEFAULT_MODEL',
    'MODEL_FALLBACK',
    'MODEL_ROUTES',
    'IMAGE_MINIMAX_API_KEY',
    'VIDEO_MINIMAX_API_KEY',
    'IMAGE_MINIMAX_MODELS',
    'VIDEO_MINIMAX_MODELS',
    'TTS_OPENAI_API_KEY',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', 'qwen3-tts-vc-2026-01-22');
});
afterEach(() => vi.unstubAllEnvs());
async function deployment(config: ModelConfigFile, legacy = false) {
  const runtime = await import('@/lib/server/model-config/runtime');
  runtime.setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy,
    notices: [],
  });
  runtime.setWorkspaceLayerLoaderForTests(async () => null);
}
function req(path: string, body: unknown, headers = {}) {
  return new NextRequest(`http://localhost/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
function wav() {
  const b = Buffer.alloc(44 + 48000 * 2);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(b.length - 44, 40);
  return b;
}
it.each(['denied', 'allowed', 'byok'])(
  'agent Qwen registration checks its target before lookup: %s',
  async (mode) => {
    await deployment({
      providers: {
        speech: {
          preset: 'qwen-tts',
          apiKey: 'server-key',
          models:
            mode === 'allowed'
              ? ['qwen3-tts-flash', 'qwen3-tts-vc-2026-01-22']
              : ['qwen3-tts-flash'],
        },
      },
      slots: { tts: 'speech:qwen3-tts-flash' },
    });
    if (mode === 'allowed') vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', ' qwen3-tts-vc-2026-01-22 ');
    const { serverMediaConnection } = await import('@/lib/server/model-config/media');
    const connection = await serverMediaConnection('tts');
    if (!connection || connection === 'off') throw Error('missing connection');
    if (mode === 'byok') Object.assign(connection, { managed: false, apiKey: 'user-key' });
    const { buildVoiceCloneTools } = await import('@/lib/server/agent-runtime/voice-clone-tools');
    const getMaterial = vi.fn(
      async () => ({ id: 'clip', kind: 'audio-track', rawAssetId: 'raw' }) as never,
    );
    const tools = buildVoiceCloneTools({
      sessionId: 'session',
      ttsConnection: connection,
      getMaterial,
      readRawAsset: async () => ({ bytes: wav(), mime: 'audio/wav' }),
    });
    const run = tools
      .find((t) => t.name === 'register_voice')!
      .execute('call', { clipId: 'clip', name: 'Sample', refText: 'Hello' } as never);
    if (mode === 'denied') {
      await expect(run).rejects.toMatchObject({ code: 'PROVIDER_DISABLED', httpStatus: 403 });
      expect(getMaterial).not.toHaveBeenCalled();
      expect(captures.calls).toEqual([]);
    } else {
      await run;
      expect(captures.calls).toEqual([
        {
          model: 'qwen-voice-enrollment',
          target: 'qwen3-tts-vc-2026-01-22',
          key: `Bearer ${mode === 'byok' ? 'user-key' : 'server-key'}`,
        },
      ]);
    }
  },
);
it.each(['image', 'video'] as const)(
  'MiniMax %s verification sends the selected model on saved and legacy paths',
  async (capability) => {
    const preset = `minimax-${capability}`;
    const model = capability === 'image' ? 'image-01-live' : 'MiniMax-Hailuo-02';
    const { POST } =
      capability === 'image'
        ? await import('@/app/api/verify-image-provider/route')
        : await import('@/app/api/verify-video-provider/route');
    await deployment({
      providers: { selected: { preset, apiKey: 'server-key', models: [model] } },
    });
    expect(
      (await POST(req(`verify-${capability}-provider`, { provider: 'selected', model }))).status,
    ).toBe(200);
    expect(captures.calls).toEqual([{ model, key: 'Bearer server-key' }]);
    vi.stubEnv(`${capability.toUpperCase()}_MINIMAX_API_KEY`, 'legacy-key');
    vi.stubEnv(`${capability.toUpperCase()}_MINIMAX_MODELS`, model);
    vi.resetModules();
    await deployment(
      { providers: { [preset]: { preset, apiKey: 'legacy-key', models: [model] } } },
      true,
    );
    const route =
      capability === 'image'
        ? await import('@/app/api/verify-image-provider/route')
        : await import('@/app/api/verify-video-provider/route');
    expect(
      (
        await route.POST(
          req(
            `verify-${capability}-provider`,
            {},
            { [`x-${capability}-provider`]: preset, [`x-${capability}-model`]: model },
          ),
        )
      ).status,
    ).toBe(200);
    expect(captures.calls[1]).toEqual({ model, key: 'Bearer legacy-key' });
  },
);
it('Qwen clone voice switches to an unauthorized upstream model and is refused before transport', async () => {
  await deployment({
    providers: {
      speech: { preset: 'qwen-tts', apiKey: 'server-key', models: ['qwen3-tts-flash'] },
    },
    slots: { tts: 'speech:qwen3-tts-flash' },
  });
  const { POST } = await import('@/app/api/generate/tts/route');
  const response = await POST(
    req('generate/tts', { text: 'Hello', audioId: 'a', ttsVoice: 'qwen-tts-vc-abc123' }),
  );
  expect(captures.calls).toEqual([]);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ errorCode: 'PROVIDER_DISABLED' });
});
it('empty legacy TTS model selects the authorized default', async () => {
  vi.stubEnv('TTS_OPENAI_API_KEY', 'server-key');
  const { POST } = await import('@/app/api/generate/tts/route');
  const response = await POST(
    req('generate/tts', {
      text: 'Hello',
      audioId: 'a',
      ttsProviderId: 'openai-tts',
      ttsVoice: 'alloy',
      ttsModelId: '',
    }),
  );
  expect(response.status).toBe(200);
  expect(captures.calls).toEqual([{ model: 'gpt-4o-mini-tts', key: 'Bearer server-key' }]);
});
it('VoxCPM fixed adapter alias uses authorization of the declared model', async () => {
  await deployment({
    providers: {
      speech: {
        preset: 'voxcpm-tts',
        apiKey: 'server-key',
        models: ['VoxCPM2'],
        options: { backend: 'vllm-omni' },
      },
    },
    slots: { tts: 'speech:VoxCPM2' },
  });
  const { POST } = await import('@/app/api/generate/tts/route');
  expect(
    (await POST(req('generate/tts', { text: 'Hello', audioId: 'a', ttsVoice: 'default' }))).status,
  ).toBe(200);
  expect(captures.calls).toEqual([{ model: 'voxcpm2', key: 'Bearer server-key' }]);
});
