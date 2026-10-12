import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const calls = vi.hoisted(() => ({ modelId: '' }));
vi.mock('@/lib/ai/llm', () => ({
  callLLM: async (params: { model: { modelId: string } }) => {
    calls.modelId = params.model.modelId;
    return { text: 'OK', sources: [] };
  },
}));
let dir: string;
beforeEach(() => {
  vi.resetModules();
  calls.modelId = '';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-authorization-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  for (const key of [
    'DATABASE_URL',
    'OPENMAIC_CONFIG',
    'DEFAULT_MODEL',
    'MODEL_FALLBACK',
    'MODEL_ROUTES',
    'OLLAMA_API_KEY',
    'OLLAMA_BASE_URL',
    'BEDROCK_BASE_URL',
    'TAVILY_API_KEY',
    'PDF_MINERU_CLOUD_API_KEY',
    'WEB_SEARCH_CLAUDE_API_KEY',
    'TTS_AZURE_API_KEY',
    'ASR_AZURE_API_KEY',
  ])
    vi.stubEnv(key, '');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
it('normalizes YAML model lists, defaults and fallbacks before authorization and SDK construction', async () => {
  const { parseModelConfig } = await import('@/lib/server/model-config/openmaic-yml');
  const config = parseModelConfig(`providers:
  search:
    preset: claude
    apiKey: server-key
    models: [" claude-sonnet-5 "]
  chat:
    preset: openai
    apiKey: server-key
    models: [" allowed "]
slots:
  webSearch: "search: claude-sonnet-5 "
  llm:
    model: "chat: allowed "
    fallback: "chat: fallback "
`);
  expect(config.providers?.search.models).toEqual(['claude-sonnet-5']);
  expect(config.slots?.llm).toEqual({ model: 'chat:allowed', fallback: 'chat:fallback' });
  const runtime = await import('@/lib/server/model-config/runtime');
  runtime.setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy: false,
    notices: [],
  });
  runtime.setWorkspaceLayerLoaderForTests(async () => null);
  const { resolveWebSearchConnection } = await import('@/lib/server/web-search-config');
  const { searchWeb } = await import('@/lib/web-search');
  const connection = await resolveWebSearchConnection(null);
  expect(connection.claudeModelId).toBe('claude-sonnet-5');
  await searchWeb({ ...connection, query: 'test' });
  expect(calls.modelId).toBe('claude-sonnet-5');
  expect(() =>
    parseModelConfig('providers:\n  chat:\n    preset: openai\n    models: [" "]'),
  ).toThrow(/providers.chat.models.0/);
  expect(() => parseModelConfig('slots:\n  llm: "chat: "')).toThrow(/model id must not be blank/);
});
it.each(['ollama', 'lemonade', 'openai-compatible'])(
  'keyless YAML %s retains arbitrary assignments and picker models',
  async (preset) => {
    const { parseModelConfig } = await import('@/lib/server/model-config/openmaic-yml');
    const config = parseModelConfig(
      `providers:\n  local:\n    preset: ${preset}\n    baseUrl: http://localhost:11434\n`,
    );
    const { resolveSlot } = await import('@/lib/server/model-config/resolve-slot');
    const layers = [
      { source: 'deployment' as const, config },
      { source: 'workspace' as const, config: { slots: { llm: 'local:custom-model' } } },
    ];
    expect(resolveSlot('course.content', layers)).toMatchObject({ modelId: 'custom-model' });
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests({ layer: layers[0], legacy: false, notices: [] });
    const { modelSettingsView } = await import('@/lib/server/model-config/settings');
    const view = modelSettingsView(null);
    const { PROVIDER_PRESETS } = await import('@/lib/config/provider-presets');
    const { presetModels } = await import('@/lib/config/provider-presets');
    expect(view.providers[0].capabilities.chat?.models).toEqual(
      preset === 'openai-compatible'
        ? []
        : presetModels(PROVIDER_PRESETS.find((p) => p.id === preset)!, 'chat'),
    );
  },
);
it('keyless legacy Ollama remains usable in slot and request resolution without a model list', async () => {
  vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
  vi.stubEnv('DEFAULT_MODEL', 'ollama:llama3');
  const runtime = await import('@/lib/server/model-config/runtime');
  runtime.setWorkspaceLayerLoaderForTests(async () => ({
    source: 'workspace',
    config: { slots: { llm: 'ollama:qwen2' } },
  }));
  const { resolveRequestedModel } = await import('@/lib/server/resolve-model');
  expect(await resolveRequestedModel({ modelString: 'ollama:qwen2' })).toMatchObject({
    modelId: 'qwen2',
    apiKey: '',
  });
  const { lookupSlot } = await import('@/lib/server/model-config/runtime');
  expect(await lookupSlot('course.content', 'owner')).toMatchObject({ modelId: 'qwen2' });
  const { modelSettingsView } = await import('@/lib/server/model-config/settings');
  const { presetModels, getProviderPreset } = await import('@/lib/config/provider-presets');
  expect(modelSettingsView(null).providers[0].capabilities.chat?.models).toEqual(
    presetModels(getProviderPreset('ollama')!, 'chat'),
  );
});
it('Bedrock credential chain is guarded in slots, legacy requests and picker', async () => {
  const { resolveSlot } = await import('@/lib/server/model-config/resolve-slot');
  const config = { providers: { bedrock: { preset: 'bedrock', models: ['allowed'] } } };
  expect(() =>
    resolveSlot('course.content', [
      { source: 'deployment', config },
      { source: 'workspace', config: { slots: { llm: 'bedrock:unlisted' } } },
    ]),
  ).toThrow(/not authorized/);
  vi.stubEnv('BEDROCK_BASE_URL', 'https://bedrock.example');
  const runtime = await import('@/lib/server/model-config/runtime');
  runtime.setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy: true,
    notices: [],
  });
  const { resolveRequestedModel } = await import('@/lib/server/resolve-model');
  await expect(resolveRequestedModel({ modelString: 'bedrock:unlisted' })).rejects.toMatchObject({
    code: 'PROVIDER_DISABLED',
    httpStatus: 403,
  });
  const { modelSettingsView } = await import('@/lib/server/model-config/settings');
  expect(modelSettingsView(null).providers[0].capabilities.chat?.models.map((m) => m.id)).toEqual([
    'allowed',
  ]);
});
it('startup warns only for credentialed model selection in YAML and legacy configuration', async () => {
  const { loadDeploymentLayer } = await import('@/lib/server/model-config/deployment-layer');
  fs.writeFileSync(
    path.join(dir, 'openmaic.yml'),
    `providers:
  parser:
    preset: mineru-cloud
    apiKey: key
  search:
    preset: tavily
    apiKey: key
  chat:
    preset: openai
    apiKey: key
  chain:
    preset: bedrock
  local:
    preset: ollama
  voice:
    preset: azure-tts
    apiKey: key
  speech:
    preset: azure-asr
    apiKey: key
`,
  );
  expect(loadDeploymentLayer().notices.filter((n) => n.includes('no explicit model list'))).toEqual(
    [
      expect.stringContaining('providers.chat.models'),
      expect.stringContaining('providers.chain.models'),
    ],
  );
  fs.unlinkSync(path.join(dir, 'openmaic.yml'));
  vi.stubEnv('TAVILY_API_KEY', 'key');
  vi.stubEnv('PDF_MINERU_CLOUD_API_KEY', 'key');
  vi.stubEnv('WEB_SEARCH_CLAUDE_API_KEY', 'key');
  vi.stubEnv('TTS_AZURE_API_KEY', 'key');
  vi.stubEnv('ASR_AZURE_API_KEY', 'key');
  vi.resetModules();
  const loader = await import('@/lib/server/model-config/deployment-layer');
  expect(
    loader.loadDeploymentLayer().notices.filter((n) => n.includes('no explicit model list')),
  ).toEqual([expect.stringContaining('WEB_SEARCH_CLAUDE_MODELS')]);
});
it('empty legacy model fields select capability defaults before authorization', async () => {
  for (const key of [
    'TTS_OPENAI_API_KEY',
    'ASR_OPENAI_API_KEY',
    'IMAGE_MINIMAX_API_KEY',
    'VIDEO_MINIMAX_API_KEY',
    'WEB_SEARCH_CLAUDE_API_KEY',
    'TTS_AZURE_API_KEY',
    'ASR_AZURE_API_KEY',
  ])
    vi.stubEnv(key, 'server-key');
  const pc = await import('@/lib/server/provider-config');
  expect(pc.resolveTTSModel('openai-tts', '')).toBe('gpt-4o-mini-tts');
  expect(pc.resolveASRModel('openai-whisper', '')).toBe('gpt-4o-mini-transcribe');
  expect(pc.resolveImageModel('minimax-image', '')).toBe('image-01');
  expect(pc.resolveVideoModel('minimax-video', '')).toBe('MiniMax-Hailuo-2.3');
  expect(pc.resolveWebSearchModel('claude', '')).toBe('claude-sonnet-5');
});

it('normalizes legacy default and fallback model ids at configuration load', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'server-key');
  vi.stubEnv('DEFAULT_MODEL', 'openai: allowed \u00a0');
  vi.stubEnv('MODEL_FALLBACK', 'openai: fallback ');
  const { deploymentConfig } = await import('@/lib/server/model-config/runtime');
  expect(deploymentConfig().layer?.config.slots?.llm).toEqual({
    model: 'openai:allowed',
    fallback: 'openai:fallback',
  });
  const { resolveStageModel } = await import('@/lib/server/model-config/llm');
  const resolved = await resolveStageModel({ stage: 'scene-content', workspaceId: null });
  expect(resolved.modelId).toBe('allowed');
  expect((resolved.model as { modelId: string }).modelId).toBe('allowed');
});
