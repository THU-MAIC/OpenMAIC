import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  generateAgentProfiles,
  type AgentProfilesInput,
} from '@/lib/server/generation/steps/agent-profiles';

import { fakeModel, jsonRequest, testLogger, withoutMintedValues } from './helpers';

const mocks = vi.hoisted(() => ({ callLLM: vi.fn(), resolveModelFromRequest: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

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
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue(model);
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

  it('answers the route exactly as the step does', async () => {
    answer(classroom);
    const { POST } = await import('@/app/api/generate/agent-profiles/route');
    const response = await POST(
      jsonRequest('http://localhost/api/generate/agent-profiles', request),
    );
    expect(response.status).toBe(200);
    const routed = (await response.json()) as { agents: unknown };

    const stepped = await generateAgentProfiles({ ...request, model }, { log: testLogger() });
    expect(withoutMintedValues(routed)).toEqual({
      success: true,
      agents: withoutMintedValues(stepped),
    });
  });

  it('maps each refusal to the status and code the route always answered', async () => {
    mocks.callLLM.mockResolvedValue({ text: 'not json' });
    const { POST } = await import('@/app/api/generate/agent-profiles/route');
    const response = await POST(
      jsonRequest('http://localhost/api/generate/agent-profiles', request),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'PARSE_FAILED',
      error: 'Failed to parse agent profiles from LLM response',
    });
  });
});
