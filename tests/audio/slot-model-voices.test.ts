/**
 * Voices are offered and resolved against the model the tts slot speaks
 * with: OpenAI's Marin and Cedar need gpt-4o-mini-tts, so a slot on tts-1
 * neither offers them nor narrates with them.
 */
import { describe, expect, it } from 'vitest';

import { voiceServesModel } from '@/lib/audio/constants';
import { slotTTSProvidersConfig, ttsSelection } from '@/lib/audio/tts-selection';
import {
  getSelectableProvidersWithVoices,
  resolveAgentVoice,
  resolveNarratorVoiceBinding,
  resolveNarratorVoiceForGeneration,
} from '@/lib/audio/voice-resolver';
import { modelCapabilities, type EffectiveTarget } from '@/lib/model-settings/capabilities';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

import { modelSettingsViewFor } from '../helpers/model-settings-view';

const target = (modelId?: string): EffectiveTarget => ({
  providerId: 'openai-tts',
  providerSource: 'workspace',
  presetId: 'openai-tts',
  registryId: 'openai-tts',
  ...(modelId ? { modelId } : {}),
});

const ids = (voices: Array<{ id: string }>) => voices.map((voice) => voice.id);

describe('voiceServesModel', () => {
  it('knows which models speak which voices', () => {
    expect(voiceServesModel('openai-tts', 'marin', 'tts-1')).toBe(false);
    expect(voiceServesModel('openai-tts', 'marin', 'gpt-4o-mini-tts')).toBe(true);
    // No model: the provider's default (gpt-4o-mini-tts).
    expect(voiceServesModel('openai-tts', 'marin')).toBe(true);
    expect(voiceServesModel('openai-tts', 'alloy', 'tts-1')).toBe(true);
    // Voices without a model list, clones and unknown providers: any model.
    expect(voiceServesModel('qwen-tts', 'a-clone-id', 'qwen3-tts-flash')).toBe(true);
    expect(voiceServesModel('custom-tts-x', 'v', 'm')).toBe(true);
  });
});

describe('the voices offered for selection', () => {
  it("offers only the voices the slot's model can speak, under that model", () => {
    const [openai] = getSelectableProvidersWithVoices(slotTTSProvidersConfig(target('tts-1')));
    expect(openai.providerId).toBe('openai-tts');
    expect(ids(openai.voices)).toContain('alloy');
    expect(ids(openai.voices)).not.toContain('marin');
    expect(ids(openai.voices)).not.toContain('cedar');
    expect(openai.modelGroups.map((group) => group.modelId)).toEqual(['tts-1']);
    expect(ids(openai.modelGroups[0].voices)).not.toContain('marin');
  });

  it("offers them on the provider's default model when the slot names none", () => {
    const [openai] = getSelectableProvidersWithVoices(slotTTSProvidersConfig(target()));
    expect(ids(openai.voices)).toContain('marin');
    expect(openai.modelGroups.map((group) => group.modelId)).toEqual(['gpt-4o-mini-tts']);
  });
});

describe('a persisted voice the model cannot speak', () => {
  it('falls back to a compatible voice for narration and preview', () => {
    const onTts1 = modelCapabilities(
      modelSettingsViewFor({ tts: { registryId: 'openai-tts', modelId: 'tts-1' } }),
    );
    const selection = ttsSelection(onTts1, { voice: 'marin', providerId: 'openai-tts', speed: 1 });
    expect(selection?.voice).toBe('alloy');
    expect(voiceServesModel('openai-tts', selection!.voice, 'tts-1')).toBe(true);

    const onMini = modelCapabilities(
      modelSettingsViewFor({ tts: { registryId: 'openai-tts', modelId: 'gpt-4o-mini-tts' } }),
    );
    expect(
      ttsSelection(onMini, { voice: 'marin', providerId: 'openai-tts', speed: 1 })?.voice,
    ).toBe('marin');
  });

  it('does not bind the narrator or an agent to it', () => {
    const config = slotTTSProvidersConfig(target('tts-1'));
    expect(
      resolveNarratorVoiceBinding(
        { providerId: 'openai-tts', voiceId: 'marin' },
        { providerId: 'openai-tts', voiceId: 'alloy' },
        config,
      ).voiceId,
    ).toBe('alloy');
    expect(
      resolveNarratorVoiceForGeneration('openai-tts', 'marin', config['openai-tts']),
    ).toBeUndefined();

    const providers = getSelectableProvidersWithVoices(config);
    const agent = { id: 'a1', role: 'student', name: 'A' } as AgentConfig;
    const resolved = resolveAgentVoice(agent, 0, providers, {
      a1: { providerId: 'openai-tts', voiceId: 'cedar' },
    });
    expect(resolved?.voiceId).not.toBe('cedar');
    expect(voiceServesModel('openai-tts', resolved!.voiceId, 'tts-1')).toBe(true);
  });
});

describe('Gemini TTS voices on the tts slot', () => {
  const gemini = (modelId?: string): EffectiveTarget => ({
    providerId: 'gv',
    providerSource: 'workspace',
    presetId: 'google-tts',
    registryId: 'google-tts',
    ...(modelId ? { modelId } : {}),
  });

  it('offers the prebuilt Gemini voices under the slot model and narrates with Kore by default', () => {
    const [google] = getSelectableProvidersWithVoices(
      slotTTSProvidersConfig(gemini('gemini-2.5-flash-preview-tts')),
    );
    expect(google.providerId).toBe('google-tts');
    expect(ids(google.voices)).toEqual(expect.arrayContaining(['Kore', 'Puck', 'Zephyr']));
    expect(google.modelGroups.map((group) => group.modelId)).toEqual([
      'gemini-2.5-flash-preview-tts',
    ]);

    const capabilities = modelCapabilities(
      modelSettingsViewFor({
        tts: { registryId: 'google-tts', providerId: 'gv', presetId: 'google-tts' },
      }),
    );
    expect(ttsSelection(capabilities, { voice: '', providerId: '', speed: 1 })).toMatchObject({
      providerId: 'google-tts',
      voice: 'Kore',
    });
    expect(
      ttsSelection(capabilities, { voice: 'Puck', providerId: 'google-tts', speed: 1 }),
    ).toMatchObject({ voice: 'Puck' });
  });
});
