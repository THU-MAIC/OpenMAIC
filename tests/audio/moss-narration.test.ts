import { expect, it } from 'vitest';
import { getBuiltInAgent } from '@/lib/orchestration/registry/built-in';
import { mossRoleGender, mossRoleVoice, precedingSpeechTexts } from '@/lib/audio/moss-tts';
import {
  resolveAgentVoice,
  resolveNarratorVoiceBinding,
  getEnabledProvidersWithVoices,
} from '@/lib/audio/voice-resolver';
import {
  advertisedVoices,
  clipVoice,
  narratorVoiceForGeneration,
} from '@/lib/server/generation/run/narration-voice';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { RunNarrationTarget } from '@/lib/server/generation/run/narration-voice';

it('lets the active speech API voice the same built-in teacher', () => {
  const teacher = getBuiltInAgent('default-1')!;
  expect(teacher.voiceConfig).toBeUndefined();
  expect(teacher.voiceDesign).toBeUndefined();
  expect(teacher.avatar).toBe('/avatars/teacher.png');
  const providerId = 'openai-tts';
  const apiVoices = [
    { id: 'guide', name: 'Guide', gender: 'male' as const },
    { id: 'speaker', name: 'Speaker', gender: 'female' as const },
  ];
  for (const [modelId, options, catalogue, expected] of [
    ['qwen3-tts', {}, [{ id: 'Vivian', name: 'Vivian' }], 'Vivian'],
    ['my-hosted-model', { backend: 'moss', defaultVoice: 'speaker' }, apiVoices, 'speaker'],
  ] as const) {
    const globalVoice = { providerId, modelId, voiceId: expected } as const;
    const config = {
      [providerId]: {
        isServerConfigured: true,
        modelId,
        providerOptions: options,
        voices: [...catalogue],
      },
    };
    expect(
      resolveNarratorVoiceBinding(teacher.voiceConfig, globalVoice, config, teacher.voiceDesign),
    ).toEqual(globalVoice);
  }
});

const speech = (id: string, text: string) => ({ id, type: 'speech' as const, text });

it('takes three preceding spoken lines across scenes in script order, even for a retried clip', () => {
  const scenes = [
    { id: 'first', actions: [speech('old', '一'), speech('prior', '二'), speech('end', '三')] },
    { id: 'second', actions: [speech('prior', '四'), speech('now', '五'), speech('later', '六')] },
  ];
  expect(precedingSpeechTexts(scenes, 'second', 'now')).toEqual(['二', '三', '四']);
  expect(precedingSpeechTexts(scenes, 'first', 'old')).toEqual([]);
  expect(precedingSpeechTexts(scenes, 'second', 'missing')).toEqual([]);
});

const filmVoice = 'test-film-voice';
const voices = [
  { id: 'course-narrator', name: '课程女教师', gender: 'female' as const },
  { id: filmVoice, name: '影视解说男声', gender: 'male' as const },
];
const female = { gender: 'female' as const, identity: '教师', texture: '', delivery: '' };
const male = { ...female, gender: 'male' as const };

