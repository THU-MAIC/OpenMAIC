// The route inventory detects listed resolver calls; direct SDK construction in a new route is not detected.
/** Every model-resolving request and worker uses the deployment authorization boundary. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';

const mocks = vi.hoisted(() => ({
  upstream: vi.fn(),
  admitted: vi.fn(),
  model: 'allowed',
  saved: null as ModelConfigFile | null,
}));
vi.mock('@/lib/ai/providers', async (original) => ({
  ...(await original<typeof import('@/lib/ai/providers')>()),
  getModel: () => ({ model: {}, modelInfo: undefined }),
}));
vi.mock('@/lib/ai/llm', () => ({
  callLLM: async () => {
    mocks.upstream();
    return { text: '{"score":1,"comment":"OK"}' };
  },
}));
vi.mock('@/lib/orchestration/stateless-generate', () => ({
  statelessGenerate: async function* () {
    mocks.upstream();
  },
}));
vi.mock('@/lib/chat/pi/director-loop', () => ({
  runPiDirectorLoop: async () => {
    mocks.upstream();
  },
}));
vi.mock('@/lib/pbl/v2/api/sse', () => ({
  createSSEResponse: () => {
    mocks.upstream();
    return new Response('ok');
  },
}));
vi.mock('@/lib/pbl/v2/api/locale', () => ({ applyRequestLocaleToProject: () => {} }));
vi.mock('@/lib/media/image-providers', async (original) => ({
  ...(await original<typeof import('@/lib/media/image-providers')>()),
  generateImage: async () => {
    mocks.upstream();
    return { url: 'https://cdn.example/image.png', width: 1024, height: 1024 };
  },
  testImageConnectivity: async () => {
    mocks.upstream();
    return { success: true, message: 'OK' };
  },
}));
vi.mock('@/lib/media/video-providers', async (original) => ({
  ...(await original<typeof import('@/lib/media/video-providers')>()),
  generateVideo: async () => {
    mocks.upstream();
    return { url: 'https://cdn.example/video.mp4', duration: 5 };
  },
  testVideoConnectivity: async () => {
    mocks.upstream();
    return { success: true, message: 'OK' };
  },
}));
vi.mock('@/lib/audio/tts-providers', async (original) => ({
  ...(await original<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: async () => {
    mocks.upstream();
    return { audio: new Uint8Array([1]), format: 'mp3' };
  },
}));
vi.mock('@/lib/audio/asr-providers', async (original) => ({
  ...(await original<typeof import('@/lib/audio/asr-providers')>()),
  transcribeAudio: async () => {
    mocks.upstream();
    return { text: 'OK' };
  },
}));
vi.mock('@/lib/audio/voice-registration', async (original) => ({
  ...(await original<typeof import('@/lib/audio/voice-registration')>()),
  getVoiceRegistrationAdapter: () => ({
    supportsRegistration: () => true,
    voiceExists: async () => {
      mocks.upstream();
      return true;
    },
  }),
}));
vi.mock('@/lib/server/identity/resolve', async (original) => ({
  ...(await original<typeof import('@/lib/server/identity/resolve')>()),
  ...(await import('../helpers/owner-resolution-mock')).ownerResolveModule(() => 'test-owner'),
}));
vi.mock('@/lib/config/feature-flags', async (original) => ({
  ...(await original<typeof import('@/lib/config/feature-flags')>()),
  isServerPersistenceConfigured: () => true,
  isAgentRuntimeConfigured: () => true,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/workspace-model-config', async (original) => ({
  ...(await original<typeof import('@/lib/persistence/workspace-model-config')>()),
  readWorkspaceModelConfig: async () =>
    mocks.saved && { config: mocks.saved, revision: 1, unreadableSecrets: [] },
  saveWorkspaceModelConfig: async (_pool: unknown, _owner: unknown, config: ModelConfigFile) => {
    mocks.admitted();
    mocks.saved = config;
  },
}));
vi.mock('@/lib/server/materials/extractor-wake', () => ({ wakeOwnerMaterialExtractor: () => {} }));
vi.mock('@/lib/server/generation/run/runner', () => ({ wakeGenerationRunner: () => {} }));
vi.mock('@/lib/server/generation/run/store', async (original) => ({
  ...(await original<typeof import('@/lib/server/generation/run/store')>()),
  createGenerationRun: async () => {
    mocks.admitted();
    return { id: 'run', state: 'preparing' };
  },
  runSnapshot: () => ({ id: 'run' }),
  retryGenerationRun: async () => {
    mocks.admitted();
    return { run: { id: 'run' } };
  },
  confirmGenerationRunOutline: async () => {
    mocks.admitted();
    return { run: { id: 'run' } };
  },
}));
vi.mock('@/lib/server/generate-classroom-job', async (original) => ({
  ...(await original<typeof import('@/lib/server/generate-classroom-job')>()),
  classroomJobView: () => ({ jobId: 'run' }),
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    readRetirement: async () => null,
    createSession: async () => {
      mocks.admitted();
      return { id: 'session', ownerId: 'test-owner' };
    },
    getSession: async () => ({ id: 'session', ownerId: 'test-owner' }),
    postUserMessage: async () => {
      mocks.admitted();
      return { seq: 1, delivery: 'queued' };
    },
  }),
}));
vi.mock('@/lib/server/agent-runtime/conversation-title-task', () => ({
  scheduleConversationTitle: () => {},
}));
vi.mock('@/lib/server/agent-runtime/skills', () => ({
  inferSkillIdFromPrompt: async () => undefined,
}));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: async () => {} }));
vi.mock('@/lib/server/ssrf-guard', async (original) => ({
  ...(await original<typeof import('@/lib/server/ssrf-guard')>()),
  validateClientBaseUrl: async () => null,
  validatePublicUrlForSSRF: async () => null,
}));

const runtime = await import('@/lib/server/model-config/runtime');
const { modelAuthorizationResponse } = await import('@/lib/server/api-response');
const { resolveSlot } = await import('@/lib/server/model-config/resolve-slot');
const { createGenerationAiCallFactory } =
  await import('@/lib/server/agent-runtime/generation-ai-call');
const { resolveAgentDriverModel } = await import('@/lib/server/agent-runtime/agent-driver-model');
const { resolveWebSearchConnection } = await import('@/lib/server/web-search-config');
const { runFailureCode } = await import('@/lib/server/generation/run/failure-code');
const { ModelAuthorizationError, deploymentAuthorizedModels } =
  await import('@/lib/server/model-config/model-authorization');
const { translateLegacyConfig } = await import('@/lib/server/model-config/legacy-config');

const providers: NonNullable<ModelConfigFile['providers']> = {
  openai: { preset: 'openai', apiKey: 'server', models: ['allowed'] },
  seedream: { preset: 'seedream', apiKey: 'server', models: ['allowed'] },
  seedance: { preset: 'seedance', apiKey: 'server', models: ['allowed'] },
  'openai-tts': { preset: 'openai-tts', apiKey: 'server', models: ['allowed'] },
  'openai-whisper': { preset: 'openai-whisper', apiKey: 'server', models: ['allowed'] },
  claude: { preset: 'claude', apiKey: 'server', models: ['allowed'] },
};
const refusal = {
  success: false,
  errorCode: 'PROVIDER_DISABLED',
  error: 'This model is not authorized for server-managed credentials',
};
const SLOT_PROVIDERS = {
  llm: 'openai',
  agent: 'openai',
  image: 'seedream',
  video: 'seedance',
  tts: 'openai-tts',
  asr: 'openai-whisper',
  webSearch: 'claude',
};

function request(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST',
) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
function chatBody(model: string) {
  return {
    model: `openai:${model}`,
    messages: [],
    storeState: { scenes: [] },
    config: {
      agentIds: ['teacher'],
      agentConfigs: [
        { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Teach', allowedActions: [] },
      ],
    },
  };
}
interface RouteCase {
  path: string;
  invoke: (model: string) => Promise<Response>;
  /** Asynchronous routes admit work; synchronous routes reach the provider stub. */
  admission?: boolean;
}
const ROUTES: RouteCase[] = [
  {
    path: 'chat',
    invoke: async (m) =>
      (await import('@/app/api/chat/route')).POST(request('/api/chat', chatBody(m))),
  },
  {
    path: 'chat/pi',
    invoke: async (m) =>
      (await import('@/app/api/chat/pi/route')).POST(request('/api/chat/pi', chatBody(m))),
  },
  {
    path: 'verify-model',
    invoke: async (m) =>
      (await import('@/app/api/verify-model/route')).POST(
        request('/api/verify-model', { model: `openai:${m}` }),
      ),
  },
  ...(['instructor', 'simulator', 'evaluate', 'open-task'] as const).map((endpoint) => ({
    path: `pbl/v2/${endpoint}`,
    invoke: async (m: string) => {
      const handlers = {
        instructor: await import('@/app/api/pbl/v2/instructor/route'),
        simulator: await import('@/app/api/pbl/v2/simulator/route'),
        evaluate: await import('@/app/api/pbl/v2/evaluate/route'),
        'open-task': await import('@/app/api/pbl/v2/open-task/route'),
      };
      return handlers[endpoint].POST(
        request(
          `/api/pbl/v2/${endpoint}`,
          {
            model: `openai:${m}`,
            project: { id: 'p' },
            userMessage: 'hi',
            kind: 'final',
            phase: 'greeting',
          },
          { 'x-model': `openai:${m}` },
        ),
      );
    },
  })),
  {
    path: 'quiz-grade',
    invoke: async (m) =>
      (await import('@/app/api/quiz-grade/route')).POST(
        request(
          '/api/quiz-grade',
          { model: `openai:${m}`, question: 'Q', userAnswer: 'A', points: 1 },
          { 'x-model': `openai:${m}` },
        ),
      ),
  },
  {
    path: 'generate/image',
    invoke: async (m) =>
      (await import('@/app/api/generate/image/route')).POST(
        request(
          '/api/generate/image',
          { prompt: 'A tree' },
          { 'x-image-provider': 'seedream', 'x-image-model': m },
        ),
      ),
  },
  {
    path: 'verify-image-provider',
    invoke: async (m) =>
      (await import('@/app/api/verify-image-provider/route')).POST(
        request(
          '/api/verify-image-provider',
          {},
          { 'x-image-provider': 'seedream', 'x-image-model': m },
        ),
      ),
  },
  {
    path: 'generate/video',
    invoke: async (m) =>
      (await import('@/app/api/generate/video/route')).POST(
        request(
          '/api/generate/video',
          { prompt: 'A river' },
          { 'x-video-provider': 'seedance', 'x-video-model': m },
        ),
      ),
  },
  {
    path: 'verify-video-provider',
    invoke: async (m) =>
      (await import('@/app/api/verify-video-provider/route')).POST(
        request(
          '/api/verify-video-provider',
          {},
          { 'x-video-provider': 'seedance', 'x-video-model': m },
        ),
      ),
  },
  {
    path: 'generate/tts',
    invoke: async (m) =>
      (await import('@/app/api/generate/tts/route')).POST(
        request('/api/generate/tts', {
          text: 'Hello',
          audioId: 'a',
          ttsProviderId: 'openai-tts',
          ttsModelId: m,
          ttsVoice: 'alloy',
        }),
      ),
  },
  {
    path: 'generate/voice',
    invoke: async (m) =>
      (await import('@/app/api/generate/voice/route')).POST(
        request('/api/generate/voice', {
          providerId: 'openai-tts',
          voiceId: 'voice',
          ttsModelId: m,
          referenceAudioBase64: 'AQ==',
        }),
      ),
  },
  {
    path: 'transcription',
    invoke: async (m) => {
      const form = new FormData();
      form.set('audio', new File([new Uint8Array([1])], 'a.wav'));
      form.set('providerId', 'openai-whisper');
      form.set('modelId', m);
      return (await import('@/app/api/transcription/route')).POST(
        new NextRequest('http://localhost/api/transcription', { method: 'POST', body: form }),
      );
    },
  },
  {
    path: 'generation-runs',
    admission: true,
    invoke: async () =>
      (await import('@/app/api/generation-runs/route')).POST(
        request('/api/generation-runs', { requirement: 'Teach' }),
      ),
  },
  {
    path: 'generation-runs/[id]/retry',
    admission: true,
    invoke: async () =>
      (await import('@/app/api/generation-runs/[id]/retry/route')).POST(
        request('/api/generation-runs/run-AAAAAAAAAAAAAAAA/retry', { commandId: 'command-1' }),
        { params: Promise.resolve({ id: 'run-AAAAAAAAAAAAAAAA' }) },
      ),
  },
  {
    path: 'generation-runs/[id]/confirm-outline',
    admission: true,
    invoke: async () =>
      (await import('@/app/api/generation-runs/[id]/confirm-outline/route')).POST(
        request('/api/generation-runs/run-AAAAAAAAAAAAAAAA/confirm-outline', {
          commandId: 'command-1',
          outlineRevision: 1,
        }),
        { params: Promise.resolve({ id: 'run-AAAAAAAAAAAAAAAA' }) },
      ),
  },
  {
    path: 'generate-classroom',
    admission: true,
    invoke: async () =>
      (await import('@/app/api/generate-classroom/route')).POST(
        request('/api/generate-classroom', { requirement: 'Teach' }),
      ),
  },
  {
    path: 'agent/sessions',
    admission: true,
    invoke: async () =>
      (await import('@/app/api/agent/sessions/route')).POST(
        request('/api/agent/sessions', { prompt: 'Teach' }),
      ),
  },
  {
    path: 'agent/sessions/[id]/messages',
    admission: true,
    invoke: async () =>
      (await import('@/app/api/agent/sessions/[id]/messages/route')).POST(
        request('/api/agent/sessions/session/messages', { text: 'Hi' }),
        { params: Promise.resolve({ id: 'session' }) },
      ),
  },
  {
    path: 'model-config',
    admission: true,
    invoke: async (m) =>
      (await import('@/app/api/model-config/route')).PUT(
        request(
          '/api/model-config',
          { revision: null, change: { kind: 'slots', set: { image: `seedream:${m}` } } },
          {},
          'PUT',
        ),
      ),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saved = null;
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('NEXT_PUBLIC_PI_CHAT_ENABLED', 'true');
  for (const name of [
    'OPENAI',
    'IMAGE_SEEDREAM',
    'VIDEO_SEEDANCE',
    'TTS_OPENAI',
    'ASR_OPENAI',
    'WEB_SEARCH_CLAUDE',
  ]) {
    vi.stubEnv(`${name}_API_KEY`, 'server');
    vi.stubEnv(`${name}_MODELS`, 'allowed');
  }
  runtime.setDeploymentConfigForTests({
    layer: { source: 'deployment', config: { providers } },
    legacy: true,
    notices: [],
  });
  runtime.setWorkspaceLayerLoaderForTests(async () => ({
    source: 'workspace',
    config: {
      slots: Object.fromEntries(
        Object.entries(SLOT_PROVIDERS).map(([slot, provider]) => [
          slot,
          `${provider}:${mocks.model}`,
        ]),
      ),
    } as ModelConfigFile,
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  runtime.setDeploymentConfigForTests();
  runtime.setWorkspaceLayerLoaderForTests();
});

describe('server model authorization coverage matrix', () => {
  it.each(ROUTES)(
    '$path refuses unknown and unlisted models before provider access, then allows a listed model',
    async ({ invoke, admission }) => {
      for (const model of ['unlisted', 'unknown-model']) {
        mocks.model = model;
        const response = await invoke(model);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual(refusal);
        expect(mocks.upstream).not.toHaveBeenCalled();
        expect(mocks.admitted).not.toHaveBeenCalled();
      }
      mocks.model = 'allowed';
      const response = await invoke('allowed');
      await response.text();
      expect(response.status).toBeLessThan(300);
      expect(admission ? mocks.admitted : mocks.upstream).toHaveBeenCalled();
    },
  );
  it.each(['image', 'video', 'tts', 'asr', 'webSearch', 'llm'] as const)(
    'workspace %s assignments cannot expand a deployment list',
    (slot) => {
      const providerId = SLOT_PROVIDERS[slot];
      for (const model of ['unlisted', 'allowed']) {
        const work = {
          source: 'workspace' as const,
          config: { slots: { [slot]: `${providerId}:${model}` } },
        };
        const resolve = () =>
          resolveSlot(slot, [{ source: 'deployment', config: { providers } }, work]);
        if (model === 'unlisted') expect(resolve).toThrow(ModelAuthorizationError);
        else expect(resolve()).toMatchObject({ modelId: model });
      }
    },
  );
  it.each([
    [
      'generation worker',
      async () =>
        createGenerationAiCallFactory({ ownerId: 'test-owner' })('scene-content')(
          'system',
          'prompt',
        ),
    ],
    [
      'agent runtime',
      async () => {
        await resolveAgentDriverModel('test-owner');
        mocks.upstream();
      },
    ],
    [
      'web-search model',
      async () => {
        await resolveWebSearchConnection(null, {
          webSearchProviderId: 'claude',
          webSearchModelId: mocks.model,
        });
        mocks.upstream();
      },
    ],
  ] as const)('%s refuses before any upstream call', async (_name, invoke) => {
    mocks.model = 'unlisted';
    const error = await invoke().catch((error) => error);
    expect(error).toBeInstanceOf(ModelAuthorizationError);
    expect(await modelAuthorizationResponse(error)!.json()).toEqual(refusal);
    expect(runFailureCode(error)).toEqual({ errorCode: refusal.errorCode, statusCode: 403 });
    expect(mocks.upstream).not.toHaveBeenCalled();
    mocks.model = 'allowed';
    await invoke();
    expect(mocks.upstream).toHaveBeenCalled();
  });

  it.each(['image', 'video', 'tts', 'asr', 'webSearch'] as const)(
    '%s BYOK keeps arbitrary model ids usable',
    (slot) => {
      const preset = SLOT_PROVIDERS[slot];
      expect(
        resolveSlot(slot, [
          {
            source: 'workspace',
            config: {
              providers: { mine: { preset, apiKey: 'own-key' } },
              slots: { [slot]: 'mine:arbitrary' },
            },
          },
        ]),
      ).toMatchObject({ providerSource: 'workspace', modelId: 'arbitrary', apiKey: 'own-key' });
    },
  );
  it.each([
    'verify-image-provider',
    'verify-video-provider',
    'generate/tts',
    'transcription',
  ] as const)('%s saved-provider preview uses the same authorization', async (path) => {
    const invoke = async (model: string) => {
      if (path === 'verify-image-provider')
        return (await import('@/app/api/verify-image-provider/route')).POST(
          request('/api/' + path, { provider: 'seedream', model }),
        );
      if (path === 'verify-video-provider')
        return (await import('@/app/api/verify-video-provider/route')).POST(
          request('/api/' + path, { provider: 'seedance', model }),
        );
      if (path === 'generate/tts')
        return (await import('@/app/api/generate/tts/route')).POST(
          request('/api/' + path, {
            previewProvider: 'openai-tts',
            previewModel: model,
            text: 'Hi',
            audioId: 'a',
            ttsVoice: 'alloy',
          }),
        );
      const form = new FormData();
      form.set('audio', new File([new Uint8Array([1])], 'a.wav'));
      form.set('previewProvider', 'openai-whisper');
      form.set('previewModel', model);
      return (await import('@/app/api/transcription/route')).POST(
        new NextRequest('http://localhost/api/transcription', { method: 'POST', body: form }),
      );
    };
    for (const model of ['unlisted', 'unknown-model']) {
      const response = await invoke(model);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(refusal);
      expect(mocks.upstream).not.toHaveBeenCalled();
    }
    expect((await invoke('allowed')).status).toBe(200);
    expect(mocks.upstream).toHaveBeenCalled();
  });
  it.each(['llm', 'image', 'video', 'tts', 'asr', 'webSearch'] as const)(
    'workspace settings %s returns the stable 403 response',
    async (slot) => {
      const invoke = async (model: string) =>
        (await import('@/app/api/model-config/route')).PUT(
          request(
            '/api/model-config',
            {
              revision: null,
              change: { kind: 'slots', set: { [slot]: `${SLOT_PROVIDERS[slot]}:${model}` } },
            },
            {},
            'PUT',
          ),
        );
      const response = await invoke('unlisted');
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(refusal);
      expect(mocks.admitted).not.toHaveBeenCalled();
      expect((await invoke('allowed')).status).toBe(200);
      expect(mocks.admitted).toHaveBeenCalled();
    },
  );
  it('chat/pi refuses an unauthorized search model before starting the LLM stream', async () => {
    vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', 'true');
    const response = await (
      await import('@/app/api/chat/pi/route')
    ).POST(
      request('/api/chat/pi', {
        ...chatBody('allowed'),
        webSearchProviderId: 'claude',
        webSearchModelId: 'unlisted',
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(refusal);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it('deployment references grant only models for the matching capability', () => {
    const config: ModelConfigFile = {
      providers: { plan: { preset: 'minimax', apiKey: 'server' } },
      slots: { llm: 'plan:chat-default', tts: 'plan:speech-default' },
    };
    expect(deploymentAuthorizedModels(config, 'plan', 'chat')).toEqual(['chat-default']);
    expect(deploymentAuthorizedModels(config, 'plan', 'tts')).toEqual(['speech-default']);
  });
  it('a legacy MODEL_FALLBACK authorizes its model even without DEFAULT_MODEL', () => {
    const { config } = translateLegacyConfig(
      {
        providers: { openai: { apiKey: 'server' } },
        tts: {},
        asr: {},
        pdf: {},
        image: {},
        video: {},
        webSearch: {},
        disabled: {
          tts: new Set(),
          asr: new Set(),
          image: new Set(),
          video: new Set(),
          webSearch: new Set(),
        },
      },
      { globalFallback: 'openai:backup' },
    );
    expect(deploymentAuthorizedModels(config, 'openai')).toEqual(['backup']);
    expect(config.slots?.llm).toBeUndefined();
  });
  it('requires every API resolver call site to be represented in the matrix', () => {
    const pattern =
      /\b(?:getModel|resolveModel(?:FromRequest|FromHeaders)?|resolve(?:Image|Video|TTS|ASR|WebSearch)Model|resolve(?:Classroom)?WebSearch(?:Connection|Config)|webSearchConfigFromConnection|resolveMediaSlot|savedLanguageModel|savedMediaConnection|assertWorkspaceModelsAuthorized|startGenerationRun|requiredModelRefusal|applyModelSettingsChange)\(/;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    const api = join(process.cwd(), 'app/api');
    const calls = walk(api)
      .filter((file) => file.endsWith('/route.ts') && pattern.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(api.length + 1, -'/route.ts'.length))
      .sort();
    // Document services have no request-selected model id.
    expect(calls).toEqual(
      [...ROUTES.map((row) => row.path), 'parse-pdf', 'verify-pdf-provider'].sort(),
    );
    expect(new Set(ROUTES.map((row) => row.path)).size).toBe(ROUTES.length);
  });
});
