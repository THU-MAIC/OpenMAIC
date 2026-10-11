/**
 * Real 1.1.x handlers and configuration/resolvers, with provider execution stubbed.
 * The inventory catches named resolver calls, not new direct SDK integrations or
 * aliased imports. Adapter wire-model behavior is covered by the transport suite.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ upstream: vi.fn(), constructed: vi.fn(), admitted: vi.fn() }));
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
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/ai/providers', async (original) => ({
  ...(await original<typeof import('@/lib/ai/providers')>()),
  getModel: (config: unknown) => {
    mocks.constructed(config);
    return { model: {}, modelInfo: undefined };
  },
}));
vi.mock('@/lib/ai/llm', () => ({
  callLLM: async () => {
    mocks.upstream();
    return {
      text: '{"score":1,"comment":"OK","agents":[{"id":"teacher","name":"Teacher","role":"teacher","persona":"Teach","avatar":"a"},{"id":"student","name":"Student","role":"student","persona":"Learn","avatar":"a"}]}',
    };
  },
  streamLLM: () => ({
    textStream: (async function* () {
      mocks.upstream();
      yield '{"languageDirective":"English","outlines":[{"id":"s","type":"slide","title":"A","description":"A","keyPoints":[]}]}';
    })(),
  }),
}));
vi.mock('@openmaic/generation', async (original) => ({
  ...(await original<typeof import('@openmaic/generation')>()),
  generateSceneContent: async (
    _outline: unknown,
    aiCall: (s: string, u: string) => Promise<string>,
  ) => {
    await aiCall('system', 'user');
    return { type: 'slide', elements: [] };
  },
  generateSceneActions: async (
    _outline: unknown,
    _content: unknown,
    aiCall: (s: string, u: string) => Promise<string>,
  ) => {
    await aiCall('system', 'user');
    return [];
  },
  buildCompleteScene: () => ({ actions: [] }),
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
  generateImage: async (config: unknown) => {
    mocks.upstream(config);
    return { url: 'https://cdn.example/image.png', width: 1024, height: 1024 };
  },
  testImageConnectivity: async (config: unknown) => {
    mocks.upstream(config);
    return { success: true, message: 'OK' };
  },
}));
vi.mock('@/lib/media/video-providers', async (original) => ({
  ...(await original<typeof import('@/lib/media/video-providers')>()),
  generateVideo: async (config: unknown) => {
    mocks.upstream(config);
    return { url: 'https://cdn.example/video.mp4', duration: 5 };
  },
  testVideoConnectivity: async (config: unknown) => {
    mocks.upstream(config);
    return { success: true, message: 'OK' };
  },
}));
vi.mock('@/lib/audio/tts-providers', () => ({
  QwenTTSError: class extends Error {},
  TTSInvalidResponseError: class extends Error {},
  TTSRateLimitError: class extends Error {},
  generateTTS: async (config: unknown) => {
    mocks.upstream(config);
    return { audio: new Uint8Array([1]), format: 'mp3' };
  },
}));
vi.mock('@/lib/audio/asr-providers', async (original) => ({
  ...(await original<typeof import('@/lib/audio/asr-providers')>()),
  transcribeAudio: async (config: unknown) => {
    mocks.upstream(config);
    return { text: 'OK' };
  },
}));
vi.mock('@/lib/server/audio-provider-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/audio-provider-fetch')>()),
  audioProviderFetch: async () => {
    mocks.upstream();
    return Response.json({ voices: ['voice'] });
  },
}));
vi.mock('@/lib/web-search', () => ({
  searchWeb: async (config: unknown) => {
    mocks.upstream(config);
    return { sources: [], answer: 'OK' };
  },
  formatSearchResultsAsContext: () => 'OK',
}));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: () => {},
}));
vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: async () => {
    mocks.admitted();
    return { status: 'pending' };
  },
}));
vi.mock('@/lib/server/classroom-job-runner', () => ({ runClassroomGenerationJob: async () => {} }));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: async () => {} }));
vi.mock('@/lib/server/ssrf-guard', async (original) => ({
  ...(await original<typeof import('@/lib/server/ssrf-guard')>()),
  validateClientBaseUrl: async () => null,
  validatePublicUrlForSSRF: async () => null,
}));

const refusal = {
  success: false,
  errorCode: 'PROVIDER_DISABLED',
  error: 'This model is not authorized for server-managed credentials',
};
function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/${path}`, {
    method: 'POST',
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
const outline = { id: 's', type: 'slide', title: 'A', description: 'A', keyPoints: [] };
const generationBodies: Record<string, unknown> = {
  'scene-content': { outline, allOutlines: [outline], stageId: 'classroom1' },
  'scene-actions': {
    outline,
    allOutlines: [outline],
    stageId: 'classroom1',
    content: { elements: [] },
  },
  'scene-outlines-stream': { requirements: { requirement: 'Teach', language: 'en' } },
  'agent-profiles': {
    stageInfo: { name: 'A' },
    languageDirective: 'English',
    availableAvatars: ['a'],
  },
};
interface RouteCase {
  path: string;
  invoke: (model: string) => Promise<Response>;
  admission?: boolean;
}
const handlers: Record<
  string,
  () => Promise<{ POST: (request: NextRequest) => Promise<Response> }>
> = {
  chat: () => import('@/app/api/chat/route'),
  'chat/pi': () => import('@/app/api/chat/pi/route'),
  'verify-model': () => import('@/app/api/verify-model/route'),
  'quiz-grade': () => import('@/app/api/quiz-grade/route'),
  'web-search': () => import('@/app/api/web-search/route'),
  transcription: () => import('@/app/api/transcription/route'),
  'generate-classroom': () => import('@/app/api/generate-classroom/route'),
  'generate/tts': () => import('@/app/api/generate/tts/route'),
  'generate/voice': () => import('@/app/api/generate/voice/route'),
  'generate/image': () => import('@/app/api/generate/image/route'),
  'generate/video': () => import('@/app/api/generate/video/route'),
  'verify-image-provider': () => import('@/app/api/verify-image-provider/route'),
  'verify-video-provider': () => import('@/app/api/verify-video-provider/route'),
  'pbl/v2/instructor': () => import('@/app/api/pbl/v2/instructor/route'),
  'pbl/v2/simulator': () => import('@/app/api/pbl/v2/simulator/route'),
  'pbl/v2/evaluate': () => import('@/app/api/pbl/v2/evaluate/route'),
  'pbl/v2/open-task': () => import('@/app/api/pbl/v2/open-task/route'),
  'generate/scene-content': () => import('@/app/api/generate/scene-content/route'),
  'generate/scene-actions': () => import('@/app/api/generate/scene-actions/route'),
  'generate/scene-outlines-stream': () => import('@/app/api/generate/scene-outlines-stream/route'),
  'generate/agent-profiles': () => import('@/app/api/generate/agent-profiles/route'),
};
const routes: RouteCase[] = [
  ...['chat', 'chat/pi'].map((path) => ({
    path,
    invoke: async (model: string) => (await handlers[path]()).POST(request(path, chatBody(model))),
  })),
  {
    path: 'verify-model',
    invoke: async (model) =>
      (await import('@/app/api/verify-model/route')).POST(
        request('verify-model', { model: `openai:${model}` }),
      ),
  },
  ...['instructor', 'simulator', 'evaluate', 'open-task'].map((endpoint) => ({
    path: `pbl/v2/${endpoint}`,
    invoke: async (model: string) =>
      (await handlers[`pbl/v2/${endpoint}`]()).POST(
        request(
          `pbl/v2/${endpoint}`,
          { project: { id: 'p' }, userMessage: 'hi', kind: 'final', phase: 'greeting' },
          { 'x-model': `openai:${model}` },
        ),
      ),
  })),
  {
    path: 'quiz-grade',
    invoke: async (model) =>
      (await import('@/app/api/quiz-grade/route')).POST(
        request(
          'quiz-grade',
          { question: 'Q', userAnswer: 'A', points: 1 },
          { 'x-model': `openai:${model}` },
        ),
      ),
  },
  ...Object.entries(generationBodies).map(([endpoint, body]) => ({
    path: `generate/${endpoint}`,
    invoke: async (model: string) =>
      (await handlers[`generate/${endpoint}`]()).POST(
        request(`generate/${endpoint}`, body, { 'x-model': `openai:${model}` }),
      ),
  })),
  ...['image', 'video'].flatMap((capability) =>
    [`generate/${capability}`, `verify-${capability}-provider`].map((path) => ({
      path,
      invoke: async (model: string) =>
        (await handlers[path]()).POST(
          request(
            path,
            { prompt: 'A tree' },
            {
              [`x-${capability}-provider`]: capability === 'image' ? 'seedream' : 'seedance',
              [`x-${capability}-model`]: model,
            },
          ),
        ),
    })),
  ),
  {
    path: 'generate/tts',
    invoke: async (model) =>
      (await import('@/app/api/generate/tts/route')).POST(
        request('generate/tts', {
          text: 'Hello',
          audioId: 'a',
          ttsProviderId: 'openai-tts',
          ttsModelId: model,
          ttsVoice: 'alloy',
        }),
      ),
  },
  {
    path: 'generate/voice',
    invoke: async (model) =>
      (await import('@/app/api/generate/voice/route')).POST(
        request('generate/voice', {
          providerId: 'voxcpm-tts',
          voiceId: 'voice',
          ttsModelId: model,
          referenceAudioBase64: 'AQ==',
        }),
      ),
  },
  {
    path: 'transcription',
    invoke: async (model) => {
      const form = new FormData();
      form.set('audio', new File([new Uint8Array([1])], 'a.wav'));
      form.set('providerId', 'openai-whisper');
      form.set('modelId', model);
      return (await import('@/app/api/transcription/route')).POST(
        new NextRequest('http://localhost/api/transcription', { method: 'POST', body: form }),
      );
    },
  },
  {
    path: 'web-search',
    invoke: async (model) =>
      (await import('@/app/api/web-search/route')).POST(
        request('web-search', { query: 'A', providerId: 'claude', claudeModelId: model }),
      ),
  },
  {
    path: 'generate-classroom',
    admission: true,
    invoke: async (model) =>
      (await import('@/app/api/generate-classroom/route')).POST(
        request('generate-classroom', {
          requirement: 'Teach',
          enableWebSearch: true,
          webSearchProviderId: 'claude',
          webSearchModelId: model,
        }),
      ),
  },
];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // Clear every provider env rather than borrowing the developer's credentials.
  for (const key of Object.keys(process.env))
    if (
      /(?:_API_KEY|_BASE_URL|_MODELS)$/.test(key) ||
      [
        'DEFAULT_MODEL',
        'MODEL_FALLBACK',
        'MODEL_ROUTES',
        'AWS_BEARER_TOKEN_BEDROCK',
        'BEDROCK_REGION',
      ].includes(key)
    )
      vi.stubEnv(key, undefined);
  for (const prefix of [
    'OPENAI',
    'IMAGE_SEEDREAM',
    'VIDEO_SEEDANCE',
    'TTS_OPENAI',
    'TTS_VOXCPM',
    'ASR_OPENAI',
    'WEB_SEARCH_CLAUDE',
  ]) {
    vi.stubEnv(`${prefix}_API_KEY`, 'server-key');
    vi.stubEnv(`${prefix}_MODELS`, 'allowed,allowed-second');
  }
  vi.stubEnv('TTS_VOXCPM_BASE_URL', 'https://voice.example/v1');
  vi.stubEnv('DEFAULT_MODEL', 'openai:allowed');
  vi.stubEnv('NEXT_PUBLIC_PI_CHAT_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('1.1.x model authorization route matrix', () => {
  for (const route of routes) {
    it(`${route.path}: allowed models reach provider execution or job admission`, async () => {
      const response = await route.invoke('allowed-second');
      await response.text();
      expect(route.admission ? mocks.admitted : mocks.upstream).toHaveBeenCalled();
      expect(response.status).toBeLessThan(400);
    });
    for (const model of ['not-listed', 'unknown-model'])
      it(`${route.path}: ${model} refuses before any upstream call`, async () => {
        const response = await route.invoke(model);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual(refusal);
        expect(mocks.upstream).not.toHaveBeenCalled();
        expect(mocks.constructed).not.toHaveBeenCalled();
        expect(mocks.admitted).not.toHaveBeenCalled();
      });
  }
  it('web-search: unauthorized query-rewrite model prevents search too', async () => {
    const response = await (
      await import('@/app/api/web-search/route')
    ).POST(
      request(
        'web-search',
        { query: 'A', providerId: 'claude', claudeModelId: 'allowed' },
        { 'x-model': 'openai:unknown-model' },
      ),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(refusal);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it('chat/pi: native search is checked before streaming', async () => {
    vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', 'true');
    const response = await (
      await import('@/app/api/chat/pi/route')
    ).POST(
      request('chat/pi', {
        ...chatBody('allowed'),
        webSearchProviderId: 'claude',
        webSearchModelId: 'unknown-model',
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(refusal);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it('includes every API route that calls a model resolver', () => {
    const found: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (
          entry.name === 'route.ts' &&
          /\b(?:resolveModel(?:FromHeaders|FromRequest)?|resolve(?:Image|Video|TTS|ASR|WebSearch)Model|resolveClassroomWebSearchConfig|authorizeServerModel)\s*\(/.test(
            readFileSync(file, 'utf8'),
          )
        )
          found.push(dir.slice(join(process.cwd(), 'app/api').length + 1));
      }
    }
    walk(join(process.cwd(), 'app/api'));
    expect(found.sort()).toEqual(routes.map((r) => r.path).sort());
  });
});
