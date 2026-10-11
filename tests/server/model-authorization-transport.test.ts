/** Real adapters/SDKs; only outbound transports and usage storage are intercepted. */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
const capture = vi.hoisted(() => ({
  calls: [] as { model?: string; target?: string; key: string | null }[],
}));
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (p: string) =>
        p.endsWith('server-providers.yml') ? false : actual.existsSync(p),
    },
  };
});
vi.mock('@/lib/server/provider-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/provider-fetch')>()),
  providerFetch: async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body || '{}'));
    capture.calls.push({ model: body.model, key: new Headers(init.headers).get('Authorization') });
    return Response.json({});
  },
}));
vi.mock('@/lib/server/proxy-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/proxy-fetch')>()),
  proxyFetch: async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body || '{}'));
    capture.calls.push({ model: body.model, key: new Headers(init.headers).get('x-api-key') });
    return Response.json({
      id: 'reply',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  },
}));
vi.mock('@/lib/server/audio-provider-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/audio-provider-fetch')>()),
  audioProviderFetch: async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body || '{}'));
    capture.calls.push({
      model: body.model,
      target: body.input?.target_model,
      key: new Headers(init.headers).get('Authorization'),
    });
    if (String(url).includes('audio/speech') || !init.body)
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/wav' } });
    if (body.model === 'qwen-voice-enrollment')
      return Response.json({ output: { voice: 'cloned-voice', voice_list: [] } });
    return Response.json({
      output: {
        audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav' },
      },
    });
  },
}));
vi.mock('@/lib/server/fetch-with-redirect-validation', async (original) => ({
  ...(await original<typeof import('@/lib/server/fetch-with-redirect-validation')>()),
  fetchWithRedirectValidation: async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body || '{}'));
    capture.calls.push({ model: body.model, key: new Headers(init.headers).get('Authorization') });
    return Response.json({
      id: 'reply',
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
}));
vi.mock('@/lib/server/llm-provider-fetch', () => ({
  clientBaseUrlLlmFetch: async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body || '{}'));
    capture.calls.push({ model: body.model, key: new Headers(init.headers).get('Authorization') });
    return Response.json({
      id: 'reply',
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
}));
vi.mock('@/lib/server/ssrf-guard', async (original) => ({
  ...(await original<typeof import('@/lib/server/ssrf-guard')>()),
  validateClientBaseUrl: async () => null,
  validateUrlForSSRF: async () => null,
  validatePublicUrlForSSRF: async () => null,
}));
vi.mock('@/lib/server/usage-storage', () => ({
  recordGenerationUsage: async () => {},
  recordUsage: async () => {},
}));
beforeEach(() => {
  vi.resetModules();
  capture.calls = [];
  for (const key of Object.keys(process.env))
    if (
      /(?:_API_KEY|_BASE_URL|_MODELS)$/.test(key) ||
      [
        'DEFAULT_MODEL',
        'MODEL_FALLBACK',
        'MODEL_ROUTES',
        'BEDROCK_REGION',
        'AWS_BEARER_TOKEN_BEDROCK',
        'TTS_QWEN_VOICE_CLONE_MODEL',
      ].includes(key)
    )
      vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());
const refusal = {
  success: false,
  errorCode: 'PROVIDER_DISABLED',
  error: 'This model is not authorized for server-managed credentials',
};
function req(path: string, body: unknown, headers: Record<string, string> = {}) {
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
it.each(['image', 'video'] as const)(
  'MiniMax %s verification uses the selected authorized model, never a fixed probe model',
  async (capability) => {
    const model = capability === 'image' ? 'image-01-live' : 'MiniMax-Hailuo-02';
    vi.stubEnv(`${capability.toUpperCase()}_MINIMAX_API_KEY`, 'server-key');
    vi.stubEnv(`${capability.toUpperCase()}_MINIMAX_MODELS`, model);
    const route =
      capability === 'image'
        ? await import('@/app/api/verify-image-provider/route')
        : await import('@/app/api/verify-video-provider/route');
    const path = `verify-${capability}-provider`;
    for (const id of ['not-listed', 'unknown']) {
      const r = await route.POST(
        req(
          path,
          {},
          { [`x-${capability}-provider`]: `minimax-${capability}`, [`x-${capability}-model`]: id },
        ),
      );
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual(refusal);
    }
    expect(capture.calls).toEqual([]);
    expect(
      (
        await route.POST(
          req(
            path,
            {},
            {
              [`x-${capability}-provider`]: `minimax-${capability}`,
              [`x-${capability}-model`]: model,
            },
          ),
        )
      ).status,
    ).toBe(200);
    expect(capture.calls).toEqual([{ model, key: 'Bearer server-key' }]);
  },
);
it.each(['denied', 'allowed'] as const)(
  'agent Qwen enrollment authorizes its real target before material lookup: %s',
  async (mode) => {
    vi.stubEnv('TTS_QWEN_API_KEY', 'server-key');
    vi.stubEnv(
      'TTS_QWEN_MODELS',
      mode === 'allowed' ? 'qwen3-tts-flash,qwen3-tts-vc-2026-01-22' : 'qwen3-tts-flash',
    );
    const { buildVoiceCloneTools } = await import('@/lib/server/agent-runtime/voice-clone-tools');
    const getMaterial = vi.fn(
      async () => ({ id: 'clip', kind: 'audio-track', rawAssetId: 'raw' }) as never,
    );
    const tools = buildVoiceCloneTools({
      sessionId: 'session',
      getMaterial,
      readRawAsset: async () => ({ bytes: wav(), mime: 'audio/wav' }),
    });
    const run = tools
      .find((t) => t.name === 'register_voice')!
      .execute('call', { clipId: 'clip', name: 'Sample', refText: 'Hello' } as never);
    if (mode === 'denied') {
      await expect(run).rejects.toMatchObject({ code: 'PROVIDER_DISABLED', httpStatus: 403 });
      expect(getMaterial).not.toHaveBeenCalled();
      expect(capture.calls).toEqual([]);
    } else {
      await run;
      expect(capture.calls).toEqual([
        {
          model: 'qwen-voice-enrollment',
          target: 'qwen3-tts-vc-2026-01-22',
          key: 'Bearer server-key',
        },
      ]);
    }
  },
);
it.each(['denied', 'allowed', 'byok'] as const)(
  'Qwen voice route checks its registration target before lookup: %s',
  async (mode) => {
    if (mode !== 'byok') {
      vi.stubEnv('TTS_QWEN_API_KEY', 'server-key');
      vi.stubEnv(
        'TTS_QWEN_MODELS',
        mode === 'allowed' ? 'qwen3-tts-flash,qwen3-tts-vc-2026-01-22' : 'qwen3-tts-flash',
      );
    }
    const { POST } = await import('@/app/api/generate/voice/route');
    const r = await POST(
      req('generate/voice', {
        providerId: 'qwen-tts',
        voiceId: 'sample',
        ttsApiKey: 'user-key',
        referenceAudioBase64: wav().toString('base64'),
        refText: 'Hello',
      }),
    );
    if (mode === 'denied') {
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual(refusal);
      expect(capture.calls).toEqual([]);
    } else {
      expect(r.status).toBe(200);
      expect(capture.calls.at(-1)).toEqual({
        model: 'qwen-voice-enrollment',
        target: 'qwen3-tts-vc-2026-01-22',
        key: `Bearer ${mode === 'byok' ? 'user-key' : 'server-key'}`,
      });
    }
  },
);
it.each(['denied', 'allowed', 'byok'] as const)(
  'Qwen clone synthesis checks the voice-compatible wire model: %s',
  async (mode) => {
    if (mode !== 'byok') {
      vi.stubEnv('TTS_QWEN_API_KEY', 'server-key');
      vi.stubEnv(
        'TTS_QWEN_MODELS',
        mode === 'allowed' ? 'qwen3-tts-flash,qwen3-tts-vc-2026-01-22' : 'qwen3-tts-flash',
      );
    }
    const { POST } = await import('@/app/api/generate/tts/route');
    const r = await POST(
      req('generate/tts', {
        text: 'Hello',
        audioId: 'a',
        ttsProviderId: 'qwen-tts',
        ttsModelId: 'qwen3-tts-flash',
        ttsVoice: 'cloned-voice',
        ttsApiKey: 'user-key',
      }),
    );
    if (mode === 'denied') {
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual(refusal);
      expect(capture.calls).toEqual([]);
    } else {
      expect(r.status).toBe(200);
      expect(capture.calls[0]).toEqual({
        model: 'qwen3-tts-vc-2026-01-22',
        target: undefined,
        key: `Bearer ${mode === 'byok' ? 'user-key' : 'server-key'}`,
      });
    }
  },
);
it('direct managed TTS callers re-check voice compatibility at execution', async () => {
  vi.stubEnv('TTS_QWEN_API_KEY', 'server-key');
  vi.stubEnv('TTS_QWEN_MODELS', 'qwen3-tts-flash');
  const { generateTTS } = await import('@/lib/audio/tts-providers');
  await expect(
    generateTTS(
      {
        providerId: 'qwen-tts',
        modelId: 'qwen3-tts-flash',
        voice: 'cloned-voice',
        apiKey: 'server-key',
        managed: true,
      },
      'Hello',
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED', httpStatus: 403 });
  expect(capture.calls).toEqual([]);
});
it('empty TTS model selects the single authorized default', async () => {
  vi.stubEnv('TTS_OPENAI_API_KEY', 'server-key');
  const { POST } = await import('@/app/api/generate/tts/route');
  expect(
    (
      await POST(
        req('generate/tts', {
          text: 'Hello',
          audioId: 'a',
          ttsProviderId: 'openai-tts',
          ttsVoice: 'alloy',
          ttsModelId: '',
        }),
      )
    ).status,
  ).toBe(200);
  expect(capture.calls).toEqual([
    { model: 'gpt-4o-mini-tts', target: undefined, key: 'Bearer server-key' },
  ]);
});
it.each(['managed', 'byok'] as const)(
  'VoxCPM preserves normalized model selection and its fixed alias: %s',
  async (mode) => {
    if (mode === 'managed') {
      vi.stubEnv('TTS_VOXCPM_API_KEY', 'server-key');
      vi.stubEnv('TTS_VOXCPM_MODELS', ' VoxCPM2 ');
      vi.stubEnv('TTS_VOXCPM_BASE_URL', 'https://voice.example/v1');
    }
    const { POST } = await import('@/app/api/generate/tts/route');
    expect(
      (
        await POST(
          req('generate/tts', {
            text: 'Hello',
            audioId: 'a',
            ttsProviderId: 'voxcpm-tts',
            ttsVoice: 'default',
            ttsApiKey: 'user-key',
            ttsBaseUrl: 'https://voice.example/v1',
            ttsModelId: ' VoxCPM2 ',
            ttsProviderOptions: { backend: 'vllm-omni' },
          }),
        )
      ).status,
    ).toBe(200);
    expect(capture.calls).toEqual([
      {
        model: 'voxcpm2',
        target: undefined,
        key: `Bearer ${mode === 'managed' ? 'server-key' : 'user-key'}`,
      },
    ]);
  },
);
it('verify-model uses the real SDK and refuses unknown and unauthorized ids before transport', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'server-key');
  vi.stubEnv('OPENAI_MODELS', 'allowed');
  const { POST } = await import('@/app/api/verify-model/route');
  for (const model of ['gpt-4o-mini', 'unknown']) {
    const r = await POST(req('verify-model', { model: `openai:${model}`, apiKey: 'user-key' }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual(refusal);
  }
  expect(capture.calls).toEqual([]);
  expect(
    (await POST(req('verify-model', { model: 'openai:allowed', apiKey: 'user-key' }))).status,
  ).toBe(200);
  expect(capture.calls).toEqual([{ model: 'allowed', key: 'Bearer server-key' }]);
});
it('an unmanaged provider uses its own key with no server env-key fallback', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'server-key');
  const { POST } = await import('@/app/api/verify-model/route');
  expect(
    (
      await POST(
        req('verify-model', {
          model: 'custom:anything',
          apiKey: 'user-key',
          providerType: 'openai',
          baseUrl: 'https://user.example/v1',
        }),
      )
    ).status,
  ).toBe(200);
  expect(capture.calls).toEqual([{ model: 'anything', key: 'Bearer user-key' }]);
});

it.each(['allowed', 'denied'] as const)(
  'agent Claude search preserves and rechecks the authorized wire model: %s',
  async (mode) => {
    vi.stubEnv('WEB_SEARCH_CLAUDE_API_KEY', 'server-key');
    vi.stubEnv('WEB_SEARCH_CLAUDE_MODELS', 'approved-search');
    const { resolveWebSearchCapability, buildWebSearchTool } =
      await import('@/lib/server/agent-runtime/web-search');
    const capability = resolveWebSearchCapability()!;
    expect(capability.claudeModelId).toBe('approved-search');
    const tool = buildWebSearchTool({
      ...capability,
      ...(mode === 'denied' ? { claudeModelId: 'not-listed' } : {}),
    });
    const run = tool.execute('call', { query: 'test' } as never);
    if (mode === 'denied') {
      await expect(run).rejects.toMatchObject({ code: 'PROVIDER_DISABLED', httpStatus: 403 });
      expect(capture.calls).toEqual([]);
    } else {
      await run;
      expect(capture.calls).toEqual([{ model: 'approved-search', key: 'server-key' }]);
    }
  },
);
