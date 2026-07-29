import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

/**
 * #669 / #1003: the PBL v2 teaching turns must reach the model through
 * `streamLLM` with thinking force-disabled.
 *
 * The original test asserted the mechanism — a `withThinkingDisabled` helper
 * that seeded the thinking AsyncLocalStorage by hand. That helper is gone: the
 * agents now go through the shared entry point, which seeds the store itself.
 * So this asserts the two things the call site is actually responsible for, at
 * the provider boundary where a regression would bite:
 *
 *   1. the store reads a disabled config by the time the provider is invoked
 *      (the OpenAI-compatible fetch wrapper reads exactly this), and
 *   2. the turn is accounted for — going through the wrapper is what makes the
 *      call visible to usage recording at all.
 *
 * Both break silently if someone drops the arguments at the call site, which is
 * how the direct-SDK drift in #1003 went unnoticed for so long.
 */
const usageMock = vi.hoisted(() => ({
  normalizeUsage: vi.fn((usage: unknown) => usage),
  recordUsage: vi.fn(async () => undefined),
}));

vi.mock('@/lib/usage/normalize', () => ({
  normalizeUsage: usageMock.normalizeUsage,
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordUsage: usageMock.recordUsage,
}));

import { thinkingContext } from '@/lib/ai/thinking-context';
import { PBL_V2_TEACHING_THINKING } from '@/lib/pbl/v2/agents/runtime-thinking';
import { runTaskEvaluation } from '@/lib/pbl/v2/agents/evaluator';
import { addSubmission } from '@/lib/pbl/v2/operations/submission';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';

type DoStreamConfig = NonNullable<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']
>;
type StreamResult = Extract<DoStreamConfig, { stream: unknown }>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

function textStep(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'p1' },
    { type: 'text-delta', id: 'p1', delta: text },
    { type: 'text-end', id: 'p1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
  ];
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

/** Run one task evaluation against a scripted model, capturing what the
 *  provider saw in the thinking store at the moment it was invoked. */
async function runEvaluationCapturingThinking(): Promise<{ seenThinking: unknown }> {
  const project = mkProject();
  addSubmission(project, {
    microtaskId: 't1',
    milestoneId: 'ms1',
    kind: 'text',
    content: 'submission',
  });

  const NOT_CAPTURED = Symbol('provider was never invoked');
  let seenThinking: unknown = NOT_CAPTURED;

  const model = new MockLanguageModelV3({
    doStream: async () => {
      seenThinking = thinkingContext.getStore();
      return {
        stream: convertArrayToReadableStream(textStep('{"feedback":"ok","score":80}')),
      };
    },
  });

  const events: PBLSSEEvent[] = [];
  for await (const ev of runTaskEvaluation({
    project,
    milestoneId: 'ms1',
    microtaskId: 't1',
    languageModel: model,
  })) {
    events.push(ev);
  }

  // Guard the guard: an evaluation that errored out before calling the model
  // would make every assertion below vacuous.
  expect(seenThinking).not.toBe(NOT_CAPTURED);
  expect(events.at(-1)?.type).toBe('done');
  return { seenThinking };
}

describe('PBL v2 teaching-turn thinking policy (#669, #1003)', () => {
  beforeEach(() => {
    usageMock.normalizeUsage.mockClear();
    usageMock.recordUsage.mockClear();
  });

  it('is a disabled thinking config', () => {
    expect(PBL_V2_TEACHING_THINKING).toEqual({ mode: 'disabled', enabled: false });
  });

  it('reaches the provider as a disabled config on an evaluator turn', async () => {
    const { seenThinking } = await runEvaluationCapturingThinking();
    expect(seenThinking).toEqual(PBL_V2_TEACHING_THINKING);
  });

  it('does not leak the disabled config past the turn', async () => {
    await runEvaluationCapturingThinking();
    expect(thinkingContext.getStore()).toBeUndefined();
  });

  it('accounts for the turn under its own usage source', async () => {
    await runEvaluationCapturingThinking();
    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'llm', source: 'pbl-v2-evaluator-task' }),
      );
    });
  });
});
