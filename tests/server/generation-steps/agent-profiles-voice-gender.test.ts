/**
 * The profile generator shows catalogue gender and asks the model to match it.
 * A voice the model actually returned is kept, including an opposite-gender one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaConnection } from '@/lib/server/model-config/media';
import {
  advertisedVoices,
  type RunNarrationTarget,
} from '@/lib/server/generation/run/narration-voice';
import {
  generateAgentProfiles,
  type AgentProfilesInput,
} from '@/lib/server/generation/steps/agent-profiles';

import { fakeModel, testLogger } from './helpers';

const callLLM = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  callLLM: (...args: unknown[]) => callLLM(...args),
}));

type VoiceGender = 'male' | 'female' | 'neutral';

/** MiniMax-style catalogue: Chinese display names, gender only on the entry. */
const MINIMAX_VOICES: NonNullable<AgentProfilesInput['availableVoices']> = [
  {
    providerId: 'minimax-tts',
    voiceId: 'English_Graceful_Lady',
    voiceName: 'Graceful Lady',
    voiceLanguage: 'en-US',
    gender: 'female',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'female-yujie',
    voiceName: '御姐音色',
    voiceLanguage: 'zh-CN',
    gender: 'female',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'male-qn-jingying',
    voiceName: '精英青年',
    voiceLanguage: 'zh-CN',
    gender: 'male',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'female-shaonv',
    voiceName: '少女音色',
    voiceLanguage: 'zh-CN',
    gender: 'female',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'Chinese (Mandarin)_Gentleman',
    voiceName: '温润男声',
    voiceLanguage: 'zh-CN',
    gender: 'male',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'English_expressive_narrator',
    voiceName: 'Expressive Narrator',
    voiceLanguage: 'en-US',
    gender: 'neutral',
  },
  {
    providerId: 'minimax-tts',
    voiceId: 'custom-clone',
    voiceName: '未标注音色',
    voiceLanguage: 'zh-CN',
  },
];

const minimaxTarget: RunNarrationTarget = {
  connection: {
    providerId: 'minimax-tts',
    managed: true,
    userEndpoint: false,
    origin: 'configuration',
  } as MediaConnection,
  providerId: 'minimax-tts',
};

function token(voiceId: string): string {
  return `minimax-tts::${voiceId}`;
}

function profile(extra: Record<string, unknown> & { name: string; role: string }) {
  return {
    persona: 'Takes part in the class.',
    avatar: '/a.png',
    color: '#111111',
    priority: extra.role === 'teacher' ? 10 : 5,
    voiceDesign: {
      identity: 'middle-aged female teacher',
      texture: 'warm low',
      delivery: 'calm',
    },
    ...extra,
  };
}

async function generate(agents: unknown[], extra: Partial<AgentProfilesInput> = {}) {
  callLLM.mockResolvedValue({ text: JSON.stringify({ agents }) });
  return generateAgentProfiles(
    {
      stageInfo: { name: 'Intro to Algebra' },
      languageDirective: 'Respond in European Portuguese.',
      availableAvatars: ['/a.png', '/b.png'],
      availableVoices: MINIMAX_VOICES,
      model: fakeModel(),
      ...extra,
    },
    { log: testLogger() },
  );
}

/** voiceDesign instructions, split so a language rule on identity cannot cover texture or delivery. */
function voiceDesignLanguageBlock(prompt: string): {
  intro: string;
  lines: Record<'identity' | 'texture' | 'delivery' | 'gender', string>;
} {
  const start = prompt.indexOf('Each agent needs a "voiceDesign"');
  const block = prompt.slice(start, prompt.indexOf('Return a JSON object', start));
  const intro = block.slice(0, block.indexOf('\n  - "identity"'));
  const lines = {
    identity: '',
    texture: '',
    delivery: '',
    gender: '',
  };
  for (const field of ['identity', 'texture', 'delivery', 'gender'] as const) {
    lines[field] = block.split('\n').find((entry) => entry.includes(`"${field}":`)) ?? '';
  }
  return { intro, lines };
}

function voiceListFromPrompt(): Array<{ name: string; gender?: VoiceGender }> {
  const prompt = callLLM.mock.calls.at(-1)?.[0].prompt as string;
  const marker = 'from this list: ';
  const start = prompt.lastIndexOf(marker);
  const json = prompt.slice(start + marker.length, prompt.indexOf('\n', start));
  return JSON.parse(json);
}

