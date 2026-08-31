import type { AfterToolCallContext, BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';

import {
  createGenerateSceneRetryBudget,
  GENERATE_SCENE_MAX_CONSECUTIVE_FAILURES,
} from '@/lib/server/agent-runtime/generate-scene-retry-budget';

type RetryBudget = ReturnType<typeof createGenerateSceneRetryBudget>;

const TARGET_A = { stageId: 'stage-a', order: 3 };
const TARGET_B = { stageId: 'stage-a', order: 4 };

function before(budget: RetryBudget, toolName: string, args: unknown) {
  return budget.beforeToolCall({ toolCall: { name: toolName }, args } as BeforeToolCallContext);
}

function after(
  budget: RetryBudget,
  toolName: string,
  args: unknown,
  isError: boolean,
  details: unknown = { source: 'generation' },
) {
  return budget.afterToolCall({
    toolCall: { name: toolName },
    args,
    isError,
    result: {
      content: [{ type: 'text', text: isError ? 'generation failed' : 'generated' }],
      details,
    },
  } as AfterToolCallContext);
}

describe('generate_scene retry budget', () => {
  it('allows one real retry, then blocks the same page before a third execution', () => {
    const budget = createGenerateSceneRetryBudget();

    expect(before(budget, 'generate_scene', TARGET_A)).toBeUndefined();
    const firstFailure = after(budget, 'generate_scene', TARGET_A, true, {
      providerError: 'empty response',
    });
    expect(firstFailure).toMatchObject({
      isError: true,
      details: {
        providerError: 'empty response',
        generateSceneRetry: {
          target: TARGET_A,
          failedAttempts: 1,
          maxFailedAttempts: GENERATE_SCENE_MAX_CONSECUTIVE_FAILURES,
          attemptsRemaining: 1,
          exhausted: false,
        },
      },
    });
    expect(JSON.stringify(firstFailure?.content)).toContain('one retry remains');

    expect(before(budget, 'generate_scene', TARGET_A)).toBeUndefined();
    const secondFailure = after(budget, 'generate_scene', TARGET_A, true);
    expect(secondFailure).toMatchObject({
      isError: true,
      details: {
        generateSceneRetry: {
          failedAttempts: 2,
          attemptsRemaining: 0,
          exhausted: true,
        },
      },
    });
    expect(JSON.stringify(secondFailure?.content)).toContain('retry budget exhausted');
    expect(JSON.stringify(secondFailure?.content)).toContain('final rework list');

    const blocked = before(budget, 'generate_scene', TARGET_A);
    expect(blocked).toMatchObject({ block: true });
    expect(blocked?.reason).toContain('retry budget exhausted');
    expect(blocked?.reason).toContain('order=3');
  });

  it('does not consume or reset a page budget for unrelated tool calls', () => {
    const budget = createGenerateSceneRetryBudget();

    before(budget, 'generate_scene', TARGET_A);
    after(budget, 'generate_scene', TARGET_A, true);
    expect(before(budget, 'list_scenes', { stageId: TARGET_A.stageId })).toBeUndefined();
    expect(after(budget, 'list_scenes', { stageId: TARGET_A.stageId }, false)).toBeUndefined();
    expect(before(budget, 'generate_scene', TARGET_A)).toBeUndefined();
    after(budget, 'generate_scene', TARGET_A, true);
    expect(before(budget, 'read_stage', TARGET_A)).toBeUndefined();
    expect(before(budget, 'generate_scene', TARGET_A)).toMatchObject({ block: true });
  });

  it('starts a fresh budget after a successful generation', () => {
    const budget = createGenerateSceneRetryBudget();

    before(budget, 'generate_scene', TARGET_A);
    after(budget, 'generate_scene', TARGET_A, true);
    before(budget, 'generate_scene', TARGET_A);
    expect(after(budget, 'generate_scene', TARGET_A, false)).toBeUndefined();

    expect(before(budget, 'generate_scene', TARGET_A)).toBeUndefined();
    const nextFailure = after(budget, 'generate_scene', TARGET_A, true);
    expect(nextFailure?.details).toMatchObject({
      generateSceneRetry: { failedAttempts: 1, attemptsRemaining: 1, exhausted: false },
    });
  });

  it('starts a fresh budget when generation moves to another page target', () => {
    const budget = createGenerateSceneRetryBudget();

    before(budget, 'generate_scene', TARGET_A);
    after(budget, 'generate_scene', TARGET_A, true);
    before(budget, 'generate_scene', TARGET_A);
    after(budget, 'generate_scene', TARGET_A, true);
    expect(before(budget, 'generate_scene', TARGET_A)).toMatchObject({ block: true });

    expect(before(budget, 'generate_scene', TARGET_B)).toBeUndefined();
    const firstFailureForB = after(budget, 'generate_scene', TARGET_B, true);
    expect(firstFailureForB?.details).toMatchObject({
      generateSceneRetry: { target: TARGET_B, failedAttempts: 1, attemptsRemaining: 1 },
    });

    expect(before(budget, 'generate_scene', TARGET_A)).toBeUndefined();
  });
});
