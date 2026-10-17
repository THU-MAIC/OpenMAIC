/**
 * When a generated agent's voice is missing or invalid, the fallback must
 * prefer a catalog voice of that agent's gender. A catalogue with no gender
 * data keeps the index pick.
 */
import { describe, expect, it } from 'vitest';

import {
  getEnabledProvidersWithVoices,
  getSelectableProvidersWithVoices,
  playbackVoiceAfterUnavailableFallback,
  resolveAgentVoice,
  voicePillPlaybackRoster,
  type ProviderWithVoices,
} from '@/lib/audio/voice-resolver';
import {
  clearUnavailableVoiceBindingsForTests,
  markVoiceBindingUnavailable,
} from '@/lib/audio/unavailable-voice-bindings';
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
    const resolved = resolveAgentVoice(
      withIdentity('middle-aged female teacher', {
        providerId: 'openai-tts',
        voiceId: 'not-in-list',
      }),
      0,
      [gendered],
    );
    expect(resolved).toEqual({ providerId: 'openai-tts', voiceId: 'lead-female' });
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
    ).toEqual({ providerId: 'openai-tts', modelId: undefined, voiceId: 'lead-male' });
  });

  it('uses the agent index inside the same-gender voices', () => {
    expect(resolveAgentVoice(withIdentity('young female student'), 1, [gendered])?.voiceId).toBe(
      'second-female',
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

  it('falls back by index when no voice has the agent gender', () => {
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
  });

  it('keeps the index pick when the identity does not say male or female', () => {
    const localized = withIdentity('professora de meia-idade');
    // Index 0 of the full list is male. Index 1 is female. A bug that treats
    // every identity without the word "female" as male still returns lead-male
    // at index 1, because the male subset has a single voice.
    expect(resolveAgentVoice(localized, 0, [gendered])?.voiceId).toBe('lead-male');
    expect(resolveAgentVoice(localized, 1, [gendered])?.voiceId).toBe('lead-female');
  });

  it('uses MiniMax catalog gender from the enabled provider list, not the index', () => {
    const providers = getEnabledProvidersWithVoices({
      'minimax-tts': { apiKey: 'k', enabled: true },
    });
    // Catalog order starts with 御姐音色 (female). A male agent must not land there.
    expect(resolveAgentVoice(withIdentity('young male student'), 0, providers)?.voiceId).toBe(
      'male-qn-jingying',
    );
    // Index 1 is 精英青年 (male). A female agent takes the second female voice.
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
    for (const providerId of ['google-tts', 'voxcpm-tts'] as const) {
      const providers = getEnabledProvidersWithVoices({
        [providerId]: { isServerConfigured: true, enabled: true },
      });
      expect(providers[0]?.voices.length).toBeGreaterThan(0);
      expect(providers[0].voices.every((voice) => voice.gender === 'neutral')).toBe(true);
      if (providerId === 'voxcpm-tts') {
        expect(providers[0].voices.map((voice) => voice.id)).toEqual(['voxcpm:auto']);
      }
      const stripped: ProviderWithVoices[] = [
        {
          ...providers[0],
          voices: providers[0].voices.map((voice) => ({
            id: voice.id,
            name: voice.name,
            ...(voice.language ? { language: voice.language } : {}),
          })),
        },
      ];
      const roster = [
        female,
        withIdentity('young male student'),
        female,
        withIdentity('young female student'),
      ];
      expect(resolveAgentVoice(female, 0, providers)).toEqual(
        resolveAgentVoice(female, 0, stripped),
      );
      expect(resolveAgentVoice(female, 1, providers)?.voiceId).toBe(
        resolveAgentVoice(female, 1, stripped)?.voiceId,
      );
      // A roster must not pull a neutral-only catalogue off the index pick.
      expect(resolveAgentVoice(roster[3], 3, providers, undefined, { roster })?.voiceId).toBe(
        resolveAgentVoice(female, 3, stripped)?.voiceId,
      );
    }
  });

  it('keeps the original index fallback for a neutral-only catalogue with a roster', () => {
    // Google lists only neutral voices (Zephyr, Puck, ...). An unbound teacher
    // reserves the catalogue default (Kore). On base the student at index 1
    // still gets Puck; full-pool coordination would hand them Zephyr.
    const loaded = getEnabledProvidersWithVoices({
      'google-tts': { isServerConfigured: true, enabled: true },
    });
    const googleIsNeutralOnly =
      loaded[0]?.providerId === 'google-tts' &&
      loaded.length === 1 &&
      loaded[0].voices.length > 1 &&
      loaded[0].voices.every((voice) => voice.gender !== 'male' && voice.gender !== 'female');
    const providers: ProviderWithVoices[] = googleIsNeutralOnly
      ? loaded
      : [
          {
            providerId: 'google-tts',
            providerName: 'Google Gemini TTS',
            voices: [
              { id: 'Zephyr', name: 'Zephyr', gender: 'neutral' },
              { id: 'Puck', name: 'Puck', gender: 'neutral' },
              { id: 'Kore', name: 'Kore', gender: 'neutral' },
            ],
            modelGroups: [],
          },
        ];
    expect(providers[0].voices[0]?.id).toBe('Zephyr');
    expect(providers[0].voices[1]?.id).toBe('Puck');
    expect(
      providers[0].voices.every((voice) => voice.gender !== 'male' && voice.gender !== 'female'),
    ).toBe(true);

    const teacher = agent({
      role: 'teacher',
      voiceDesign: { identity: 'middle-aged female teacher', texture: 'warm', delivery: 'calm' },
    });
    const student = agent({
      role: 'student',
      voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
    });
    const roster = [teacher, student];
    const withRoster = resolveAgentVoice(student, 1, providers, undefined, { roster });
    const withoutRoster = resolveAgentVoice(student, 1, providers);
    expect(withRoster).toEqual(withoutRoster);
    expect(withRoster?.voiceId).toBe('Puck');
  });

  it('gives distinct OpenAI voices to same-gender agents whose indexes collide modulo the subset', () => {
    const providers = getEnabledProvidersWithVoices({
      'openai-tts': { apiKey: 'k', enabled: true },
    });
    expect(
      providers[0].voices.filter((voice) => voice.gender === 'female').map((voice) => voice.id),
    ).toEqual(['nova', 'shimmer']);
    // Indexes 1 and 3 are congruent modulo the two female voices, so a global
    // index lands both on shimmer. They are the first and second female agents.
    const roster = [
      withIdentity('middle-aged male teacher'),
      withIdentity('young female student'),
      withIdentity('young male student'),
      withIdentity('middle-aged female teacher'),
    ];
    const voices = roster.map(
      (agent, index) => resolveAgentVoice(agent, index, providers, undefined, { roster })?.voiceId,
    );
    expect(voices[1]).toBe('nova');
    expect(voices[3]).toBe('shimmer');
    expect(new Set([voices[0], voices[2]]).size).toBe(2);
  });

  it('reserves a configured voice that appears later in the roster', () => {
    const providers = getEnabledProvidersWithVoices({
      'openai-tts': { apiKey: 'k', enabled: true },
    });
    expect(
      providers[0].voices.filter((voice) => voice.gender === 'female').map((voice) => voice.id),
    ).toEqual(['nova', 'shimmer']);
    const student = agent({
      role: 'student',
      voiceDesign: { identity: 'young female student', texture: 'warm', delivery: 'calm' },
    });
    const teacher = agent({
      role: 'teacher',
      voiceDesign: { identity: 'middle-aged female teacher', texture: 'warm', delivery: 'calm' },
      voiceConfig: { providerId: 'openai-tts', voiceId: 'nova' },
    });
    const roster = [student, teacher];
    // The teacher speaks nova. shimmer is free, so the earlier unbound student must not take nova.
    expect(resolveAgentVoice(student, 0, providers, undefined, { roster })?.voiceId).toBe(
      'shimmer',
    );
    expect(resolveAgentVoice(teacher, 1, providers, undefined, { roster })?.voiceId).toBe('nova');
  });

  it('does not assign a later configured voice when every same-gender voice is already taken', () => {
    const providers = getEnabledProvidersWithVoices({
      'openai-tts': { apiKey: 'k', enabled: true },
    });
    const teacher = agent({
      role: 'teacher',
      voiceDesign: { identity: 'middle-aged female teacher', texture: 'warm', delivery: 'calm' },
      voiceConfig: { providerId: 'openai-tts', voiceId: 'nova' },
    });
    const unbound = agent({
      role: 'student',
      voiceDesign: { identity: 'young female student', texture: 'bright', delivery: 'quick' },
    });
    const later = agent({
      role: 'student',
      voiceDesign: { identity: 'young female student', texture: 'light', delivery: 'lively' },
      voiceConfig: { providerId: 'openai-tts', voiceId: 'shimmer' },
    });
    const roster = [teacher, unbound, later];
    const voices = roster.map(
      (entry, index) => resolveAgentVoice(entry, index, providers, undefined, { roster })?.voiceId,
    );
    expect(voices[0]).toBe('nova');
    expect(voices[2]).toBe('shimmer');
    // Both female voices are configured, so the unbound agent wraps inside that subset.
    expect(voices[1]).toBe('nova');
  });

  it('reserves the provider default an unbound teacher actually speaks', () => {
    const providers = getEnabledProvidersWithVoices({
      'minimax-tts': { apiKey: 'k', enabled: true },
    });
    const females = providers[0].voices
      .filter((voice) => voice.gender === 'female')
      .map((voice) => voice.id);
    // MiniMax's catalogue default is the first female voice. With no global
    // lecture pick, discussion plays that default for a teacher with no
    // voiceConfig; the student must take the next one.
    expect(females[0]).toBe('female-yujie');
    expect(females).toContain('female-shaonv');
    const student = agent({
      role: 'student',
      voiceDesign: { identity: 'young female student', texture: 'bright', delivery: 'quick' },
    });
    const teacher = agent({
      role: 'teacher',
      voiceDesign: { identity: 'middle-aged female teacher', texture: 'warm', delivery: 'calm' },
    });
    expect(teacher.voiceConfig).toBeUndefined();
    const roster = [student, teacher];
    expect(resolveAgentVoice(student, 0, providers, undefined, { roster })?.voiceId).toBe(
      'female-shaonv',
    );
    const teacherFirst = [teacher, student];
    expect(
      resolveAgentVoice(student, 1, providers, undefined, { roster: teacherFirst })?.voiceId,
    ).toBe('female-shaonv');
  });

  it('reserves the global lecture voice an unbound teacher speaks, not the catalogue default', () => {
    const providers = getEnabledProvidersWithVoices({
      'minimax-tts': { apiKey: 'k', enabled: true },
    });
    const females = providers[0].voices
      .filter((voice) => voice.gender === 'female')
      .map((voice) => voice.id);
    expect(females[0]).toBe('female-yujie');
    expect(females).toContain('female-shaonv');
    const student = agent({
      role: 'student',
      voiceDesign: { identity: 'young female student', texture: 'bright', delivery: 'quick' },
    });
    const teacher = agent({
      role: 'teacher',
      voiceDesign: { identity: 'middle-aged female teacher', texture: 'warm', delivery: 'calm' },
    });
    expect(teacher.voiceConfig).toBeUndefined();
    const globalVoice = { providerId: 'minimax-tts' as const, voiceId: 'female-shaonv' };
    const roster = [student, teacher];
    // Discussion speaks female-shaonv for this teacher. Reserving female-yujie
    // lets the student take female-shaonv while other female voices are free.
    expect(
      resolveAgentVoice(student, 0, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('female-yujie');
    const teacherFirst = [teacher, student];
    expect(
      resolveAgentVoice(student, 1, providers, undefined, { roster: teacherFirst, globalVoice })
        ?.voiceId,
    ).toBe('female-yujie');
  });

  it('does not spend a fallback slot on an unbound teacher without voiceConfig', () => {
    const providers = getEnabledProvidersWithVoices({
      'openai-tts': { apiKey: 'k', enabled: true },
    });
    expect(
      providers[0].voices.filter((voice) => voice.gender === 'female').map((voice) => voice.id),
    ).toEqual(['nova', 'shimmer']);
    const student = (texture: string) =>
      agent({
        role: 'student',
        voiceDesign: { identity: 'young female student', texture, delivery: 'calm' },
      });
    const teacher = agent({
      role: 'teacher',
      voiceDesign: { identity: 'middle-aged female teacher', texture: 'warm', delivery: 'calm' },
    });
    expect(teacher.voiceConfig).toBeUndefined();
    // alloy, the OpenAI default, is neutral, so it sits outside this pool.
    // Counting the teacher as a fallback would wrap the second student onto nova.
    const roster = [student('bright'), teacher, student('light')];
    const voices = roster.map(
      (entry, index) => resolveAgentVoice(entry, index, providers, undefined, { roster })?.voiceId,
    );
    expect(voices[0]).toBe('nova');
    expect(voices[2]).toBe('shimmer');
  });

  it('reserves the lecture voice when a student clone is unavailable', () => {
    // Playback falls every unavailable binding back onto the lecture voice, including
    // a student. Reserving only the stored clone leaves Cherry free, so an unbound
    // female classmate takes Cherry while Serena is still free.
    const providers = getEnabledProvidersWithVoices({
      'qwen-tts': { apiKey: 'k', enabled: true },
    });
    const clone = { providerId: 'qwen-tts' as const, voiceId: 'qwen-clone-student' };
    const globalVoice = { providerId: 'qwen-tts' as const, voiceId: 'Cherry' };
    const teacher = agent({
      id: 'teacher',
      role: 'teacher',
      voiceConfig: { providerId: 'qwen-tts', voiceId: 'Ethan' },
      voiceDesign: {
        identity: 'middle-aged male teacher',
        gender: 'male',
        texture: 'warm',
        delivery: 'calm',
      },
    });
    const boundStudent = agent({
      id: 'bound-student',
      role: 'student',
      voiceConfig: { ...clone },
      voiceDesign: {
        identity: 'young female student',
        gender: 'female',
        texture: 'bright',
        delivery: 'quick',
      },
    });
    const classmate = agent({
      id: 'classmate',
      role: 'student',
      voiceDesign: {
        identity: 'young female student',
        gender: 'female',
        texture: 'light',
        delivery: 'lively',
      },
    });
    const roster = [teacher, boundStudent, classmate];
    const lectureEnabled = providers.some(
      (provider) => provider.providerId === globalVoice.providerId,
    );
    clearUnavailableVoiceBindingsForTests();
    markVoiceBindingUnavailable(clone);
    try {
      const played = playbackVoiceAfterUnavailableFallback(
        clone,
        globalVoice,
        () => {
          const first = providers[0]?.voices[0];
          return first ? { providerId: providers[0].providerId, voiceId: first.id } : null;
        },
        lectureEnabled,
      );
      expect(played?.voiceId).toBe('Cherry');
      expect(
        resolveAgentVoice(teacher, 0, providers, undefined, { roster, globalVoice })?.voiceId,
      ).toBe('Ethan');
      expect(
        resolveAgentVoice(boundStudent, 1, providers, undefined, { roster, globalVoice })?.voiceId,
      ).toBe(clone.voiceId);
      expect(
        resolveAgentVoice(classmate, 2, providers, undefined, { roster, globalVoice })?.voiceId,
      ).toBe('Serena');
      expect(boundStudent.voiceConfig).toEqual(clone);
      expect(classmate.voiceConfig).toBeUndefined();
    } finally {
      clearUnavailableVoiceBindingsForTests();
    }
  });

  it('reserves the index fallback an ungendered predecessor already took', () => {
    // Codex P2: teacher on female-yujie, ungendered student at index 1 takes
    // male-qn-jingying (full-pool index pick). A later male must not also get
    // male-qn-jingying while Chinese (Mandarin)_Gentleman is free.
    const providers = getEnabledProvidersWithVoices({
      'minimax-tts': { apiKey: 'k', enabled: true },
    });
    const teacher = agent({
      role: 'teacher',
      voiceDesign: { identity: 'middle-aged female teacher', texture: 'warm', delivery: 'calm' },
      voiceConfig: { providerId: 'minimax-tts', voiceId: 'female-yujie' },
    });
    const ungendered = agent({
      role: 'student',
      voiceDesign: { identity: '年轻学生', texture: '清亮', delivery: '轻快' },
    });
    const male = agent({
      role: 'student',
      voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
    });
    const roster = [teacher, ungendered, male];
    expect(resolveAgentVoice(ungendered, 1, providers, undefined, { roster })?.voiceId).toBe(
      'male-qn-jingying',
    );
    expect(resolveAgentVoice(male, 2, providers, undefined, { roster })?.voiceId).toBe(
      'Chinese (Mandarin)_Gentleman',
    );
  });

  it('does not reserve a fallback voice id configured on another provider', () => {
    // Codex P2: custom-provider 'nova' is not OpenAI 'nova'. A bare voiceId
    // reservation pushes the unbound student onto shimmer while nova is free.
    const providers = getEnabledProvidersWithVoices({
      'openai-tts': { apiKey: 'k', enabled: true },
      'custom-tts-lab': {
        apiKey: 'k',
        enabled: true,
        customVoices: [{ id: 'nova', name: 'Custom Nova' }],
      },
    });
    expect(providers[0]?.providerId).toBe('openai-tts');
    const bound = agent({
      role: 'student',
      voiceDesign: {
        identity: 'young female student',
        gender: 'female',
        texture: 'warm',
        delivery: 'calm',
      },
      voiceConfig: { providerId: 'custom-tts-lab', voiceId: 'nova' },
    });
    const unbound = agent({
      role: 'student',
      voiceDesign: {
        identity: 'young female student',
        gender: 'female',
        texture: 'bright',
        delivery: 'quick',
      },
    });
    const roster = [unbound, bound];
    expect(resolveAgentVoice(bound, 1, providers, undefined, { roster })).toEqual({
      providerId: 'custom-tts-lab',
      voiceId: 'nova',
    });
    expect(resolveAgentVoice(unbound, 0, providers, undefined, { roster })).toEqual({
      providerId: 'openai-tts',
      voiceId: 'nova',
    });
  });

  it('reserves the fallback lecture voice when another provider uses the same id', () => {
    // Playback of an unavailable custom 'nova' speaks OpenAI nova. That catalogue
    // id stays reserved even though the stored binding is a different provider.
    const providers = getEnabledProvidersWithVoices({
      'openai-tts': { apiKey: 'k', enabled: true },
      'custom-tts-lab': {
        apiKey: 'k',
        enabled: true,
        customVoices: [{ id: 'nova', name: 'Custom Nova' }],
      },
    });
    const stored = { providerId: 'custom-tts-lab' as const, voiceId: 'nova' };
    const globalVoice = { providerId: 'openai-tts' as const, voiceId: 'nova' };
    const bound = agent({
      role: 'student',
      voiceConfig: { ...stored },
      voiceDesign: {
        identity: 'young female student',
        gender: 'female',
        texture: 'warm',
        delivery: 'calm',
      },
    });
    const unbound = agent({
      role: 'student',
      voiceDesign: {
        identity: 'young female student',
        gender: 'female',
        texture: 'bright',
        delivery: 'quick',
      },
    });
    const roster = [bound, unbound];
    clearUnavailableVoiceBindingsForTests();
    markVoiceBindingUnavailable(stored);
    try {
      expect(resolveAgentVoice(bound, 0, providers, undefined, { roster, globalVoice })).toEqual({
        providerId: 'custom-tts-lab',
        voiceId: 'nova',
      });
      expect(resolveAgentVoice(unbound, 1, providers, undefined, { roster, globalVoice })).toEqual({
        providerId: 'openai-tts',
        voiceId: 'shimmer',
      });
    } finally {
      clearUnavailableVoiceBindingsForTests();
    }
  });

  it('allocates a large alternating roster without exponential predecessor work', () => {
    // Codex P2: each other-gender predecessor re-entered distinctGenderVoiceId,
    // so an alternating unbound roster blew up. Small rosters keep the per-gender
    // ordinal (males echo/onyx, females nova/shimmer).
    const providers = getEnabledProvidersWithVoices({
      'openai-tts': { apiKey: 'k', enabled: true },
    });
    expect(
      providers[0].voices.filter((voice) => voice.gender === 'male').map((voice) => voice.id),
    ).toEqual(['echo', 'onyx']);
    expect(
      providers[0].voices.filter((voice) => voice.gender === 'female').map((voice) => voice.id),
    ).toEqual(['nova', 'shimmer']);
    const genderAt = (index: number): 'male' | 'female' => (index % 2 === 0 ? 'male' : 'female');
    const ordinalVoice = (index: number): string => {
      const pool = index % 2 === 0 ? ['echo', 'onyx'] : ['nova', 'shimmer'];
      return pool[Math.floor(index / 2) % pool.length];
    };
    const makeRoster = (count: number) =>
      Array.from({ length: count }, (_, index) => {
        const gender = genderAt(index);
        return agent({
          role: 'student',
          voiceDesign: {
            identity: gender === 'male' ? 'young male student' : 'young female student',
            gender,
            texture: 'warm',
            delivery: 'calm',
          },
        });
      });

    const small = makeRoster(6);
    expect(
      small.map(
        (entry, index) =>
          resolveAgentVoice(entry, index, providers, undefined, { roster: small })?.voiceId,
      ),
    ).toEqual(['echo', 'nova', 'onyx', 'shimmer', 'echo', 'nova']);

    const roster = makeRoster(48);
    const started = Date.now();
    const voices = roster.map(
      (entry, index) => resolveAgentVoice(entry, index, providers, undefined, { roster })?.voiceId,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(voices).toEqual(roster.map((_, index) => ordinalVoice(index)));
  }, 5000);

  it('does not give an ungendered agent a voice an earlier gendered fallback already took', () => {
    // MiniMax starts female-yujie, male-qn-jingying, female-shaonv. The female
    // student takes female-yujie, the first full-pool slot once the teacher's
    // later voiceConfig is set aside. Reserving that fallback sends the
    // ungendered agent to male-qn-jingying; without the reservation,
    // female-yujie would stay first-free. A raw index 2 is female-shaonv.
    const providers = getEnabledProvidersWithVoices({
      'minimax-tts': { apiKey: 'k', enabled: true },
    });
    const female = agent({
      role: 'student',
      voiceDesign: {
        identity: 'young female student',
        gender: 'female',
        texture: 'bright',
        delivery: 'quick',
      },
    });
    const teacher = agent({
      role: 'teacher',
      voiceConfig: { providerId: 'minimax-tts', voiceId: 'Chinese (Mandarin)_Gentleman' },
      voiceDesign: { identity: 'middle-aged male teacher', texture: 'warm', delivery: 'calm' },
    });
    const ungendered = agent({
      role: 'student',
      voiceDesign: { identity: '年轻学生', texture: '清亮', delivery: '轻快' },
    });
    const roster = [female, teacher, ungendered];
    expect(resolveAgentVoice(female, 0, providers, undefined, { roster })?.voiceId).toBe(
      'female-yujie',
    );
    expect(resolveAgentVoice(ungendered, 2, providers, undefined, { roster })?.voiceId).toBe(
      'male-qn-jingying',
    );
    // No roster: the same ungendered agent stays on the full-pool index.
    expect(resolveAgentVoice(ungendered, 2, providers)?.voiceId).toBe('female-shaonv');
  });

  it('reserves the voice an earlier ungendered agent actually picked', () => {
    // Teacher holds male-qn-jingying. The ungendered agent at index 1 would
    // collide with that id on a raw index, so it takes female-yujie. The later
    // female must reserve that pick, not the raw index, and take female-shaonv.
    const providers = getEnabledProvidersWithVoices({
      'minimax-tts': { apiKey: 'k', enabled: true },
    });
    const teacher = agent({
      role: 'teacher',
      voiceConfig: { providerId: 'minimax-tts', voiceId: 'male-qn-jingying' },
      voiceDesign: { identity: 'middle-aged male teacher', texture: 'warm', delivery: 'calm' },
    });
    const ungendered = agent({
      role: 'student',
      voiceDesign: { identity: '年轻学生', texture: '清亮', delivery: '轻快' },
    });
    const female = agent({
      role: 'student',
      voiceDesign: {
        identity: 'young female student',
        gender: 'female',
        texture: 'bright',
        delivery: 'quick',
      },
    });
    const roster = [teacher, ungendered, female];
    expect(resolveAgentVoice(ungendered, 1, providers, undefined, { roster })?.voiceId).toBe(
      'female-yujie',
    );
    expect(resolveAgentVoice(female, 2, providers, undefined, { roster })?.voiceId).toBe(
      'female-shaonv',
    );
  });

  it('reserves roster voices when the agent gender has no same-gender pool', () => {
    const malesOnly: ProviderWithVoices = {
      ...gendered,
      voices: [
        { id: 'm0', name: 'M0', gender: 'male' },
        { id: 'm1', name: 'M1', gender: 'male' },
        { id: 'm2', name: 'M2', gender: 'male' },
      ],
    };
    const bound = agent({
      role: 'student',
      voiceConfig: { providerId: 'openai-tts', voiceId: 'm1' },
      voiceDesign: {
        identity: 'young male student',
        gender: 'male',
        texture: 'warm',
        delivery: 'calm',
      },
    });
    const female = agent({
      role: 'student',
      voiceDesign: {
        identity: 'young female student',
        gender: 'female',
        texture: 'bright',
        delivery: 'quick',
      },
    });
    const roster = [bound, female];
    // Index 1 is m1, which the earlier agent already speaks.
    expect(resolveAgentVoice(female, 1, [malesOnly], undefined, { roster })?.voiceId).toBe('m0');
    expect(resolveAgentVoice(female, 1, [malesOnly])?.voiceId).toBe('m1');
  });

  it('wraps the full pool stably once every fallback voice is reserved', () => {
    // Full-pool coordination applies only when the catalogue lists a male or
    // female voice. These agents stay ungendered, so they still take that path.
    const two: ProviderWithVoices = {
      providerId: 'custom-tts-lab',
      providerName: 'Lab',
      voices: [
        { id: 'v0', name: 'Zero', gender: 'male' },
        { id: 'v1', name: 'One', gender: 'female' },
      ],
      modelGroups: [],
    };
    const teacher = agent({
      role: 'teacher',
      voiceConfig: { providerId: 'custom-tts-lab', voiceId: 'v0' },
    });
    const first = agent({
      role: 'student',
      voiceDesign: { identity: '学生甲', texture: '清', delivery: '稳' },
    });
    const second = agent({
      role: 'student',
      voiceDesign: { identity: '学生乙', texture: '亮', delivery: '快' },
    });
    const roster = [teacher, first, second];
    expect(resolveAgentVoice(first, 1, [two], undefined, { roster })?.voiceId).toBe('v1');
    // Index 2 modulo 2 is v0, the teacher's voice. The exhausted pool wraps to v1.
    expect(resolveAgentVoice(second, 2, [two], undefined, { roster })?.voiceId).toBe('v1');
  });

  it('reserves the teacher playback voice instead of a stale per-agent override', () => {
    const providers = getEnabledProvidersWithVoices({
      'openai-tts': { apiKey: 'k', enabled: true },
    });
    expect(
      providers[0].voices.filter((voice) => voice.gender === 'female').map((voice) => voice.id),
    ).toEqual(['nova', 'shimmer']);
    const student = agent({
      id: 'student-1',
      role: 'student',
      voiceDesign: {
        identity: 'young female student',
        gender: 'female',
        texture: 'bright',
        delivery: 'quick',
      },
    });
    const boundTeacher = agent({
      id: 'teacher-1',
      role: 'teacher',
      voiceConfig: { providerId: 'openai-tts', voiceId: 'nova' },
      voiceDesign: {
        identity: 'middle-aged female teacher',
        gender: 'female',
        texture: 'warm',
        delivery: 'calm',
      },
    });
    const overrides = {
      'teacher-1': { providerId: 'openai-tts' as const, voiceId: 'shimmer' },
    };
    const boundRoster = [boundTeacher, student];
    // Playback speaks voiceConfig nova and ignores the shimmer override.
    expect(
      resolveAgentVoice(student, 1, providers, overrides, {
        roster: boundRoster,
        globalVoice: { providerId: 'openai-tts', voiceId: 'alloy' },
      })?.voiceId,
    ).toBe('shimmer');

    const unboundTeacher = agent({
      id: 'teacher-1',
      role: 'teacher',
      voiceDesign: {
        identity: 'middle-aged female teacher',
        gender: 'female',
        texture: 'warm',
        delivery: 'calm',
      },
    });
    const lecture = { providerId: 'openai-tts' as const, voiceId: 'nova' };
    // No voiceConfig: playback speaks the lecture voice, not the override.
    expect(
      resolveAgentVoice(student, 1, providers, overrides, {
        roster: [unboundTeacher, student],
        globalVoice: lecture,
      })?.voiceId,
    ).toBe('shimmer');
  });
});

describe('voice pill playback roster', () => {
  function female(id: string, voiceConfig?: AgentConfig['voiceConfig']): AgentConfig {
    return agent({
      id,
      role: 'student',
      voiceDesign: { identity: 'young female student', texture: 'warm', delivery: 'calm' },
      voiceConfig,
    });
  }

  function openAI() {
    const providers = getEnabledProvidersWithVoices({
      'openai-tts': { apiKey: 'k', enabled: true },
    });
    expect(
      providers[0].voices.filter((voice) => voice.gender === 'female').map((voice) => voice.id),
    ).toEqual(['nova', 'shimmer']);
    return providers;
  }

  it('keeps a selected pill on the voice playback will speak when an earlier peer is unselected', () => {
    const providers = openAI();
    const teacher = agent({ id: 'default-1', role: 'teacher' });
    const first = female('custom-1');
    const second = female('custom-2');
    const catalogue = [teacher, first, second];
    // Teacher stays selected. Only the second unbound female custom agent is selected.
    const selectedAgentIds = ['default-1', 'custom-2'];
    const playback = selectedAgentIds
      .map((id) => catalogue.find((entry) => entry.id === id))
      .filter((entry): entry is AgentConfig => entry != null);
    const spokenIndex = playback.findIndex((entry) => entry.id === second.id);

    const pill = voicePillPlaybackRoster(catalogue, selectedAgentIds, second);
    const displayed = resolveAgentVoice(second, pill.index, providers, undefined, {
      roster: pill.roster,
    });
    const spoken = resolveAgentVoice(second, spokenIndex, providers, undefined, {
      roster: playback,
    });

    // An unselected earlier female must not move this pill off nova.
    expect(displayed?.voiceId).toBe('nova');
    expect(displayed).toEqual(spoken);
    expect(pill.roster.map((entry) => entry?.id)).toEqual(['default-1', 'custom-2']);
    expect(pill.index).toBe(spokenIndex);
  });

  it('does not reserve a voice configured on an unselected agent', () => {
    const providers = openAI();
    const first = female('custom-1', { providerId: 'openai-tts', voiceId: 'nova' });
    const second = female('custom-2');
    const catalogue = [first, second];
    const selectedAgentIds = ['custom-2'];

    const pill = voicePillPlaybackRoster(catalogue, selectedAgentIds, second);
    const displayed = resolveAgentVoice(second, pill.index, providers, undefined, {
      roster: pill.roster,
    });

    expect(displayed?.voiceId).toBe('nova');
    expect(pill.roster.map((entry) => entry.id)).toEqual(['custom-2']);
  });

  it('appends an unselected row so its pill is the voice selecting it would speak', () => {
    const providers = openAI();
    const teacher = agent({ id: 'default-1', role: 'teacher' });
    const first = female('custom-1');
    const second = female('custom-2');
    const catalogue = [teacher, first, second];
    const selectedAgentIds = ['default-1', 'custom-2'];
    const playback = selectedAgentIds
      .map((id) => catalogue.find((entry) => entry.id === id))
      .filter((entry): entry is AgentConfig => entry != null);
    const ifSelected = [...playback, first];

    const pill = voicePillPlaybackRoster(catalogue, selectedAgentIds, first);
    const displayed = resolveAgentVoice(first, pill.index, providers, undefined, {
      roster: pill.roster,
    });
    const spoken = resolveAgentVoice(first, ifSelected.length - 1, providers, undefined, {
      roster: ifSelected,
    });

    expect(displayed).toEqual(spoken);
    expect(pill.roster.map((entry) => entry.id)).toEqual(['default-1', 'custom-2', 'custom-1']);
    expect(pill.index).toBe(ifSelected.length - 1);
  });

  it('matches playback when an unselected agent is bound to nova', () => {
    // Breaks if the pill roster still counts unselected agents: the pill would
    // show shimmer while playback, given only the selected agent, speaks nova.
    const providers = openAI();
    const unselected = female('custom-1', { providerId: 'openai-tts', voiceId: 'nova' });
    const selected = female('custom-2');
    const catalogue = [unselected, selected];
    const selectedAgentIds = ['custom-2'];
    const playback = selectedAgentIds
      .map((id) => catalogue.find((entry) => entry.id === id))
      .filter((entry): entry is AgentConfig => entry != null);

    const pill = voicePillPlaybackRoster(catalogue, selectedAgentIds, selected);
    const displayed = resolveAgentVoice(selected, pill.index, providers, undefined, {
      roster: pill.roster,
    });
    const spoken = resolveAgentVoice(selected, 0, providers, undefined, { roster: playback });

    expect(displayed).toEqual(spoken);
    expect(spoken?.voiceId).toBe('nova');
    expect(pill.roster.map((entry) => entry.id)).toEqual(['custom-2']);
  });

  it('matches playback when the selected teacher reserves MiniMax female-yujie', () => {
    // Breaks if the pill roster drops the teacher: the pill would show
    // female-yujie while playback, which reserves the teacher's voice, speaks
    // female-shaonv.
    const providers = getEnabledProvidersWithVoices({
      'minimax-tts': { apiKey: 'k', enabled: true },
    });
    const teacher = agent({
      id: 'default-1',
      role: 'teacher',
      voiceConfig: { providerId: 'minimax-tts', voiceId: 'female-yujie' },
    });
    const student = female('custom-2');
    const catalogue = [teacher, student];
    const selectedAgentIds = ['default-1', 'custom-2'];
    const playback = selectedAgentIds
      .map((id) => catalogue.find((entry) => entry.id === id))
      .filter((entry): entry is AgentConfig => entry != null);
    const spokenIndex = playback.findIndex((entry) => entry.id === student.id);

    const pill = voicePillPlaybackRoster(catalogue, selectedAgentIds, student);
    const displayed = resolveAgentVoice(student, pill.index, providers, undefined, {
      roster: pill.roster,
    });
    const spoken = resolveAgentVoice(student, spokenIndex, providers, undefined, {
      roster: playback,
    });

    expect(displayed).toEqual(spoken);
    expect(spoken?.voiceId).toBe('female-shaonv');
    expect(pill.roster.map((entry) => entry.id)).toEqual(['default-1', 'custom-2']);
  });

  it('matches playback when a stale teacher override is not the lecture voice', () => {
    // AgentVoicePill resolves the selected roster with agentVoiceOverrides.
    // The teacher pill edits the global lecture voice and does not read overrides.
    // Playback speaks the teacher's voiceConfig, so the student pill must reserve
    // nova and show shimmer while shimmer is the stale override.
    const providers = openAI();
    const teacher = agent({
      id: 'teacher-1',
      role: 'teacher',
      voiceConfig: { providerId: 'openai-tts', voiceId: 'nova' },
      voiceDesign: {
        identity: 'middle-aged female teacher',
        gender: 'female',
        texture: 'warm',
        delivery: 'calm',
      },
    });
    const student = female('student-1');
    const catalogue = [teacher, student];
    const selectedAgentIds = ['teacher-1', 'student-1'];
    const overrides = {
      'teacher-1': { providerId: 'openai-tts' as const, voiceId: 'shimmer' },
    };
    const globalVoice = { providerId: 'openai-tts' as const, voiceId: 'alloy' };
    const playback = selectedAgentIds
      .map((id) => catalogue.find((entry) => entry.id === id))
      .filter((entry): entry is AgentConfig => entry != null);
    const pill = voicePillPlaybackRoster(catalogue, selectedAgentIds, student);
    const displayed = resolveAgentVoice(student, pill.index, providers, overrides, {
      roster: pill.roster,
      globalVoice,
    });
    const spoken = resolveAgentVoice(
      student,
      playback.findIndex((entry) => entry.id === student.id),
      providers,
      overrides,
      { roster: playback, globalVoice },
    );
    expect(displayed).toEqual(spoken);
    expect(spoken?.voiceId).toBe('shimmer');
  });
});

describe('resolveAgentVoice localized gender field', () => {
  function minimax() {
    return getEnabledProvidersWithVoices({
      'minimax-tts': { apiKey: 'k', enabled: true },
    });
  }

  function chineseFemale(voiceConfig?: AgentConfig['voiceConfig']): AgentConfig {
    return agent({
      role: 'student',
      voiceConfig,
      voiceDesign: {
        identity: '年轻女性学生',
        texture: '清亮',
        delivery: '轻快',
        gender: 'female',
      },
    });
  }

  it('uses voiceDesign.gender when a Chinese identity has no voice', () => {
    // Index 1 of the full MiniMax list is male-qn-jingying. A gender-blind
    // fallback lands there; a female field must take the second female voice.
    expect(resolveAgentVoice(chineseFemale(), 1, minimax())?.voiceId).toBe('female-shaonv');
  });

  it('uses voiceDesign.gender when a Chinese identity has an invalid voice', () => {
    const unbound = chineseFemale({
      providerId: 'minimax-tts',
      voiceId: 'not-a-catalogue-voice',
    });
    expect(resolveAgentVoice(unbound, 1, minimax())?.voiceId).toBe('female-shaonv');
  });

  it('keeps the index pick for a Chinese identity when gender is absent', () => {
    const providers = minimax();
    expect(resolveAgentVoice(withIdentity('年轻女性学生'), 1, providers)?.voiceId).toBe(
      'male-qn-jingying',
    );
  });

  it('gives a later Chinese agent the next female voice using voiceDesign.gender', () => {
    const providers = minimax();
    const first = chineseFemale();
    const second = chineseFemale();
    const roster = [first, second];
    expect(resolveAgentVoice(first, 0, providers, undefined, { roster })?.voiceId).toBe(
      'female-yujie',
    );
    expect(resolveAgentVoice(second, 1, providers, undefined, { roster })?.voiceId).toBe(
      'female-shaonv',
    );
  });
});

describe('browser-native lecture voice missing from the dynamic list', () => {
  function browserProviders(
    voices: Array<{ voiceURI: string; name: string; lang?: string; default?: boolean }>,
  ): ProviderWithVoices[] {
    return getSelectableProvidersWithVoices(
      { 'browser-native-tts': { enabled: true } },
      [],
      voices,
    );
  }

  it('does not give the first unbound student the voice a "default" sentinel speaks', () => {
    // No lang tags: the sentinel falls through language matching to the
    // flagged default, which is also first.
    const providers = browserProviders([
      { voiceURI: 'uri-david', name: 'David', default: true },
      { voiceURI: 'uri-zira', name: 'Zira' },
    ]);
    expect(providers[0]?.voices[0]).toMatchObject({ id: 'uri-david', default: true });
    const teacher = agent({ id: 'teacher', role: 'teacher' });
    const student = agent({ id: 'student', role: 'student' });
    const roster = [teacher, student];
    const globalVoice = { providerId: 'browser-native-tts' as const, voiceId: 'default' };
    expect(
      resolveAgentVoice(student, 1, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-zira');
  });

  it('does not give the first unbound student the voice a stale browser URI speaks', () => {
    // No lang tags and no default flag: a missing URI falls through to the
    // first dynamic voice.
    const providers = browserProviders([
      { voiceURI: 'uri-david', name: 'David' },
      { voiceURI: 'uri-zira', name: 'Zira' },
    ]);
    const teacher = agent({ id: 'teacher', role: 'teacher' });
    const student = agent({ id: 'student', role: 'student' });
    const roster = [teacher, student];
    const globalVoice = {
      providerId: 'browser-native-tts' as const,
      voiceId: 'com.apple.voice.compact.gone',
    };
    expect(
      resolveAgentVoice(student, 1, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-zira');
  });

  it('reserves a later marked browser default instead of the first dynamic voice', () => {
    // No lang tags: a later default===true wins over index 0. Reserving Zira
    // would give David to the first student.
    const providers = browserProviders([
      { voiceURI: 'uri-zira', name: 'Zira' },
      { voiceURI: 'uri-david', name: 'David', default: true },
      { voiceURI: 'uri-mark', name: 'Mark' },
    ]);
    // Gender info keeps coordinated allocation; a neutral catalogue would use the index.
    providers[0].voices[0].gender = 'male';
    expect(providers[0]?.voices.find((voice) => voice.default)?.id).toBe('uri-david');
    const teacher = agent({ id: 'teacher', role: 'teacher' });
    const first = agent({ id: 'student-1', role: 'student' });
    const second = agent({ id: 'student-2', role: 'student' });
    const roster = [teacher, first, second];
    const globalVoice = { providerId: 'browser-native-tts' as const, voiceId: 'default' };
    expect(
      resolveAgentVoice(first, 1, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-zira');
    expect(
      resolveAgentVoice(second, 2, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-mark');
  });

  it('keeps browser voice lang on the selectable catalogue', () => {
    const providers = browserProviders([
      { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh-CN' },
    ]);
    expect(providers[0]?.voices[0]).toMatchObject({ id: 'uri-xiaoxiao', lang: 'zh-CN' });
  });

  it('reserves an in-list browser URI as itself', () => {
    // David is in the list. A later zh-CN voice must not replace that id,
    // or the first student would receive David.
    const providers = browserProviders([
      { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true },
      { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh-CN' },
      { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB' },
    ]);
    const teacher = agent({ id: 'teacher', role: 'teacher' });
    const student = agent({ id: 'student', role: 'student' });
    const roster = [teacher, student];
    const globalVoice = { providerId: 'browser-native-tts' as const, voiceId: 'uri-david' };
    expect(
      resolveAgentVoice(student, 1, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-xiaoxiao');
  });

  it('does not reserve a browser voice for a lecture voice on another provider', () => {
    const providers = browserProviders([
      { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true },
      { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh-CN' },
      { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB' },
    ]);
    // Gender info keeps coordinated allocation; a neutral catalogue would use the index.
    providers[0].voices[0].gender = 'male';
    const teacher = agent({ id: 'teacher', role: 'teacher' });
    const first = agent({ id: 'student-1', role: 'student' });
    const second = agent({ id: 'student-2', role: 'student' });
    const roster = [teacher, first, second];
    const globalVoice = { providerId: 'openai-tts' as const, voiceId: 'nova' };
    expect(
      resolveAgentVoice(first, 1, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-david');
    expect(
      resolveAgentVoice(second, 2, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-xiaoxiao');
  });

  it('reserves the zh-CN voice a sentinel speaks when that voice is neither default nor first', () => {
    // Discussion speaks zh-CN for the sentinel. Xiaoxiao is that voice.
    // The first student must not receive it; the second takes Zira, so
    // Xiaoxiao stays reserved.
    const providers = browserProviders([
      { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true },
      { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh-CN' },
      { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB' },
    ]);
    // Gender info keeps coordinated allocation; a neutral catalogue would use the index.
    providers[0].voices[0].gender = 'male';
    const teacher = agent({ id: 'teacher', role: 'teacher' });
    const first = agent({ id: 'student-1', role: 'student' });
    const second = agent({ id: 'student-2', role: 'student' });
    const roster = [teacher, first, second];
    const globalVoice = { providerId: 'browser-native-tts' as const, voiceId: 'default' };
    expect(
      resolveAgentVoice(first, 1, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-david');
    expect(
      resolveAgentVoice(second, 2, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-zira');
  });

  it('reserves the zh-CN voice a stale browser URI speaks when that voice is neither default nor first', () => {
    const providers = browserProviders([
      { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true },
      { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh-CN' },
      { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB' },
    ]);
    // Gender info keeps coordinated allocation; a neutral catalogue would use the index.
    providers[0].voices[0].gender = 'male';
    const teacher = agent({ id: 'teacher', role: 'teacher' });
    const first = agent({ id: 'student-1', role: 'student' });
    const second = agent({ id: 'student-2', role: 'student' });
    const roster = [teacher, first, second];
    const globalVoice = {
      providerId: 'browser-native-tts' as const,
      voiceId: 'com.apple.voice.compact.gone',
    };
    expect(
      resolveAgentVoice(first, 1, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-david');
    expect(
      resolveAgentVoice(second, 2, providers, undefined, { roster, globalVoice })?.voiceId,
    ).toBe('uri-zira');
  });

  it('does not give an unbound student the voice a stale browser binding speaks', () => {
    // Global lecture voice is David. A missing student URI speaks Xiaoxiao for
    // zh-CN, which is neither the flagged default nor the first voice. Zira is
    // free, so the unbound student must not be given Xiaoxiao.
    const providers = browserProviders([
      { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true },
      { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh-CN' },
      { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB' },
    ]);
    const teacher = agent({ id: 'teacher', role: 'teacher' });
    const bound = agent({
      id: 'student-stale',
      role: 'student',
      voiceConfig: {
        providerId: 'browser-native-tts',
        voiceId: 'com.apple.voice.compact.gone',
      },
    });
    const unbound = agent({ id: 'student-free', role: 'student' });
    const roster = [teacher, bound, unbound];
    const globalVoice = { providerId: 'browser-native-tts' as const, voiceId: 'uri-david' };
    expect(
      resolveAgentVoice(unbound, 2, providers, undefined, {
        roster,
        globalVoice,
        utteranceLang: 'zh-CN',
      })?.voiceId,
    ).toBe('uri-zira');
  });

  it('does not give an unbound student the voice a student "default" sentinel speaks', () => {
    const providers = browserProviders([
      { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true },
      { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh-CN' },
      { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB' },
    ]);
    const teacher = agent({ id: 'teacher', role: 'teacher' });
    const bound = agent({
      id: 'student-default',
      role: 'student',
      voiceConfig: {
        providerId: 'browser-native-tts',
        voiceId: 'default',
      },
    });
    const unbound = agent({ id: 'student-free', role: 'student' });
    const roster = [teacher, bound, unbound];
    const globalVoice = { providerId: 'browser-native-tts' as const, voiceId: 'uri-david' };
    expect(
      resolveAgentVoice(unbound, 2, providers, undefined, {
        roster,
        globalVoice,
        utteranceLang: 'zh-CN',
      })?.voiceId,
    ).toBe('uri-zira');
  });

  it('reserves an in-list student browser URI as itself', () => {
    // Zira is installed. zh-CN must not replace that reservation, or the
    // unbound student would receive Zira while Xiaoxiao stays free.
    const providers = browserProviders([
      { voiceURI: 'uri-david', name: 'David', lang: 'en-US', default: true },
      { voiceURI: 'uri-xiaoxiao', name: 'Xiaoxiao', lang: 'zh-CN' },
      { voiceURI: 'uri-zira', name: 'Zira', lang: 'en-GB' },
    ]);
    // Gender info keeps coordinated allocation; a neutral catalogue would use the index.
    providers[0].voices[0].gender = 'male';
    const teacher = agent({ id: 'teacher', role: 'teacher' });
    const bound = agent({
      id: 'student-zira',
      role: 'student',
      voiceConfig: {
        providerId: 'browser-native-tts',
        voiceId: 'uri-zira',
      },
    });
    const unbound = agent({ id: 'student-free', role: 'student' });
    const roster = [teacher, bound, unbound];
    const globalVoice = { providerId: 'browser-native-tts' as const, voiceId: 'uri-david' };
    expect(
      resolveAgentVoice(unbound, 2, providers, undefined, {
        roster,
        globalVoice,
        utteranceLang: 'zh-CN',
      })?.voiceId,
    ).toBe('uri-xiaoxiao');
  });
});
