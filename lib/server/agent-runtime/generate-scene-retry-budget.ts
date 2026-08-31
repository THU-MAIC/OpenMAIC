import type {
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core';

export const GENERATE_SCENE_MAX_CONSECUTIVE_FAILURES = 2;

interface GenerateSceneTarget {
  stageId: string;
  order: number;
}

interface GenerateSceneRetryState {
  target: GenerateSceneTarget;
  failedAttempts: number;
  maxFailedAttempts: number;
  attemptsRemaining: number;
  exhausted: boolean;
}

function generateSceneTarget(args: unknown): GenerateSceneTarget | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const { stageId, order } = args as { stageId?: unknown; order?: unknown };
  if (typeof stageId !== 'string' || stageId.length === 0) return null;
  if (!Number.isInteger(order) || (order as number) < 1) return null;
  return { stageId, order: order as number };
}

function sameTarget(left: GenerateSceneTarget | null, right: GenerateSceneTarget): boolean {
  return left?.stageId === right.stageId && left.order === right.order;
}

function retryGuidance(state: GenerateSceneRetryState): string {
  const target = `stageId=${JSON.stringify(state.target.stageId)}, order=${state.target.order}`;
  if (!state.exhausted) {
    return `Recovery policy: one retry remains for generate_scene target ${target}.`;
  }
  return `Recovery policy: retry budget exhausted for generate_scene target ${target}. Do not call generate_scene for this target again in this run. Leave completed pages intact, continue with later pages when possible, and include this target in the final rework list.`;
}

function withRetryState(details: unknown, state: GenerateSceneRetryState): Record<string, unknown> {
  const existing =
    details && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : details === undefined
        ? {}
        : { originalDetails: details };
  return { ...existing, generateSceneRetry: state };
}

/**
 * Bound consecutive `generate_scene` failures for one semantic page target.
 *
 * The first attempt and one retry may execute. A second failure tells the
 * model to move on, and any further consecutive call for the same stage/order
 * is blocked before it can reach a generation provider. A successful call or
 * a call for another page starts a fresh budget.
 */
export function createGenerateSceneRetryBudget(): {
  beforeToolCall(context: BeforeToolCallContext): BeforeToolCallResult | undefined;
  afterToolCall(context: AfterToolCallContext): AfterToolCallResult | undefined;
} {
  let activeTarget: GenerateSceneTarget | null = null;
  let failedAttempts = 0;

  const selectTarget = (target: GenerateSceneTarget): void => {
    if (sameTarget(activeTarget, target)) return;
    activeTarget = target;
    failedAttempts = 0;
  };

  const stateFor = (target: GenerateSceneTarget): GenerateSceneRetryState => ({
    target,
    failedAttempts,
    maxFailedAttempts: GENERATE_SCENE_MAX_CONSECUTIVE_FAILURES,
    attemptsRemaining: Math.max(0, GENERATE_SCENE_MAX_CONSECUTIVE_FAILURES - failedAttempts),
    exhausted: failedAttempts >= GENERATE_SCENE_MAX_CONSECUTIVE_FAILURES,
  });

  return {
    beforeToolCall(context) {
      if (context.toolCall.name !== 'generate_scene') return undefined;
      const target = generateSceneTarget(context.args);
      if (!target) return undefined;
      selectTarget(target);
      const state = stateFor(target);
      return state.exhausted ? { block: true, reason: retryGuidance(state) } : undefined;
    },
    afterToolCall(context) {
      if (context.toolCall.name !== 'generate_scene') return undefined;
      const target = generateSceneTarget(context.args);
      if (!target) return undefined;
      selectTarget(target);
      if (!context.isError) {
        activeTarget = null;
        failedAttempts = 0;
        return undefined;
      }

      failedAttempts += 1;
      const state = stateFor(target);
      return {
        content: [...context.result.content, { type: 'text', text: retryGuidance(state) }],
        details: withRetryState(context.result.details, state),
        isError: true,
      };
    },
  };
}
