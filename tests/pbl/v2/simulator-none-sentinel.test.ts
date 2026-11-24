/**
 * #2400 — the director-narrator sentinel must survive light Markdown, and an
 * empty character turn must not ship a hard-coded Chinese notice.
 */
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

import { isNoneSentinel, runSimulatorTurn } from '@/lib/pbl/v2/agents/simulator';
import type { PBLProjectV2, PBLMilestone, PBLMicrotask } from '@/lib/pbl/v2/types';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function model(narration: string, characterText = '你来了。'): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: narration }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: USAGE,
      warnings: [],
    }),
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start' as const, warnings: [] },
        ...(characterText
          ? [
              { type: 'text-start' as const, id: 't1' },
              { type: 'text-delta' as const, id: 't1', delta: characterText },
              { type: 'text-end' as const, id: 't1' },
            ]
          : []),
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: USAGE,
        },
      ]),
    }),
  });
}

function roleplayMilestone(): PBLMilestone {
  return {
    id: 'ms-rp',
    title: '和林夏聊一聊',
    status: 'active',
    order: 1,
    documents: [],
    scenarioStage: 'roleplay',
    briefing: '你坐在咖啡馆里，林夏刚到。',
    microtasks: [
      {
        id: 'beat-1',
        title: 'beat',
        status: 'in_progress',
        assignee: 'user',
        hints: [],
        order: 0,
        description: '林夏坐在你对面，刚点了一杯热可可，眼睛有点红。',
      } as unknown as PBLMicrotask,
    ],
  } as unknown as PBLMilestone;
}

function scenarioProject(): PBLProjectV2 {
  return {
    language: 'zh-CN',
    roles: [{ id: 'role-i', type: 'instructor', name: '教练' }],
    threads: [{ agentId: 'role-i', messages: [] }],
    scenario: {
      setting: '校园咖啡馆的午后',
      goal: '练习倾听与共情',
      rules: '保持真诚，不评判',
      learnerRole: '你是林夏的好朋友',
      characters: [
        {
          id: 'c1',
          name: '林夏',
          persona: '内向，说话轻声细语',
          situation: '这周失恋，情绪低落',
          boundaries: '不会突然崩溃大哭',
        },
      ],
    },
    milestones: [
      {
        id: 'ms-prep',
        title: '准备',
        status: 'completed',
        order: 0,
        documents: [],
        scenarioStage: 'prep',
        microtasks: [],
      },
      roleplayMilestone(),
      {
        id: 'ms-wrap',
        title: '收尾',
        status: 'locked',
        order: 2,
        documents: [],
        scenarioStage: 'wrapup',
        microtasks: [],
      },
    ],
    evaluations: [],
    engagementEvents: [],
  } as unknown as PBLProjectV2;
}

async function collect(gen: AsyncGenerator<PBLSSEEvent>): Promise<PBLSSEEvent[]> {
  const out: PBLSSEEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function systemBubbles(events: PBLSSEEvent[]) {
  return events.filter(
    (e) =>
      e.type === 'project_patch' &&
      e.patch.kind === 'message' &&
      (e.patch.message as { roleType?: string }).roleType === 'system',
  );
}

describe('isNoneSentinel — swallowed NONE forms', () => {
  it.each([
    'NONE',
    'none',
    'NONE.',
    'NONE。',
    'NONE!',
    '  NONE  ',
    '`NONE`',
    '**NONE**',
    '*NONE*',
    '_NONE_',
    '"NONE"',
    "'NONE'",
    '“NONE”',
    '‘NONE’',
    '`none`',
    '`NONE.`',
    '**`NONE`**',
    '"NONE".',
    '**NONE**。',
    '`NONE`!',
    '«NONE»',
  ])('treats %j as the sentinel', (text) => {
    expect(isNoneSentinel(text)).toBe(true);
  });

  it.each([
    'NONE of them moved.',
    '`NONE` — then she looked up.',
    'The room was silent. NONE of the cards were dealt.',
    '她没有说话，只是摇了摇头。',
    '**NONE** 然后她起身离开。',
  ])('does NOT swallow real narration %j', (text) => {
    expect(isNoneSentinel(text)).toBe(false);
  });
});

describe('runSimulatorTurn — sentinel produces no bubble', () => {
  it.each(['`NONE`', '**NONE**', '"NONE"'])(
    'a narrator reply of %j yields no system bubble',
    async (narration) => {
      const events = await collect(
        runSimulatorTurn({
          project: scenarioProject(),
          userMessage: '',
          phase: 'greeting',
          languageModel: model(narration),
        }),
      );
      expect(systemBubbles(events)).toHaveLength(0);
    },
  );

  it('still renders real narration as a system bubble', async () => {
    const events = await collect(
      runSimulatorTurn({
        project: scenarioProject(),
        userMessage: '',
        phase: 'greeting',
        languageModel: model('雨点落在窗玻璃上，林夏把杯子往手边挪了挪。'),
      }),
    );
    expect(systemBubbles(events)).toHaveLength(1);
  });
});

describe('runSimulatorTurn — empty character turn notice', () => {
  it('emits EMPTY_LLM_OUTPUT with a locale-neutral message (no CJK)', async () => {
    const events = await collect(
      runSimulatorTurn({
        project: scenarioProject(),
        userMessage: '',
        phase: 'greeting',
        languageModel: model('`NONE`', ''),
      }),
    );
    const err = events.find((e) => e.type === 'error') as
      | { type: 'error'; code: string; message: string }
      | undefined;
    expect(err?.code).toBe('EMPTY_LLM_OUTPUT');
    expect(err?.message ?? '').not.toMatch(/[一-鿿]/);
  });
});
