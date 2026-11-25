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

      expect(warnBareModelIdDeprecation('gpt-4.1', 'DEFAULT_MODEL')).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
