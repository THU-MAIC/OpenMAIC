import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const callLLM = vi.fn();

vi.mock('@/lib/ai/llm', () => ({
  callLLM: (...args: unknown[]) => callLLM(...args),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: async () => ({
    model: {},
    modelString: 'test-model',
    thinkingConfig: undefined,
  }),
}));

import { POST } from '@/app/api/generate/agent-profiles/route';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/generate/agent-profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stageInfo: { name: 'Intro to Algebra' },
      languageDirective: 'Respond in English.',
      availableAvatars: ['/a.png', '/b.png'],
    }),
  });
}

function llmAgents(extra: Record<string, unknown>) {
  return JSON.stringify({
    agents: [
      {
        name: 'Prof. Lin',
        role: 'teacher',
        persona: 'A patient mentor.',
        avatar: '/a.png',
        color: '#111111',
        priority: 10,
        ...extra,
      },
      {
        name: 'Sam',
        role: 'student',
        persona: 'Curious learner.',
        avatar: '/b.png',
        color: '#222222',
        priority: 5,
      },
    ],
  });
}

describe('agent-profiles route — voiceDesign', () => {
  beforeEach(() => callLLM.mockReset());

  it('attaches a normalized voiceDesign when the LLM emits one', async () => {
    callLLM.mockResolvedValue({
      text: llmAgents({
        voiceDesign: { identity: 'older male teacher', texture: 'warm low', delivery: 'calm' },
      }),
    });

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.agents[0].voiceDesign).toEqual({
      identity: 'older male teacher',
      texture: 'warm low',
      delivery: 'calm',
    });
  });

  it('omits voiceDesign when the LLM does not emit one', async () => {
    callLLM.mockResolvedValue({ text: llmAgents({}) });

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.agents[0]).not.toHaveProperty('voiceDesign');
  });
});
