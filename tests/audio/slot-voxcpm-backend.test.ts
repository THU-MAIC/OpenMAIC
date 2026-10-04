/** The client reads the VoxCPM backend from the tts slot's options. */
import { afterEach, describe, expect, it, vi } from 'vitest';

// db is browser-only (Dexie); stub it so the voice modules load in node.
vi.mock('@/lib/device-storage/database', () => ({
  db: {
    autoVoiceCache: { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) },
    voiceProfiles: { get: vi.fn(async () => undefined) },
  },
}));

import { resolveAgentVoiceOptions } from '@/lib/audio/agent-voice';
import { VOXCPM_AUTO_VOICE_ID } from '@/lib/audio/voxcpm';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

import { slotTTSProvidersConfig, slotVoxCPMBackend } from '@/lib/audio/tts-selection';
import { getEnabledProvidersWithVoices } from '@/lib/audio/voice-resolver';
import { getVoxCPMProfileVoiceId } from '@/lib/audio/voxcpm';
import { modelCapabilities, type EffectiveTarget } from '@/lib/model-settings/capabilities';

import { modelSettingsViewFor } from '../helpers/model-settings-view';

const voxcpm = (options?: Record<string, string>): EffectiveTarget => ({
  providerId: 'vox',
  providerSource: 'deployment',
  presetId: 'voxcpm-tts',
  registryId: 'voxcpm-tts',
  ...(options ? { options } : {}),
});

describe('the VoxCPM backend on the client', () => {
  it("is the tts slot's backend option, else the default", () => {
    expect(slotVoxCPMBackend(voxcpm({ backend: 'python-api' }))).toBe('python-api');
    expect(slotVoxCPMBackend(voxcpm({ backend: 'nano-vllm' }))).toBe('nano-vllm');
    expect(slotVoxCPMBackend(voxcpm())).toBe('vllm-omni');
    expect(slotVoxCPMBackend(null)).toBe('vllm-omni');
  });

  it('reaches the client from the settings view', () => {
    const view = modelSettingsViewFor({ tts: { registryId: 'voxcpm-tts' } });
    const tts = view.slots.find((slot) => slot.slot === 'tts')!;
    if (tts.effective.status === 'assigned') tts.effective.options = { backend: 'python-api' };
    expect(slotVoxCPMBackend(modelCapabilities(view).tts)).toBe('python-api');
  });

  it('decides which of the user voices the provider can speak', () => {
    const profiles = [
      { id: 'p1', providerId: 'voxcpm-tts', name: 'Prompt voice', kind: 'prompt' },
      { id: 'c1', providerId: 'voxcpm-tts', name: 'Clone voice', kind: 'clone' },
    ];
    const voices = (backend: string) =>
      getEnabledProvidersWithVoices(
        slotTTSProvidersConfig(voxcpm({ backend })),
        profiles,
      )[0].voices.map((voice) => voice.id);
    // Reference audio (clones) needs a backend that takes it.
    expect(voices('vllm-omni')).toContain(getVoxCPMProfileVoiceId('c1'));
    expect(
      slotTTSProvidersConfig(voxcpm({ backend: 'python-api' }))['voxcpm-tts'].providerOptions,
    ).toEqual({ backend: 'python-api' });
  });
});

describe('auto voices follow the backend', () => {
  afterEach(() => vi.unstubAllGlobals());

  const teacher = {
    id: 't',
    name: 'Teacher',
    role: 'teacher',
    voiceDesign: { identity: 'calm teacher', texture: 'warm', delivery: 'slow' },
  } as unknown as AgentConfig;

  async function optionsFor(backend: string) {
    const fetch = vi.fn(async () => Response.json({ voiceId: 'registered-1' }));
    vi.stubGlobal('fetch', fetch);
    const options = await resolveAgentVoiceOptions(teacher, {
      providerId: 'voxcpm-tts',
      providerConfig: slotTTSProvidersConfig(voxcpm({ backend }))['voxcpm-tts'],
      voiceId: VOXCPM_AUTO_VOICE_ID,
    });
    return { options, fetch };
  }

  it('registers the voice where the backend supports runtime registration', async () => {
    const { options, fetch } = await optionsFor('vllm-omni');
    expect(fetch).toHaveBeenCalledWith('/api/generate/voice', expect.anything());
    expect(options).toMatchObject({ backend: 'vllm-omni', registeredVoiceId: 'registered-1' });
  });

  it('keeps the inline voice prompt on a backend without it', async () => {
    const { options, fetch } = await optionsFor('python-api');
    expect(fetch).not.toHaveBeenCalled();
    expect(options).toMatchObject({ backend: 'python-api', voiceMode: 'auto' });
    expect(options).not.toHaveProperty('registeredVoiceId');
  });
});
