/**
 * Tests for the evaluator agent.
 *
 * Strategy mirrors planner.test.ts in PR 2: full LLM streaming
 * (MockLanguageModelV3) is deferred to PR 8. PR 6.2 covers what we
 * can test without the LLM:
 *
 *   1. Public API surface (the entry points the route imports).
 *   2. Error paths when the project / milestone / microtask isn't
 *      found — the generator must yield an error + done, NOT throw.
 *
 * The persistence logic (`persistEvaluation` inside evaluator.ts) is
 * already covered indirectly by the eval-tail-parser + eval-prompts
 * tests in 6.1 — those exercise every normalize / build path. A
 * dedicated wiring-with-fake-stream test will land in 6.7 once we
 * write a small MockLanguageModelV3 helper for both Instructor and
 * Evaluator together.
 */
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import {
  runFinalEvaluation,
  runMilestoneEvaluation,
  runTaskEvaluation,
} from '@/lib/pbl/v2/agents/evaluator';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { addSubmission } from '@/lib/pbl/v2/operations/submission';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';

type DoStreamConfig = NonNullable<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']
>;
type StreamResult = Extract<DoStreamConfig, { stream: unknown }>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const FINISH_STOP = {
  type: 'finish' as const,
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: USAGE,
};

function textStep(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'p1' },
    { type: 'text-delta', id: 'p1', delta: text },
    { type: 'text-end', id: 'p1' },
    FINISH_STOP,
  ];
}

function scriptedModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(textStep(text)) }),
  });
}

async function collectEvents(gen: AsyncGenerator<PBLSSEEvent, void, void>): Promise<PBLSSEEvent[]> {
  const events: PBLSSEEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function evaluationPatch(events: PBLSSEEvent[]) {
  return events.find(
    (ev): ev is Extract<PBLSSEEvent, { type: 'project_patch' }> =>
      ev.type === 'project_patch' && ev.patch.kind === 'evaluation',
  )?.patch;
}

function mkProject(): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 't',
    description: 'd',
    proficiency: 'intermediate',
    language: 'zh-CN',
    tags: [],
    status: 'active',
    roles: [],
    milestones: [
      {
        id: 'ms1',
        title: 'M1',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 't1',
            title: 'T1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
        documents: [],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: 'ts',
    updatedAt: 'ts',
  };
}

describe('Evaluator agent — public API surface', () => {
  it('exports three async-generator entry points', () => {
    expect(typeof runTaskEvaluation).toBe('function');
    expect(typeof runMilestoneEvaluation).toBe('function');
    expect(typeof runFinalEvaluation).toBe('function');
  });
});

describe('Evaluator agent — error paths (no LLM needed)', () => {
  it('runTaskEvaluation yields NOT_FOUND when milestone is missing', async () => {
    const gen = runTaskEvaluation({
      project: mkProject(),
      milestoneId: 'does-not-exist',
      microtaskId: 't1',
      languageModel: undefined as never,
    });
    const events: { type: string; code?: string }[] = [];
    for await (const ev of gen) {
      events.push(ev as { type: string; code?: string });
      if (ev.type === 'done') break;
    }
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { code?: string }).code).toBe('NOT_FOUND');
    expect(events[events.length - 1]?.type).toBe('done');
  });

  it('runTaskEvaluation yields NOT_FOUND when microtask is missing', async () => {
    const gen = runTaskEvaluation({
      project: mkProject(),
      milestoneId: 'ms1',
      microtaskId: 'nope',
      languageModel: undefined as never,
    });
    const events: { type: string; code?: string }[] = [];
    for await (const ev of gen) {
      events.push(ev as { type: string; code?: string });
      if (ev.type === 'done') break;
    }
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { code?: string }).code).toBe('NOT_FOUND');
  });

  it('runMilestoneEvaluation yields NOT_FOUND when milestone is missing', async () => {
    const gen = runMilestoneEvaluation({
      project: mkProject(),
      milestoneId: 'nope',
      languageModel: undefined as never,
    });
    const events: { type: string; code?: string }[] = [];
    for await (const ev of gen) {
      events.push(ev as { type: string; code?: string });
      if (ev.type === 'done') break;
    }
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { code?: string }).code).toBe('NOT_FOUND');
  });
});

