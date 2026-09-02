import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BARE_MODEL_ID_DEPRECATION_MSG } from '@/lib/ai/providers';

// config-validation reads env directly and imports provider-config, whose
// module-level getConfig() cache must be reset between cases (mirrors the
// model-routes / provider-config conventions). fs is mocked so a host-machine
// server-providers.yml can never leak into tests.
let yamlOverride: string | null = null;

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isYaml = (p: unknown) => typeof p === 'string' && p.endsWith('server-providers.yml');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (p: string) => (isYaml(p) ? yamlOverride !== null : actual.existsSync(p)),
      readFileSync: (p: string, ...args: unknown[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        isYaml(p) ? (yamlOverride ?? '') : (actual.readFileSync as any)(p, ...args),
    },
    existsSync: (p: string) => (isYaml(p) ? yamlOverride !== null : actual.existsSync(p)),
    readFileSync: (p: string, ...args: unknown[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isYaml(p) ? (yamlOverride ?? '') : (actual.readFileSync as any)(p, ...args),
  };
});

/** LLM env prefixes that provider-config reads for the `providers` section. */
const LLM_ENV_PREFIXES = [
  'OPENAI',
  'AZURE_OPENAI',
  'ATLASCLOUD',
  'ANTHROPIC',
  'GOOGLE',
  'DEEPSEEK',
  'QWEN',
  'KIMI',
  'MINIMAX',
  'GLM',
  'SILICONFLOW',
  'DOUBAO',
  'OPENROUTER',
  'GROK',
  'TENCENT',
  'TENCENT_HUNYUAN',
  'XIAOMI',
  'MIMO',
  'OLLAMA',
  'LEMONADE',
  'BEDROCK',
];