describe('agent profiles — voice gender', () => {
  beforeEach(() => callLLM.mockReset());

  it('advertises MiniMax catalog gender, including Chinese voice names', () => {
    const voices = advertisedVoices(minimaxTarget);
    expect(voices.find((voice) => voice.voiceId === 'female-yujie')).toMatchObject({
      voiceName: '御姐音色',
      voiceLanguage: 'zh-CN',
      gender: 'female',
    });
    expect(voices.find((voice) => voice.voiceId === 'male-qn-jingying')?.gender).toBe('male');
  });

  it('tells the model each known voice gender and to match the agent', async () => {
    await generate([
      profile({ name: 'Lin', role: 'teacher', voice: token('male-qn-jingying') }),
      profile({
        name: 'Sam',
        role: 'student',
        voice: token('female-shaonv'),
        voiceDesign: { identity: 'young male student', texture: 'bright', delivery: 'quick' },
      }),
    ]);

    const prompt = callLLM.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("The voice's gender must match the agent's voiceDesign.gender");
    expect(prompt).toContain("The voice's gender must match the agent's voiceDesign.identity");
    expect(prompt).toContain("Keep the agent's name and persona consistent with that gender");
    expect(prompt).toContain('"gender": "male" | "female"');
    const voiceDesign = voiceDesignLanguageBlock(prompt);
    // The whole descriptor follows the course language. A note on identity alone does not.
    expect(voiceDesign.intro).toContain('written following the language directive');
    for (const field of ['identity', 'texture', 'delivery'] as const) {
      expect(voiceDesign.lines[field]).toContain('in the course language');
    }
    expect(voiceDesign.lines.gender).toContain('language-independent');
    expect(voiceDesign.lines.gender).not.toContain('in the course language');
    const list = voiceListFromPrompt();
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '御姐音色', gender: 'female' }),
        expect.objectContaining({ name: '精英青年', gender: 'male' }),
        expect.objectContaining({ name: 'Expressive Narrator', gender: 'neutral' }),
      ]),
    );
    expect(list.find((voice) => voice.name === '未标注音色')).not.toHaveProperty('gender');
  });

  it('asks for the same match when the teacher voice is already pinned', async () => {
    const agents = [
      profile({ name: 'Lin', role: 'teacher', voice: token('male-qn-jingying') }),
      profile({ name: 'Sam', role: 'student', voice: token('female-shaonv') }),
    ];
    await generate(agents, {
      narratorVoice: { providerId: 'minimax-tts', voiceId: 'female-yujie' },
    });
    const prompt = callLLM.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Keep the agent's name and persona consistent with that gender");
    expect(prompt).toContain("The voice's gender must match the agent's voiceDesign.gender");
  });

  it('keeps a valid opposite-gender voice the model returned', async () => {
    const agents = await generate([
      profile({ name: 'Lin', role: 'teacher', voice: token('male-qn-jingying') }),
      profile({
        name: 'Sam',
        role: 'student',
        voice: token('Chinese (Mandarin)_Gentleman'),
        voiceDesign: {
          identity: 'young female student',
          gender: 'female',
          texture: 'bright',
          delivery: 'quick',
        },
      }),
    ]);

    expect(agents[0].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'male-qn-jingying',
    });
    expect(agents[1].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'Chinese (Mandarin)_Gentleman',
    });
    expect(agents[1].voiceDesign).toMatchObject({
      identity: 'young female student',
      gender: 'female',
    });
  });

  it('leaves a neutral or unlabeled voice as the model chose it', async () => {
    const agents = await generate([
      profile({
        name: 'Lin',
        role: 'teacher',
        voice: token('English_expressive_narrator'),
        voiceDesign: {
          identity: 'middle-aged female teacher',
          gender: 'female',
          texture: 'warm',
          delivery: 'calm',
        },
      }),
      profile({
        name: 'Sam',
        role: 'student',
        voice: token('custom-clone'),
        voiceDesign: {
          identity: 'young male student',
          gender: 'male',
          texture: 'bright',
          delivery: 'quick',
        },
      }),
    ]);

    expect(agents[0].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'English_expressive_narrator',
    });
    expect(agents[1].voiceConfig).toEqual({
      providerId: 'minimax-tts',
      voiceId: 'custom-clone',
    });
  });

  it('leaves a missing or invalid voice unbound', async () => {
    const agents = await generate([
      profile({ name: 'Lin', role: 'teacher' }),
      profile({
        name: 'Sam',
        role: 'student',
        voice: 'minimax-tts::not-a-voice',
        voiceDesign: {
          identity: '年轻女性学生',
          gender: 'female',
          texture: '清亮',
          delivery: '轻快',
        },
      }),
    ]);

    expect(agents[0].voiceConfig).toBeUndefined();
    expect(agents[1].voiceConfig).toBeUndefined();
    expect(agents[1].voiceDesign).toMatchObject({
      identity: '年轻女性学生',
      gender: 'female',
    });
  });

  it('does not add gender-match rules when no voice is male or female', async () => {
    await generate(
      [
        profile({ name: 'Lin', role: 'teacher', voice: 'google-tts::Zephyr' }),
        profile({ name: 'Sam', role: 'student', voice: 'google-tts::Puck' }),
      ],
      {
        availableVoices: [
          {
            providerId: 'google-tts',
            voiceId: 'Zephyr',
            voiceName: 'Zephyr',
            voiceLanguage: 'en-US',
            gender: 'neutral',
          },
          {
            providerId: 'google-tts',
            voiceId: 'Puck',
            voiceName: 'Puck',
            voiceLanguage: 'en-US',
            gender: 'neutral',
          },
        ],
      },
    );
    const prompt = callLLM.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain("The voice's gender must match");
    expect(prompt).not.toContain("Keep the agent's name and persona consistent with that gender");
    expect(voiceListFromPrompt().every((voice) => voice.gender === 'neutral')).toBe(true);
  });
});
