import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

/**
 * #1003: the PBL v2 runtime reaches the model only through the shared entry
 * point, and holds no thinking opinion of its own.
 *
 * The runtime used to force thinking off on the teaching turns through a
 * hand-rolled helper that seeded the thinking AsyncLocalStorage directly — which
 * is also why those turns called the AI SDK directly. Both are gone: the agents
 * call `streamLLM` / `callLLM`, and what the request / stage route asked for is
 * what the provider sees.
 *
 * Asserted at the provider boundary, where a regression would actually bite:
 *
 *   1. an incoming thinking config arrives intact,
 *   2. NO config means NO config — nothing in the runtime substitutes one, which
 *      is the property a re-added policy constant would silently break,
 *   3. the global kill switch still applies,
 *   4. the turn is accounted for; going through the wrapper is what makes the
 *      call visible to usage recording at all.
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
import { runTaskEvaluation } from '@/lib/pbl/v2/agents/evaluator';
import { addSubmission } from '@/lib/pbl/v2/operations/submission';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';
import type { ThinkingConfig } from '@/lib/types/provider';

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

const NOT_CAPTURED = Symbol('provider was never invoked');

/** Run one task evaluation against a scripted model, capturing what the
 *  provider saw in the thinking store at the moment it was invoked. */
async function runEvaluation(thinkingConfig?: ThinkingConfig): Promise<{ seenThinking: unknown }> {
  const project = mkProject();
  addSubmission(project, {
    microtaskId: 't1',
    milestoneId: 'ms1',
    kind: 'text',
    content: 'submission',
  });

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
    ...(thinkingConfig ? { thinkingConfig } : {}),
  })) {
    events.push(ev);
  }

  // Guard the guard: an evaluation that errored out before calling the model
  // would make every assertion below vacuous.
  expect(seenThinking).not.toBe(NOT_CAPTURED);
  expect(events.at(-1)?.type).toBe('done');
  return { seenThinking };
}

describe('PBL v2 runtime goes through the shared LLM entry point (#1003)', () => {
  beforeEach(() => {
    usageMock.normalizeUsage.mockClear();
    usageMock.recordUsage.mockClear();
    delete process.env.LLM_THINKING_DISABLED;
  });

  it('passes an incoming thinking config through to the provider unchanged', async () => {
    const thinkingConfig: ThinkingConfig = { mode: 'enabled', effort: 'low' };
    const { seenThinking } = await runEvaluation(thinkingConfig);
    expect(seenThinking).toEqual(thinkingConfig);
  });

  it('substitutes nothing when the request carries no thinking config', async () => {
    // The runtime holds no policy of its own. A re-added hardcoded constant
    // would show up right here as a config the caller never asked for.
    const { seenThinking } = await runEvaluation();
    expect(seenThinking).toBeUndefined();
  });

  it('still honours the global kill switch when no config is supplied', async () => {
    process.env.LLM_THINKING_DISABLED = 'true';
    try {
      const { seenThinking } = await runEvaluation();
      expect(seenThinking).toEqual({ mode: 'disabled', enabled: false });
    } finally {
      delete process.env.LLM_THINKING_DISABLED;
    }
  });

  it('does not leak the config past the turn', async () => {
    await runEvaluation({ mode: 'enabled', effort: 'low' });
    expect(thinkingContext.getStore()).toBeUndefined();
  });

  it('accounts for the turn under its own usage source', async () => {
    await runEvaluation();
    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'llm', source: 'pbl-v2-evaluator-task' }),
      );
    });
  });
});