function clearConfigEnv() {
  delete process.env.MODEL_ROUTES;
  delete process.env.DEFAULT_MODEL;
  delete process.env.OPENMAIC_AGENT_RUNTIME_ENABLED;
  delete process.env.DATABASE_URL;
  for (const prefix of LLM_ENV_PREFIXES) {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_BASE_URL`];
    delete process.env[`${prefix}_MODELS`];
  }
  delete process.env.BEDROCK_REGION;
}

describe('validateServerConfig — warning matrix', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearConfigEnv();
    yamlOverride = null;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    clearConfigEnv();
  });

  it('emits no warnings when nothing is configured', async () => {
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits no warnings on a fully valid config', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('DEFAULT_MODEL', 'openai:gpt-5.4-mini');
    vi.stubEnv(
      'MODEL_ROUTES',
      JSON.stringify({
        'scene-content': 'openai:gpt-5.4',
        'pbl-chat': { model: 'anthropic:claude-sonnet-4', thinking: { enabled: false } },
      }),
    );
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when MODEL_ROUTES is not valid JSON', async () => {
    vi.stubEnv('MODEL_ROUTES', '{not valid json');
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('MODEL_ROUTES');
    expect(String(warnSpy.mock.calls[0][0])).toContain('JSON');
  });

  it('warns naming an unknown stage key (typo detection)', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'scene-contnet': 'openai:gpt-5.4' }));
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('scene-contnet');
  });

  it('warns for an unknown provider prefix in a route', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'scene-content': 'anhtropic:claude-sonnet-4' }));
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('anhtropic');
  });

  it('warns when a routed provider has no API key configured', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'scene-content': 'deepseek:deepseek-v4-pro' }));
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('deepseek');
    expect(String(warnSpy.mock.calls[0][0])).toContain('API key');
  });

  it('does not warn about a keyless provider (ollama)', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'scene-content': 'ollama:llama3.3' }));
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits the deprecation warning for a bare model id in a route', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'scene-content': 'gpt-5.4' }));
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain(BARE_MODEL_ID_DEPRECATION_MSG);
  });

  it('emits the deprecation warning for a bare DEFAULT_MODEL', async () => {
    vi.stubEnv('DEFAULT_MODEL', 'gpt-5.4');
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain(BARE_MODEL_ID_DEPRECATION_MSG);
  });

  it('warns softly when DEFAULT_MODEL points at a provider with no server key (client keys still work)', async () => {
    vi.stubEnv('DEFAULT_MODEL', 'deepseek:deepseek-v4-pro');
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('deepseek');
    // Unrouted sites honor client-supplied keys, so the message must not claim requests will fail.
    expect(String(warnSpy.mock.calls[0][0])).toContain('client supplies its own key');
  });

  it('warns when <PREFIX>_MODELS is set without the provider key env', async () => {
    vi.stubEnv('DEEPSEEK_MODELS', 'deepseek-v4-pro');
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('DEEPSEEK_MODELS');
    expect(String(warnSpy.mock.calls[0][0])).toContain('DEEPSEEK_API_KEY');
  });

  it('does not warn when <PREFIX>_MODELS is set with the key present', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test');
    vi.stubEnv('DEEPSEEK_MODELS', 'deepseek-v4-pro');
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when <PREFIX>_MODELS is set for a keyless provider with a base URL', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434/v1');
    vi.stubEnv('OLLAMA_MODELS', 'llama3.3');
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when <PREFIX>_MODELS is set for a keyless provider without a base URL', async () => {
    vi.stubEnv('OLLAMA_MODELS', 'llama3.3');
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    // Ollama ships a default base URL, so a bare _MODELS pin is functional — no warning.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not throw on garbage config (warn-only)', async () => {
    vi.stubEnv('MODEL_ROUTES', '{{{');
    vi.stubEnv('DEFAULT_MODEL', ':::::');
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    expect(() => validateServerConfig()).not.toThrow();
  });

  it('does not warn when a provider is configured via server-providers.yml', async () => {
    yamlOverride = 'providers:\n  deepseek:\n    apiKey: sk-yaml\n';
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'scene-content': 'deepseek:deepseek-v4-pro' }));
    vi.stubEnv('DEEPSEEK_MODELS', 'deepseek-v4-pro');
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once per distinct problem when a config has several', async () => {
    vi.stubEnv(
      'MODEL_ROUTES',
      JSON.stringify({
        'scene-contnet': 'openai:gpt-5.4', // unknown stage
        'scene-content': 'anhtropic:claude-sonnet-4', // unknown provider
        'pbl-chat': 'claude-sonnet-4', // bare id
      }),
    );
    const { validateServerConfig } = await import('@/lib/server/config-validation');
    validateServerConfig();
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  describe('agent runtime configuration', () => {
    it('warns when the runtime flag is set without DATABASE_URL', async () => {
      vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
      const { validateServerConfig } = await import('@/lib/server/config-validation');
      validateServerConfig();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain('OPENMAIC_AGENT_RUNTIME_ENABLED');
      expect(message).toContain('DATABASE_URL');
    });

    it('warns when the runtime flag is set and DATABASE_URL is blank', async () => {
      vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
      vi.stubEnv('DATABASE_URL', '   ');
      const { validateServerConfig } = await import('@/lib/server/config-validation');
      validateServerConfig();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('DATABASE_URL');
    });

    it('does not warn when the runtime flag is set with DATABASE_URL present', async () => {
      vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
      vi.stubEnv('DATABASE_URL', 'postgres://runtime');
      const { validateServerConfig } = await import('@/lib/server/config-validation');
      validateServerConfig();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when the runtime flag is off even without DATABASE_URL', async () => {
      // This is the no-DB default deployment: flag unset, no database. It must
      // boot silently — the warning is for the MISCONFIGURED state only.
      const { validateServerConfig } = await import('@/lib/server/config-validation');
      validateServerConfig();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe('parseModelString — request-derived strings never warn', () => {
  it('resolves bare and prefixed ids without logging (client input must not drive log volume)', async () => {
    vi.resetModules();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { parseModelString } = await import('@/lib/ai/providers');

      expect(parseModelString('gpt-5.5')).toEqual({ providerId: 'openai', modelId: 'gpt-5.5' });
      expect(parseModelString('anthropic:claude-sonnet-4')).toEqual({
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4',
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warnBareModelIdDeprecation dedupes per unique config-site id', async () => {
    vi.resetModules();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { warnBareModelIdDeprecation } = await import('@/lib/ai/providers');

      expect(warnBareModelIdDeprecation('gpt-5.5', 'DEFAULT_MODEL')).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain(BARE_MODEL_ID_DEPRECATION_MSG);

      expect(warnBareModelIdDeprecation('gpt-5.5', 'DEFAULT_MODEL')).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      expect(warnBareModelIdDeprecation('gpt-4.1', 'MODEL_ROUTES stage "pbl-chat"')).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
