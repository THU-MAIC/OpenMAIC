/** What the workspace's model settings let the client do, read from the server's view. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureModelSettings,
  MODEL_SETTINGS_RETRY_MS,
  effectiveTarget,
  llmUsable,
  loadModelCapabilities,
  mediaGenerationDisabled,
  modelCapabilities,
} from '@/lib/model-settings/capabilities';
import { createModelSettingsClient } from '@/lib/model-settings/client';
import {
  serverTTSAvailable,
  slotTTSProvidersConfig,
  ttsSelection,
} from '@/lib/audio/tts-selection';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';

import { modelSettingsViewFor } from '../helpers/model-settings-view';

describe('modelCapabilities', () => {
  it('knows nothing without a view, and then neither blocks nor disables', () => {
    const capabilities = modelCapabilities(null);
    expect(capabilities.known).toBe(false);
    expect(llmUsable(capabilities)).toBe(true);
    expect(mediaGenerationDisabled(capabilities, 'image')).toBe(false);
  });

  it("keeps the browser's own speech recognition while the asr slot is unassigned", () => {
    expect(modelCapabilities(modelSettingsViewFor({})).asr?.registryId).toBe('browser-native');
    expect(modelCapabilities(null).asr?.registryId).toBe('browser-native');
    // A server speech service when one is assigned...
    expect(
      modelCapabilities(modelSettingsViewFor({ asr: { registryId: 'openai-whisper' } })).asr
        ?.registryId,
    ).toBe('openai-whisper');
    // ...and none once the slot is turned off.
    const off = modelSettingsViewFor({});
    off.slots = off.slots.map((slot) =>
      slot.slot === 'asr'
        ? { ...slot, effective: { status: 'disabled', resolvedAt: 'asr', source: 'workspace' } }
        : slot,
    );
    expect(modelCapabilities(off).asr).toBeNull();
  });

  it('reads the target each root resolves to', () => {
    const view = modelSettingsViewFor({
      llm: { registryId: 'openai', providerId: 'my-openai', modelId: 'gpt-5' },
      image: { registryId: 'seedream', modelId: 'seedream-5' },
    });
    const capabilities = modelCapabilities(view);
    expect(capabilities.known).toBe(true);
    expect(capabilities.llm).toMatchObject({
      providerId: 'my-openai',
      registryId: 'openai',
      modelId: 'gpt-5',
    });
    expect(capabilities.llm).not.toHaveProperty('status');
    expect(capabilities.image?.registryId).toBe('seedream');
    expect(capabilities.video).toBeNull();
    expect(mediaGenerationDisabled(capabilities, 'image')).toBe(false);
    expect(mediaGenerationDisabled(capabilities, 'video')).toBe(true);
    expect(llmUsable(capabilities)).toBe(true);
  });

  it('reports a workspace without a language model', () => {
    const capabilities = modelCapabilities(modelSettingsViewFor({}));
    expect(capabilities.llm).toBeNull();
    expect(llmUsable(capabilities)).toBe(false);
  });

  it('treats a slot that is off or invalid as resolving to nothing', () => {
    const view = modelSettingsViewFor({ tts: { registryId: 'openai-tts' } });
    const slot = view.slots.find((entry) => entry.slot === 'tts')!;
    slot.effective = { status: 'disabled', resolvedAt: 'tts', source: 'workspace' };
    expect(effectiveTarget(view, 'tts')).toBeNull();
    slot.effective = { status: 'invalid', message: 'no such provider' };
    expect(effectiveTarget(view, 'tts')).toBeNull();
  });
});

describe('loadModelCapabilities', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the view once and then answers from it', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify(modelSettingsViewFor({ llm: { registryId: 'openai', modelId: 'm' } })),
          {
            status: 200,
          },
        ),
    );
    const client = createModelSettingsClient(fetch);
    expect((await loadModelCapabilities(client)).llm?.modelId).toBe('m');
    expect((await loadModelCapabilities(client)).llm?.modelId).toBe('m');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('knows nothing when the server keeps no settings', async () => {
    const client = createModelSettingsClient(async () => new Response('', { status: 404 }));
    expect((await loadModelCapabilities(client)).known).toBe(false);
  });
});

describe('speech synthesis from the tts slot', () => {
  it('offers only the slot provider to the voice helpers', () => {
    const map = slotTTSProvidersConfig({
      providerId: 'tts',
      providerSource: 'workspace',
      presetId: 'openai-tts',
      registryId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
    });
    expect(isTTSProviderEnabled('openai-tts', map['openai-tts'])).toBe(true);
    expect(map['openai-tts'].modelId).toBe('gpt-4o-mini-tts');
    expect(isTTSProviderEnabled('qwen-tts', map['qwen-tts'])).toBe(false);
    expect(isTTSProviderEnabled('browser-native-tts', map['browser-native-tts'])).toBe(false);
  });

  it('keeps the user voice only for the provider it was picked for', () => {
    const capabilities = modelCapabilities(
      modelSettingsViewFor({ tts: { registryId: 'openai-tts' } }),
    );
    expect(
      ttsSelection(capabilities, { voice: 'nova', providerId: 'openai-tts', speed: 1.2 }),
    ).toMatchObject({ providerId: 'openai-tts', voice: 'nova', speed: 1.2 });
    // A voice picked for another provider does not follow the slot.
    expect(
      ttsSelection(capabilities, { voice: 'Cherry', providerId: 'qwen-tts', speed: 1 })?.voice,
    ).not.toBe('Cherry');
  });

  it('narrates on the server unless the slot is browser speech or off', () => {
    expect(
      serverTTSAvailable(
        modelCapabilities(modelSettingsViewFor({ tts: { registryId: 'openai-tts' } })),
      ),
    ).toBe(true);
    const browser = modelCapabilities(
      modelSettingsViewFor({ tts: { registryId: 'browser-native-tts' } }),
    );
    expect(serverTTSAvailable(browser)).toBe(false);
    expect(slotTTSProvidersConfig(browser.tts)['browser-native-tts'].enabled).toBe(true);
    expect(serverTTSAvailable(modelCapabilities(modelSettingsViewFor({})))).toBe(false);
    expect(ttsSelection(modelCapabilities(modelSettingsViewFor({})))).toBeNull();
  });
});

describe('a failed read is not the last word', () => {
  afterEach(() => vi.useRealTimers());

  it('loadModelCapabilities reads again after a failure', async () => {
    const view = modelSettingsViewFor({ llm: { registryId: 'openai', modelId: 'm' } });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify(view), { status: 200 }));
    const client = createModelSettingsClient(fetch);
    expect((await loadModelCapabilities(client)).known).toBe(false);
    expect((await loadModelCapabilities(client)).llm?.modelId).toBe('m');
  });

  it('ensureModelSettings retries a failed read with backoff until one succeeds', async () => {
    vi.useFakeTimers();
    const view = modelSettingsViewFor({ tts: { registryId: 'openai-tts' } });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValue(new Response(JSON.stringify(view), { status: 200 }));
    const client = createModelSettingsClient(fetch);

    ensureModelSettings(client);
    await vi.waitFor(() => expect(client.getState().phase).toBe('error'));
    ensureModelSettings(client);
    // A second call while a retry is scheduled schedules nothing more.
    ensureModelSettings(client);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MODEL_SETTINGS_RETRY_MS[0]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MODEL_SETTINGS_RETRY_MS[1]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(client.getState().phase).toBe('ready');
    expect(modelCapabilities(client.getState().view).tts?.registryId).toBe('openai-tts');

    // Read: nothing more is scheduled.
    ensureModelSettings(client);
    await vi.advanceTimersByTimeAsync(MODEL_SETTINGS_RETRY_MS.at(-1)! * 2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
