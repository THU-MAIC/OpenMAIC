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