it('keeps the established role defaults and honors separate teacher and student choices from the expanded catalogue', () => {
  const bright = {
    id: 'test-bright-voice',
    name: '轻快灵动女声',
    gender: 'female' as const,
  };
  const poetry = {
    id: 'test-poetry-voice',
    name: '诗词朗读',
    gender: 'male' as const,
  };
  const catalog = [...voices, bright, poetry];
  const providerId = 'openai-tts' as const;
  const modelId = 'teaching-v3';
  const configs = {
    [providerId]: {
      apiKey: '',
      baseUrl: '',
      enabled: true,
      isServerConfigured: true,
      providerOptions: { backend: 'moss' },
      modelId,
      voices: catalog,
    },
  };
  const providers = getEnabledProvidersWithVoices(configs);
  expect(providers[0].voices.map((v) => v.id)).toEqual(catalog.map((v) => v.id));
  const pupil = { id: 'pupil', role: 'student', voiceDesign: male } as AgentConfig;
  expect(resolveAgentVoice(pupil, 3, providers)?.voiceId).toBe(filmVoice);
  expect(
    resolveAgentVoice(pupil, 3, providers, { pupil: { providerId, modelId, voiceId: poetry.id } })
      ?.voiceId,
  ).toBe(poetry.id);
  const target = {
    providerId,
    modelId,
    connection: {
      providerId,
      modelId,
      voices: catalog,
      managed: true,
      userEndpoint: false,
      origin: 'configuration',
      options: { backend: 'moss', defaultVoice: 'course-narrator' },
    },
  } satisfies RunNarrationTarget;
  const preference = { providerId, voiceId: bright.id, speed: 1 };
  const bound = { providerId, modelId, voiceId: 'course-narrator' };
  expect(
    clipVoice({ target, preference, bound, design: female, unavailable: new Set() })?.voice.voiceId,
  ).toBe(bright.id);
  expect(mossRoleVoice(catalog, poetry.id, 'male')).toBe(poetry.id);
  expect(advertisedVoices(target).map((v) => v.voiceId)).toEqual(['course-narrator', filmVoice]);
  expect(advertisedVoices(target, preference).map((v) => v.voiceId)).toContain(bright.id);
  expect(narratorVoiceForGeneration(target, preference)?.voiceId).toBe(bright.id);
});

it('selects the role voice before a legacy binding or the opposite per-course preference', () => {
  const global = {
    providerId: 'openai-tts' as const,
    modelId: 'teaching-v3',
    voiceId: 'course-narrator',
  };
  const old = { providerId: global.providerId, modelId: 'qwen3-tts', voiceId: 'Vivian' };
  const config = {
    'openai-tts': {
      enabled: true,
      isServerConfigured: true,
      providerOptions: { backend: 'moss' },
      voices,
    },
  };
  expect(resolveNarratorVoiceBinding(old, global, config, male).voiceId).toBe(filmVoice);
  expect(
    resolveNarratorVoiceBinding({ ...old, voiceId: filmVoice }, global, config, female).voiceId,
  ).toBe('course-narrator');
  expect(resolveNarratorVoiceBinding(old, global, config).voiceId).toBe('course-narrator');
  const target = {
    providerId: global.providerId,
    modelId: global.modelId,
    connection: {
      providerId: global.providerId,
      modelId: global.modelId,
      voices,
      options: { backend: 'moss' },
      managed: true,
      userEndpoint: false,
      origin: 'configuration',
    },
  } satisfies RunNarrationTarget;
  expect(narratorVoiceForGeneration(target, undefined)).toBeUndefined();
  expect(
    clipVoice({ target, preference: undefined, unavailable: new Set(), bound: old, design: male })
      ?.voice.voiceId,
  ).toBe(filmVoice);
});

it('recognizes clear older identity fields and accepts the selected catalogue ID for a preview', () => {
  expect(mossRoleGender({ identity: '青年男教师', texture: '', delivery: '' })).toBe('male');
  expect(mossRoleGender({ identity: 'female teacher', texture: '', delivery: '' })).toBe('female');
  expect(mossRoleGender({ identity: '中学讲师', texture: '', delivery: '' })).toBeUndefined();
  expect(mossRoleVoice(voices, filmVoice)).toBe(filmVoice);
  expect(mossRoleVoice(voices, 'Vivian')).toBe('course-narrator');
});

it('uses the actual MOSS voice for a new clip of a course originally bound to Vivian', () => {
  const global = {
    providerId: 'openai-tts' as const,
    modelId: 'teaching-v3',
    voiceId: 'course-narrator',
  };
  const old = { providerId: global.providerId, modelId: 'qwen3-tts', voiceId: 'Vivian' };
  expect(
    resolveNarratorVoiceBinding(old, global, {
      'openai-tts': {
        enabled: true,
        isServerConfigured: true,
        providerOptions: { backend: 'moss' },
      },
    }),
  ).toEqual(global);
});