describe('Evaluator agent — task JSON-only output', () => {
  it('persists task feedback from JSON and does not stream raw JSON tokens', async () => {
    const project = mkProject();
    addSubmission(project, {
      microtaskId: 't1',
      milestoneId: 'ms1',
      kind: 'text',
      content: 'System.out.println(map.get("apple"));',
    });
    const model = scriptedModel(
      '{"feedback":"这次提交展示了 HashMap 查询输出，已经达到继续要求。","strengths":["能用 key 查询值"],"improvements":["补充不存在 key 的样例"],"score":76}',
    );

    const events = await collectEvents(
      runTaskEvaluation({
        project,
        milestoneId: 'ms1',
        microtaskId: 't1',
        languageModel: model,
      }),
    );

    expect(events.some((ev) => ev.type === 'token')).toBe(false);
    const patch = evaluationPatch(events);
    expect(patch?.kind).toBe('evaluation');
    if (patch?.kind !== 'evaluation') throw new Error('missing evaluation patch');
    expect(patch.evaluation.feedback).toBe('这次提交展示了 HashMap 查询输出，已经达到继续要求。');
    expect(patch.evaluation.strengths).toEqual(['能用 key 查询值']);
    expect(patch.evaluation.improvements).toEqual(['补充不存在 key 的样例']);
    expect(patch.evaluation.score).toBe(76);
  });
});

describe('Evaluator agent — milestone/final JSON-only output', () => {
  it('persists milestone feedback from JSON and does not stream raw JSON tokens', async () => {
    const project = mkProject();
    const model = scriptedModel(
      '{"feedback":"这一阶段你完成了 HashMap 查询的核心练习，也能解释 key 如何找到对应值。点击 Continue 后再进入下一阶段。","learned":["用 key 查询对应值","用输出验证查询结果"],"performance":"你能把查询结果和任务目标对应起来。","stars":4.5}',
    );

    const events = await collectEvents(
      runMilestoneEvaluation({
        project,
        milestoneId: 'ms1',
        languageModel: model,
      }),
    );

    expect(events.some((ev) => ev.type === 'token')).toBe(false);
    const patch = evaluationPatch(events);
    expect(patch?.kind).toBe('evaluation');
    if (patch?.kind !== 'evaluation') throw new Error('missing evaluation patch');
    expect(patch.evaluation.feedback).toContain('这一阶段你完成了 HashMap 查询');
    expect(patch.evaluation.strengths).toEqual(['用 key 查询对应值', '用输出验证查询结果']);
    expect(patch.evaluation.improvements).toEqual(['你能把查询结果和任务目标对应起来。']);
    expect(patch.evaluation.stars).toBe(4.5);
  });

  it('persists final report feedback from JSON and does not stream raw JSON tokens', async () => {
    const project = mkProject();
    const model = scriptedModel(
      '{"feedback":"你完成了 HashMap Playground，并把查询过程做成了可验证的小工具。整合检查里你把 key 到值的关系说清楚了，这是很好的收束。","stars":4.5,"what_you_built":["HashMap 查询小工具"],"what_you_learned":["用 key 找到对应值"],"whats_next":"下一步可以加入新增和删除键值对的功能。"}',
    );

    const events = await collectEvents(
      runFinalEvaluation({
        project,
        languageModel: model,
      }),
    );

    expect(events.some((ev) => ev.type === 'token')).toBe(false);
    const patch = evaluationPatch(events);
    expect(patch?.kind).toBe('evaluation');
    if (patch?.kind !== 'evaluation') throw new Error('missing evaluation patch');
    expect(patch.evaluation.feedback).toContain('你完成了 HashMap Playground');
    expect(patch.evaluation.whatYouBuilt).toEqual(['HashMap 查询小工具']);
    expect(patch.evaluation.whatYouLearned).toEqual(['用 key 找到对应值']);
    expect(patch.evaluation.whatsNext).toBe('下一步可以加入新增和删除键值对的功能。');
    expect(patch.evaluation.stars).toBe(4.5);
  });
});
