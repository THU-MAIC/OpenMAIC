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
it('Bedrock credential chain is guarded in slots, request-body models and picker', async () => {
  const { resolveSlot } = await import('@/lib/server/model-config/resolve-slot');
  const config = { providers: { bedrock: { preset: 'bedrock', models: ['allowed'] } } };
  expect(() =>
    resolveSlot('course.content', [
      { source: 'deployment', config },
      { source: 'workspace', config: { slots: { llm: 'bedrock:unlisted' } } },
    ]),
  ).toThrow(/not authorized/);
  const runtime = await import('@/lib/server/model-config/runtime');
  runtime.setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy: false,
    notices: [],
  });
  const { resolveRequestedModel } = await import('@/lib/server/resolve-model');
  await expect(resolveRequestedModel({ modelString: 'bedrock:unlisted' })).rejects.toThrow(
    /not authorized/,
  );
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
  vi.stubEnv('WEB_SEARCH_CLAUDE_API_KEY', 'legacy-key');
  const { layer, notices } = loadDeploymentLayer();
  expect(layer).toBeNull();
  expect(notices).toEqual([expect.stringContaining('WEB_SEARCH_CLAUDE_API_KEY')]);
  expect(notices[0]).not.toContain('legacy-key');
});
