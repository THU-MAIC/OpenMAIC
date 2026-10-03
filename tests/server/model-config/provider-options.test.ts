/**
 * A provider's non-secret `options` (openmaic.yml), from the schema through
 * slot resolution and media connections to the TTS adapter: a VoxCPM
 * `backend` decides the endpoint the server synthesizes with.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Provider requests go through undici's fetch with a pinned dispatcher.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});

const { parseModelConfig, ModelConfigError } =
  await import('@/lib/server/model-config/openmaic-yml');
const { resolveSlot } = await import('@/lib/server/model-config/resolve-slot');
const runtime = await import('@/lib/server/model-config/runtime');
const { adapterOptions, resolveMediaSlot } = await import('@/lib/server/model-config/media');
const { applyModelSettingsChange, modelSettingsView } =
  await import('@/lib/server/model-config/settings');

type Config = import('@/lib/server/model-config/openmaic-yml').ModelConfigFile;

function deployment(config: Config) {
  runtime.setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy: false,
    notices: [],
  });
}

const voxcpm = (backend: string): Config => ({
  providers: {
    vox: { preset: 'voxcpm-tts', baseUrl: 'https://voxcpm.test', options: { backend } },
  },
  slots: { tts: 'vox' },
});

beforeEach(() => {
  runtime.setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
  fetchMock.mockReset().mockImplementation(
    async () =>
      new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      }),
  );
});

afterEach(() => {
  runtime.setDeploymentConfigForTests();
  vi.unstubAllEnvs();
});

describe('options in openmaic.yml', () => {
  it('accepts a map of scalar settings, with ${VAR} interpolation', () => {
    const config = parseModelConfig(
      [
        'providers:',
        '  vox:',
        '    preset: voxcpm-tts',
        '    baseUrl: https://voxcpm.test',
        '    options:',
        '      backend: ${VOXCPM_BACKEND}',
        '      cfgValue: 2.5',
        '      normalize: true',
      ].join('\n'),
      { env: { VOXCPM_BACKEND: 'python-api' } },
    );
    expect(config.providers?.vox.options).toEqual({
      backend: 'python-api',
      cfgValue: 2.5,
      normalize: true,
    });
  });

  it.each([
    ['a nested value', '      nested:\n        a: 1'],
    ['a list value', '      list: [1, 2]'],
    ['an invalid option name', '      "bad name": x'],
    ['a credential-like name (apiKey)', '      apiKey: x'],
    ['a credential-like name (secret)', '      clientSecret: x'],
    ['a credential-like name (token)', '      accessToken: x'],
    ['a credential-like name (password)', '      PASSWORD: x'],
  ])('refuses %s', (_label, line) => {
    expect(() =>
      parseModelConfig(
        [
          'providers:',
          '  vox:',
          '    preset: voxcpm-tts',
          '    baseUrl: https://voxcpm.test',
          '    options:',
          line,
        ].join('\n'),
        { env: {} },
      ),
    ).toThrow(ModelConfigError);
  });
});

describe('options through resolution', () => {
  it('reach the resolved target, the media connection and the settings view', async () => {
    const config = voxcpm('python-api');
    const resolution = resolveSlot('tts', [{ source: 'deployment', config }]);
    expect(resolution).toMatchObject({ status: 'assigned', options: { backend: 'python-api' } });

    deployment(config);
    const connection = await resolveMediaSlot('tts', { workspaceId: null });
    expect(connection.options).toEqual({ backend: 'python-api' });

    const tts = modelSettingsView(null).slots.find((slot) => slot.slot === 'tts')!.effective;
    expect(tts).toMatchObject({ status: 'assigned', options: { backend: 'python-api' } });
  });

  it("puts a configured provider's options over a request's, and not the other way round", () => {
    const request = { backend: 'vllm-omni', voicePrompt: 'warm' };
    expect(
      adapterOptions({ origin: 'configuration', options: { backend: 'python-api' } }, request),
    ).toEqual({ backend: 'python-api', voicePrompt: 'warm' });
    // While the slot is unassigned (the deprecated path) the request's win.
    expect(
      adapterOptions({ origin: 'request', options: { backend: 'python-api' } }, request),
    ).toEqual(request);
    expect(adapterOptions(null, request)).toEqual(request);
  });
});

describe('POST /api/generate/tts with a VoxCPM backend', () => {
  async function synthesize(backend: string) {
    deployment(voxcpm(backend));
    vi.resetModules();
    const runtimeAgain = await import('@/lib/server/model-config/runtime');
    runtimeAgain.setDeploymentConfigForTests({
      layer: { source: 'deployment', config: voxcpm(backend) },
      legacy: false,
      notices: [],
    });
    const { POST } = await import('@/app/api/generate/tts/route');
    const response = await POST(
      new NextRequest('http://localhost/api/generate/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Hello class',
          audioId: 'a1',
          ttsVoice: 'warm teacher',
          // A client of an earlier build naming another backend: the slot's wins.
          ttsProviderOptions: { backend: 'vllm-omni' },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const [url] = fetchMock.mock.calls.at(-1) as unknown as [string];
    runtimeAgain.setDeploymentConfigForTests();
    return String(url);
  }

  it('posts to the python-api endpoint', async () => {
    expect(await synthesize('python-api')).toBe('https://voxcpm.test/tts/upload');
  });

  it('posts to the vllm-omni endpoint', async () => {
    expect(await synthesize('vllm-omni')).toBe('https://voxcpm.test/v1/audio/speech');
  });
});

describe('voice registration follows the backend', () => {
  it('registration-capable providers follow the connection options', async () => {
    const { registrationCapableProviderIds } =
      await import('@/lib/server/agent-runtime/voice-clone-tools');
    const connection = (backend: string) => ({
      providerId: 'voxcpm-tts',
      options: { backend },
      managed: true,
      userEndpoint: false,
      origin: 'configuration' as const,
    });
    expect(registrationCapableProviderIds(connection('vllm-omni'))).toEqual(['voxcpm-tts']);
    expect(registrationCapableProviderIds(connection('python-api'))).toEqual([]);
  });

  it('POST /api/generate/voice refuses a backend without runtime registration', async () => {
    vi.resetModules();
    const runtimeAgain = await import('@/lib/server/model-config/runtime');
    runtimeAgain.setDeploymentConfigForTests({
      layer: { source: 'deployment', config: voxcpm('python-api') },
      legacy: false,
      notices: [],
    });
    const { POST } = await import('@/app/api/generate/voice/route');
    const response = await POST(
      new NextRequest('http://localhost/api/generate/voice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          voiceId: 'voice-1',
          descriptor: { identity: 'teacher', texture: 'warm', delivery: 'calm' },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    runtimeAgain.setDeploymentConfigForTests();
  });
});

describe('workspace providers', () => {
  it("cannot set options: they are the deployment's (openmaic.yml)", async () => {
    const next = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'mm',
      preset: 'minimax-tts',
      apiKey: 'sk-workspace-key-123',
      options: { backend: 'python-api' },
    } as never);
    expect(next.providers?.mm).toEqual({ preset: 'minimax-tts', apiKey: 'sk-workspace-key-123' });
  });
});
