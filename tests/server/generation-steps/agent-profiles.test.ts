import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  generateAgentProfiles,
  type AgentProfilesInput,
} from '@/lib/server/generation/steps/agent-profiles';

import { fakeModel, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({ callLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));

const model = fakeModel();

const request: Omit<AgentProfilesInput, 'model'> = {
  stageInfo: { name: 'Photosynthesis', description: 'How plants make food' },
  sceneOutlines: [{ title: 'Light reactions' }, { title: 'Calvin cycle', description: 'Carbon' }],
  languageDirective: 'Teach in English.',
  availableAvatars: ['/a.png', '/b.png'],
  availableVoices: [
    { providerId: 'tts-a', voiceId: 'v1', voiceName: 'One' },
    { providerId: 'tts-a', modelId: 'm2', voiceId: 'v2', voiceName: 'Two' },
  ],
  narratorVoice: { providerId: 'tts-a', voiceId: 'v2' },
};

function answer(agents: unknown[]) {
  mocks.callLLM.mockResolvedValue({ text: '```json\n' + JSON.stringify({ agents }) + '\n```' });
}

const classroom = [
  { name: 'Ms. Lee', role: 'teacher', persona: 'Calm.', avatar: '/a.png', color: '#111' },
  {
    name: 'Sam',
    role: 'student',
    persona: 'Curious.',
    voice: 'tts-a::v1',
    voiceDesign: { identity: 'young boy', texture: 'bright', delivery: 'quick' },
  },
];

describe('agent profiles step', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.callLLM.mockReset();
  });

  it('binds the teacher to the narrator voice and the others to advertised voices', async () => {
    answer(classroom);
    const agents = await generateAgentProfiles({ ...request, model }, { log: testLogger() });

    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ model: model.model }),
      'agent-profiles',
      undefined,
      undefined,
      { serverManaged: false },
    );
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      role: 'teacher',
      priority: 10,
      voiceConfig: { providerId: 'tts-a', modelId: 'm2', voiceId: 'v2' },
    });
    expect(agents[1]).toMatchObject({
      role: 'student',
      avatar: '/b.png',
      priority: 5,
      voiceConfig: { providerId: 'tts-a', voiceId: 'v1' },
      voiceDesign: { identity: 'young boy', texture: 'bright', delivery: 'quick' },
    });
    expect(agents[0]!.id).toMatch(/^gen-/);
  });

  it.each([
    ['not json', 'unparseable'],
    [JSON.stringify({ agents: [classroom[0]] }), 'too-few-agents'],
    [JSON.stringify({ agents: [classroom[0], classroom[0]] }), 'teacher-count'],
  ])('refuses an unusable answer (%#)', async (text, reason) => {
    mocks.callLLM.mockResolvedValue({ text });
    const failure = await generateAgentProfiles({ ...request, model }, { log: testLogger() }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StepRefusal);
    expect((failure as StepRefusal).reason).toBe(reason);
  });
});

it('preserves a catalogue-backed provider default through profile generation and narration', async () => {
  const { advertisedVoices, narratorVoiceForGeneration, clipVoice } =
    await import('@/lib/server/generation/run/narration-voice');
  const target = {
    providerId: 'openai-tts' as const,
    modelId: 'qwen3-tts',
    connection: {
      providerId: 'openai-tts',
      managed: true,
      userEndpoint: false,
      origin: 'configuration' as const,
      options: { defaultVoice: 'vivian' },
      voices: [{ id: 'vivian', name: 'Vivian' }],
    },
  };
  answer(classroom.map((agent) => ({ ...agent, voice: 'openai-tts::alloy' })));
  const agents = await generateAgentProfiles(
    {
      ...request,
      model,
      availableVoices: advertisedVoices(target),
      narratorVoice: narratorVoiceForGeneration(target, undefined),
    },
    { log: testLogger() },
  );
  const teacher = agents.find((agent) => agent.role === 'teacher');
  expect(teacher?.voiceConfig).toEqual({ providerId: 'openai-tts', voiceId: 'vivian' });
  expect(
    clipVoice({
      target,
      preference: undefined,
      bound: teacher?.voiceConfig
        ? { ...teacher.voiceConfig, providerId: 'openai-tts' }
        : undefined,
      unavailable: new Set(),
    })?.voice.voiceId,
  ).toBe('vivian');
  expect(advertisedVoices(target).map((voice) => voice.voiceId)).toEqual(['vivian']);
});

const savedClone = 'openmaic-a6d84a34-0503-45d1-9da7-845f0e83f2df';
const studioVoice = 'studio-narrator';

it.each([
  { managed: true, curated: true, selected: savedClone, expected: savedClone },
  { managed: false, curated: false, selected: studioVoice, expected: studioVoice },
  { managed: true, curated: false, selected: studioVoice, expected: 'female-yujie' },
  { managed: false, curated: true, selected: studioVoice, expected: 'female-yujie' },
])(
  'narrates with $expected for a $selected pick (managed=$managed, curated=$curated)',
  async ({ managed, curated, selected, expected }) => {
    const { advertisedVoices, narratorVoiceForGeneration, clipVoice } =
      await import('@/lib/server/generation/run/narration-voice');
    const providerId = 'minimax-tts' as const;
    const target = {
      providerId,
      connection: {
        providerId,
        apiKey: 'test-key',
        managed,
        origin: 'configuration' as const,
        userEndpoint: !managed,
        ...(curated ? { voices: [{ id: 'female-yujie', name: 'Preset' }] } : {}),
      },
    };
    const preference = { providerId, voiceId: selected };
    answer([
      { ...classroom[0], voice: 'minimax-tts::female-yujie' },
      { ...classroom[1], voice: `minimax-tts::${selected}` },
    ]);
    const [teacher, student] = await generateAgentProfiles(
      {
        ...request,
        model,
        availableVoices: advertisedVoices(target),
        narratorVoice: narratorVoiceForGeneration(target, preference),
      },
      { log: testLogger() },
    );
    expect(teacher.voiceConfig).toEqual({ providerId, voiceId: expected });
    expect(
      clipVoice({
        target,
        preference,
        bound: { ...teacher.voiceConfig!, providerId },
        unavailable: new Set(),
      })?.voice.voiceId,
    ).toBe(expected);
    expect(student.voiceConfig).toBeUndefined();
  },
);
