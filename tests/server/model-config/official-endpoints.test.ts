/**
 * Official regional endpoints (lib/config/official-endpoints.ts): Azure
 * Speech names its region with an endpoint of its own, which a workspace may
 * set, checked strictly at save time and at resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { officialRegionalEndpoint } from '@/lib/config/official-endpoints';
import { mediaConnectionFor, WorkspaceEndpointError } from '@/lib/server/model-config/media';
import { resolveModelReference } from '@/lib/server/model-config/resolve-slot';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import {
  applyModelSettingsChange,
  importModelSettings,
  modelSettingsView,
} from '@/lib/server/model-config/settings';

const TTS = 'https://westeurope.tts.speech.microsoft.com';
const ASR = 'https://westeurope.api.cognitive.microsoft.com';

const BAD_HOSTS = [
  'https://evil.com',
  'https://westeurope.tts.speech.microsoft.com.evil.com',
  'https://evil.com/westeurope.tts.speech.microsoft.com',
  'https://evil.com\\@westeurope.tts.speech.microsoft.com',
  'https://evil.com#westeurope.tts.speech.microsoft.com',
  'https://user:pw@westeurope.tts.speech.microsoft.com',
  'https://westeurope.tts.speech.microsoft.com@evil.com',
  'http://westeurope.tts.speech.microsoft.com',
  'https://westeurope.tts.speech.microsoft.com:8443',
  'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1',
  'https://westeurope.tts.speech.microsoft.com?x=1',
  'https://west-europe.tts.speech.microsoft.com',
  'https://a.b.tts.speech.microsoft.com',
  'https://{region}.tts.speech.microsoft.com',
  'https://tts.speech.microsoft.com',
  ' https://westeurope.tts.speech.microsoft.com',
  'westeurope.tts.speech.microsoft.com',
];

beforeEach(() => {
  vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
});

afterEach(() => {
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
});

describe('officialRegionalEndpoint', () => {
  it('accepts the official Azure Speech host of a region, normalised', () => {
    expect(officialRegionalEndpoint('tts', 'azure-tts', TTS)).toBe(TTS);
    expect(officialRegionalEndpoint('tts', 'azure-tts', `${TTS}/`)).toBe(TTS);
    expect(
      officialRegionalEndpoint('tts', 'azure-tts', 'https://EastUS2.tts.speech.microsoft.com'),
    ).toBe('https://eastus2.tts.speech.microsoft.com');
    expect(officialRegionalEndpoint('asr', 'azure-asr', ASR)).toBe(ASR);
    expect(
      officialRegionalEndpoint('asr', 'azure-asr', 'https://westeurope.stt.speech.microsoft.com'),
    ).toBe('https://westeurope.stt.speech.microsoft.com');
  });

  it('refuses anything but the bare official host', () => {
    for (const url of BAD_HOSTS) {
      expect(officialRegionalEndpoint('tts', 'azure-tts', url), url).toBeUndefined();
    }
    // Each service takes only its own host.
    expect(officialRegionalEndpoint('asr', 'azure-asr', TTS)).toBeUndefined();
    expect(officialRegionalEndpoint('tts', 'azure-tts', ASR)).toBeUndefined();
    // Services without regional endpoints have none.
    expect(officialRegionalEndpoint('tts', 'openai-tts', TTS)).toBeUndefined();
    expect(officialRegionalEndpoint('chat', 'openai', TTS)).toBeUndefined();
  });
});

describe('workspace Azure Speech providers', () => {
  it('saves the official regional endpoint, normalised, and serves media with it', async () => {
    const config = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'azure-tts',
      preset: 'azure-tts',
      apiKey: 'azure-key-0123456789',
      baseUrl: `${TTS}/`,
    });
    expect(config.providers?.['azure-tts']).toEqual({
      preset: 'azure-tts',
      apiKey: 'azure-key-0123456789',
      baseUrl: TTS,
    });
    // Assignable to its media slot: the endpoint is the service's own.
    const assigned = await applyModelSettingsChange(config, {
      kind: 'slots',
      set: { tts: 'azure-tts' },
    });
    const layers = [{ source: 'workspace' as const, config: assigned }];
    const target = resolveModelReference('azure-tts', 'tts', layers);
    expect(target.baseUrl).toBe(TTS);
    expect(target.customBaseUrl).toBeUndefined();
    await expect(mediaConnectionFor('tts', target)).resolves.toMatchObject({
      providerId: 'azure-tts',
      baseUrl: TTS,
      managed: false,
      userEndpoint: false,
    });
    // The view offers it for speech, not as a chat-only custom endpoint.
    const view = modelSettingsView({ config: assigned, revision: 1, unreadableSecrets: [] });
    expect(view.providers.find((p) => p.id === 'azure-tts')?.capabilities.tts).toBeDefined();
    const preset = view.presets.find((p) => p.id === 'azure-tts');
    expect(preset).toMatchObject({
      requiresBaseUrl: true,
      customEndpoint: true,
      regionalEndpoint: 'https://<region>.tts.speech.microsoft.com',
    });
  });

  it('accepts the transcription service at its regional host', async () => {
    const config = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'azure-asr',
      preset: 'azure-asr',
      apiKey: 'azure-key-0123456789',
      baseUrl: ASR,
    });
    await expect(
      applyModelSettingsChange(config, { kind: 'slots', set: { asr: 'azure-asr' } }),
    ).resolves.toBeTruthy();
  });

  it('refuses any other endpoint, and none at all', async () => {
    for (const baseUrl of BAD_HOSTS) {
      await expect(
        applyModelSettingsChange(null, {
          kind: 'provider',
          id: 'azure-tts',
          preset: 'azure-tts',
          apiKey: 'k',
          baseUrl,
        }),
        baseUrl,
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER' });
    }
    await expect(
      applyModelSettingsChange(null, {
        kind: 'provider',
        id: 'a',
        preset: 'azure-tts',
        apiKey: 'k',
      }),
    ).rejects.toThrow(/regional endpoint/);
  });

  it('refuses a stored custom endpoint at resolution', async () => {
    // A configuration stored around the save-time check still cannot reach media.
    const layers = [
      {
        source: 'workspace' as const,
        config: {
          providers: {
            a: {
              preset: 'azure-tts',
              apiKey: 'k',
              baseUrl: 'https://westeurope.tts.speech.microsoft.com.evil.com',
            },
          },
        },
      },
    ];
    const target = resolveModelReference('a', 'tts', layers);
    expect(target.customBaseUrl).toBe(true);
    await expect(mediaConnectionFor('tts', target)).rejects.toBeInstanceOf(WorkspaceEndpointError);
  });

  it('imports a browser provider with its regional endpoint', async () => {
    const result = await importModelSettings(null, {
      providers: {
        'azure-tts': { preset: 'azure-tts', apiKey: 'azure-key-0123456789', baseUrl: TTS },
        evil: { preset: 'azure-tts', apiKey: 'k', baseUrl: 'https://evil.com' },
      },
      slots: { tts: 'azure-tts' },
    });
    expect(result.imported).toEqual([
      { kind: 'provider', id: 'azure-tts' },
      { kind: 'slot', id: 'tts' },
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ kind: 'provider', id: 'evil', code: 'INVALID_PROVIDER' }),
    ]);
    expect(result.config.providers?.['azure-tts']?.baseUrl).toBe(TTS);

    // Imported again, in the form the browser staged it (its endpoint not yet
    // normalised): the workspace holds the same provider.
    const again = await importModelSettings(result.config, {
      providers: {
        'azure-tts': { preset: 'azure-tts', apiKey: 'azure-key-0123456789', baseUrl: `${TTS}/` },
      },
    });
    expect(again.skipped).toEqual([
      expect.objectContaining({ kind: 'provider', id: 'azure-tts', code: 'EXISTS_SAME' }),
    ]);
  });
});
