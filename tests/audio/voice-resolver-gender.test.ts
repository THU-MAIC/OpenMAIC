/**
 * When a generated agent's voice is missing or invalid, the fallback picks by
 * index inside that agent's gender. A catalogue with no male/female data, or
 * an agent whose gender is unknown, keeps the full-list index pick.
 * The pick is a simple index: it does not skip voices other agents already hold.
 */
import { describe, expect, it } from 'vitest';

import { getEnabledProvidersWithVoices, resolveAgentVoice } from '@/lib/audio/voice-resolver';
import type { ProviderWithVoices } from '@/lib/audio/voice-resolver';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

function agent(partial: Partial<AgentConfig>): AgentConfig {
  return partial as AgentConfig;
}

function withIdentity(identity: string, voiceConfig?: AgentConfig['voiceConfig']): AgentConfig {
  return agent({
    voiceConfig,
    voiceDesign: { identity, texture: 'warm', delivery: 'calm' },
  });
}

function withGender(
  gender: 'male' | 'female',
  identity: string,
  voiceConfig?: AgentConfig['voiceConfig'],
): AgentConfig {
  return agent({
    voiceConfig,
    voiceDesign: { identity, gender, texture: 'warm', delivery: 'calm' },
  });
}

/** Index 0 is male, so a gender-blind pick cannot satisfy a female agent. */
const gendered: ProviderWithVoices = {
  providerId: 'openai-tts',
  providerName: 'OpenAI TTS',
  voices: [
    { id: 'lead-male', name: 'Lead Male', gender: 'male' },
    { id: 'lead-female', name: 'Lead Female', gender: 'female' },
    { id: 'second-female', name: 'Second Female', gender: 'female' },
    { id: 'narrator', name: 'Narrator', gender: 'neutral' },
  ],
  modelGroups: [],
};

/** A two-voice catalogue with no gender field. Not the gendered list with that field removed. */
const ungendered: ProviderWithVoices = {
  providerId: 'custom-tts-lab',
  providerName: 'Lab',
  voices: [
    { id: 'v0', name: 'Zero' },
    { id: 'v1', name: 'One' },
  ],
  modelGroups: [],
};

