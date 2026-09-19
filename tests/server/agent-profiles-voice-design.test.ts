import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { QWEN_TTS_VOICE_CLONE_MODEL } from '@/lib/audio/constants';

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

function makeRequest(extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/generate/agent-profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stageInfo: { name: 'Intro to Algebra' },
      languageDirective: 'Respond in English.',
      availableAvatars: ['/a.png', '/b.png'],
      ...extra,
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

  it('preserves the advertised model in the generated voice binding', async () => {
    callLLM.mockResolvedValue({
      text: llmAgents({ voice: 'qwen-tts::qwen3-tts-vc-test::clone-1' }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-test',
            voiceId: 'clone-1',
            voiceName: 'Clone',
          },
        ],
      }),
    );
    const body = await res.json();
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-vc-test',
      voiceId: 'clone-1',
    });
  });

  it('drops a non-string voice value without failing the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    callLLM.mockResolvedValue({ text: llmAgents({ voice: 123 }) });

    const res = await POST(
      makeRequest({
        availableVoices: [{ providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' }],
      }),
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.agents[0]).not.toHaveProperty('voiceConfig');
    expect(warn).toHaveBeenCalledWith(
      '[AgentProfiles] Dropped voice token not present in the advertised list:',
      123,
    );
    warn.mockRestore();
  });

  it('prefers an exact advertised token when provider and voice IDs are duplicated', async () => {
    callLLM.mockResolvedValue({
      text: llmAgents({ voice: 'qwen-tts::qwen3-tts-vc-second::clone-1' }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-first',
            voiceId: 'clone-1',
            voiceName: 'First clone',
          },
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-second',
            voiceId: 'clone-1',
            voiceName: 'Second clone',
          },
        ],
      }),
    );
    const body = await res.json();

    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-vc-second',
      voiceId: 'clone-1',
    });
  });

  it('accepts a two-part clone token and derives its advertised model', async () => {
    callLLM.mockResolvedValue({ text: llmAgents({ voice: 'qwen-tts::clone-1' }) });
    const res = await POST(
      makeRequest({
        availableVoices: [
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-test',
            voiceId: 'clone-1',
            voiceName: 'Clone',
          },
        ],
      }),
    );
    const body = await res.json();
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-vc-test',
      voiceId: 'clone-1',
    });
  });

  it('accepts a two-part catalog voice token without persisting a model', async () => {
    callLLM.mockResolvedValue({ text: llmAgents({ voice: 'qwen-tts::Cherry' }) });
    const res = await POST(
      makeRequest({
        availableVoices: [{ providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' }],
      }),
    );
    const body = await res.json();
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'Cherry',
    });
  });

  it('accepts a three-part catalog token without trusting its model segment', async () => {
    callLLM.mockResolvedValue({
      text: llmAgents({ voice: 'qwen-tts::qwen3-tts-vc-stale::Cherry' }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [{ providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' }],
      }),
    );
    const body = await res.json();
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'Cherry',
    });
  });

  it('pins the teacher voice to the passed narrator voice verbatim', async () => {
    // The LLM would have picked Cherry for the teacher, but the user's narrator
    // voice (the advertised clone) must win.
    callLLM.mockResolvedValue({
      text: llmAgents({ voice: 'qwen-tts::Cherry' }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-test',
            voiceId: 'clone-1',
            voiceName: 'Clone',
          },
        ],
        narratorVoice: {
          providerId: 'qwen-tts',
          modelId: 'qwen3-tts-vc-test',
          voiceId: 'clone-1',
        },
      }),
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-vc-test',
      voiceId: 'clone-1',
    });
  });

  it('honors a narrator clone voice that is not in the advertised list', async () => {
    callLLM.mockResolvedValue({
      text: llmAgents({ voice: 'qwen-tts::Cherry' }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [{ providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' }],
        narratorVoice: {
          providerId: 'qwen-tts',
          modelId: 'qwen3-tts-vc-test',
          voiceId: 'clone-ghost',
        },
      }),
    );
    const body = await res.json();
    // The clone is account-scoped and self-contained; the model follows the voice.
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: QWEN_TTS_VOICE_CLONE_MODEL,
      voiceId: 'clone-ghost',
    });
  });

  it('still assigns LLM-picked voices to non-teacher agents when the narrator voice is pinned', async () => {
    callLLM.mockResolvedValue({
      text: JSON.stringify({
        agents: [
          {
            name: 'Prof. Lin',
            role: 'teacher',
            persona: 'A patient mentor.',
            avatar: '/a.png',
            color: '#111111',
            priority: 10,
          },
          {
            name: 'Sam',
            role: 'student',
            persona: 'Curious learner.',
            avatar: '/b.png',
            color: '#222222',
            priority: 5,
            voice: 'qwen-tts::Cherry',
          },
        ],
      }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [
          { providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' },
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-test',
            voiceId: 'clone-1',
            voiceName: 'Clone',
          },
        ],
        narratorVoice: {
          providerId: 'qwen-tts',
          modelId: 'qwen3-tts-vc-test',
          voiceId: 'clone-1',
        },
      }),
    );
    const body = await res.json();
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-vc-test',
      voiceId: 'clone-1',
    });
    expect(body.agents[1].voiceConfig).toEqual({ providerId: 'qwen-tts', voiceId: 'Cherry' });
  });

  it('falls back to the LLM-assigned teacher voice when narratorVoice is absent', async () => {
    callLLM.mockResolvedValue({
      text: llmAgents({ voice: 'qwen-tts::qwen3-tts-vc-test::clone-1' }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-test',
            voiceId: 'clone-1',
            voiceName: 'Clone',
          },
        ],
      }),
    );
    const body = await res.json();
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-vc-test',
      voiceId: 'clone-1',
    });
  });

  it('ignores a narrator voice that is neither advertised nor a valid clone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    callLLM.mockResolvedValue({
      text: llmAgents({ voice: 'qwen-tts::Cherry' }),
    });
    const res = await POST(
      makeRequest({
        availableVoices: [{ providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' }],
        narratorVoice: { providerId: 'openai-tts', voiceId: 'not-advertised' },
      }),
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    // The unusable narrator voice is dropped; the LLM's choice stands.
    expect(body.agents[0].voiceConfig).toEqual({ providerId: 'qwen-tts', voiceId: 'Cherry' });
    warn.mockRestore();
  });

  it('keeps the schema example token from the advertised list when the narrator is a ghost clone', async () => {
    // The pinned narrator clone is NOT advertised (deleted/ghost): the schema
    // example must still come from the advertised list so an LLM echoing it
    // into a student's voice field produces a resolvable token.
    callLLM.mockResolvedValue({ text: llmAgents({}) });
    const res = await POST(
      makeRequest({
        availableVoices: [{ providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' }],
        narratorVoice: {
          providerId: 'qwen-tts',
          modelId: 'qwen3-tts-vc-test',
          voiceId: 'clone-ghost',
        },
      }),
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    // The teacher is still pinned to the (self-contained) ghost clone…
    expect(body.agents[0].voiceConfig).toEqual({
      providerId: 'qwen-tts',
      modelId: QWEN_TTS_VOICE_CLONE_MODEL,
      voiceId: 'clone-ghost',
    });
    // …but the schema example token is always an advertised voice.
    const prompt = callLLM.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("e.g. 'qwen-tts::Cherry'");
    expect(prompt).not.toContain(`e.g. 'qwen-tts::${QWEN_TTS_VOICE_CLONE_MODEL}::clone-ghost'`);
  });

  it('prompts for a voice on every non-teacher agent and never reuses the teacher voice', async () => {
    callLLM.mockResolvedValue({ text: llmAgents({}) });
    const res = await POST(
      makeRequest({
        availableVoices: [
          { providerId: 'qwen-tts', voiceId: 'Cherry', voiceName: 'Cherry' },
          {
            providerId: 'qwen-tts',
            modelId: 'qwen3-tts-vc-test',
            voiceId: 'clone-1',
            voiceName: 'Clone',
          },
        ],
        narratorVoice: {
          providerId: 'qwen-tts',
          modelId: 'qwen3-tts-vc-test',
          voiceId: 'clone-1',
        },
      }),
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    const prompt = callLLM.mock.calls[0][0].prompt as string;
    // The softened phrasing still requires a voice field on every non-teacher
    // agent (the old "ONLY to the other agents" over-generalized into omissions).
    expect(prompt).toContain('Every OTHER agent must still be assigned a voice from this list');
    expect(prompt).not.toContain('Assign voices ONLY to the other');
    // The fixed teacher voice is out of bounds for non-teacher assignment.
    expect(prompt).toContain('Never assign the fixed teacher narrator voice to any other agent');
  });
});