describe('resolveAgentVoice gender fallback', () => {
  it('picks a female voice when the choice is missing and index 0 is male', () => {
    expect(resolveAgentVoice(withIdentity('middle-aged female teacher'), 0, [gendered])).toEqual({
      providerId: 'openai-tts',
      voiceId: 'lead-female',
    });
  });

  it('picks a female voice when the stored choice is not in the catalogue', () => {
    expect(
      resolveAgentVoice(
        withIdentity('middle-aged female teacher', {
          providerId: 'openai-tts',
          voiceId: 'not-in-list',
        }),
        0,
        [gendered],
      ),
    ).toEqual({ providerId: 'openai-tts', voiceId: 'lead-female' });
  });

  it('keeps a valid voice even when its gender differs from the agent', () => {
    expect(
      resolveAgentVoice(
        withIdentity('middle-aged female teacher', {
          providerId: 'openai-tts',
          voiceId: 'lead-male',
        }),
        0,
        [gendered],
      ),
    ).toMatchObject({ providerId: 'openai-tts', voiceId: 'lead-male' });
  });

  it('uses a simple index inside the same-gender voices, including a collision', () => {
    // Female voices are [lead-female, second-female]. Index 1 is the second.
    // Index 2 wraps to the first again. A uniqueness pass would avoid that.
    expect(resolveAgentVoice(withIdentity('young female student'), 1, [gendered])?.voiceId).toBe(
      'second-female',
    );
    expect(resolveAgentVoice(withIdentity('young female student'), 2, [gendered])?.voiceId).toBe(
      'lead-female',
    );
    expect(resolveAgentVoice(withIdentity('young female student'), 0, [gendered])?.voiceId).toBe(
      'lead-female',
    );
  });

  it('does not treat a neutral voice as a female match', () => {
    const neutralFirst: ProviderWithVoices = {
      ...gendered,
      voices: [
        { id: 'narrator', name: 'Narrator', gender: 'neutral' },
        { id: 'lead-female', name: 'Lead Female', gender: 'female' },
      ],
    };
    expect(
      resolveAgentVoice(withIdentity('middle-aged female teacher'), 0, [neutralFirst])?.voiceId,
    ).toBe('lead-female');
  });

  it('falls back by full-list index when no voice has the agent gender', () => {
    const malesOnly: ProviderWithVoices = {
      ...gendered,
      voices: [
        { id: 'only-male', name: 'Only', gender: 'male' },
        { id: 'also-male', name: 'Also', gender: 'male' },
      ],
    };
    expect(resolveAgentVoice(withIdentity('middle-aged female teacher'), 1, [malesOnly])).toEqual({
      providerId: 'openai-tts',
      voiceId: 'also-male',
    });
  });

  it('keeps the index pick when the catalogue has no gender data', () => {
    const female = withIdentity('middle-aged female teacher');
    expect(resolveAgentVoice(female, 0, [ungendered])).toEqual({
      providerId: 'custom-tts-lab',
      voiceId: 'v0',
    });
    expect(resolveAgentVoice(female, 1, [ungendered])?.voiceId).toBe('v1');
    expect(resolveAgentVoice(withGender('female', '年轻女性学生'), 1, [ungendered])?.voiceId).toBe(
      'v1',
    );
  });

  it('keeps the index pick when the agent gender is unknown', () => {
    const localized = withIdentity('professora de meia-idade');
    // Index 0 of the full list is male. Index 1 is female. Treating a
    // wordless identity as male would still return lead-male at index 1,
    // because the male subset has a single voice.
    expect(resolveAgentVoice(localized, 0, [gendered])?.voiceId).toBe('lead-male');
    expect(resolveAgentVoice(localized, 1, [gendered])?.voiceId).toBe('lead-female');
  });

  it('prefers voiceDesign.gender over a contradictory English identity', () => {
    expect(
      resolveAgentVoice(withGender('female', 'young male student'), 0, [gendered])?.voiceId,
    ).toBe('lead-female');
  });

  it('uses voiceDesign.gender when the identity is not English', () => {
    expect(resolveAgentVoice(withGender('female', '年轻女性学生'), 1, [gendered])?.voiceId).toBe(
      'second-female',
    );
    expect(resolveAgentVoice(withGender('male', '年轻女性学生'), 0, [gendered])?.voiceId).toBe(
      'lead-male',
    );
  });

  it('uses MiniMax catalog gender from the enabled provider list, not the index', () => {
    const providers = getEnabledProvidersWithVoices({
      'minimax-tts': { apiKey: 'k', enabled: true },
    });
    expect(providers[0]?.voices[0]).toMatchObject({ id: 'female-yujie', gender: 'female' });
    // Catalog order starts with 御姐音色 (female). A male agent must not land there.
    expect(resolveAgentVoice(withIdentity('young male student'), 0, providers)?.voiceId).toBe(
      'male-qn-jingying',
    );
    // The female subset is [御姐音色, 少女音色]. Index 1 is the second.
    expect(resolveAgentVoice(withIdentity('young female student'), 1, providers)?.voiceId).toBe(
      'female-shaonv',
    );
  });

  it('skips a Qwen clone and a leading male catalog voice for a female agent', () => {
    const qwen: ProviderWithVoices = {
      providerId: 'qwen-tts',
      providerName: 'Qwen TTS',
      voices: [
        { id: 'clone-not-in-catalog', name: 'Clone', gender: 'female' },
        { id: 'Ethan', name: 'Ethan', gender: 'male' },
        { id: 'Cherry', name: 'Cherry', gender: 'female' },
      ],
      modelGroups: [],
    };
    expect(resolveAgentVoice(withIdentity('young female student'), 0, [qwen])).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'Cherry',
    });
  });

  it('treats a neutral-only catalogue like one with no gender data', () => {
    const female = withIdentity('middle-aged female teacher');
    const unknown = withIdentity('professora de meia-idade');
    for (const providerId of ['google-tts', 'voxcpm-tts'] as const) {
      const providers = getEnabledProvidersWithVoices({
        [providerId]: { isServerConfigured: true, enabled: true },
      });
      const voices = providers[0]?.voices ?? [];
      expect(voices.length).toBeGreaterThan(0);
      expect(voices.every((voice) => voice.gender === 'neutral')).toBe(true);
      const index = 1 % voices.length;
      expect(resolveAgentVoice(female, 1, providers)?.voiceId).toBe(voices[index].id);
      expect(resolveAgentVoice(unknown, 1, providers)?.voiceId).toBe(voices[index].id);
    }
  });
});
