import { describe, expect, it } from 'vitest';

import {
  buildRevisionGuidanceMessage,
  imageRequiresCaption,
  isSubmitLockedDuringStream,
  taskEvaluationCanAdvance,
} from '@/components/scene-renderers/pbl/v2/submission';
import { isToleratedReactionStreamError } from '@/components/scene-renderers/pbl/v2/use-instructor-stream';
import type { PBLEvaluation } from '@/lib/pbl/v2/types';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';

function taskEval(score: number | undefined, improvements: string[] = []): PBLEvaluation {
  return {
    id: 'eval-1',
    kind: 'task',
    microtaskId: 'mt-1',
    milestoneId: 'ms-1',
    feedback: 'feedback',
    strengths: [],
    improvements,
    score,
    createdAt: '2026-05-29T00:00:00.000Z',
  };
}

describe('PBL v2 — post-submission flow', () => {
  it('uses 60 as the pass threshold for automatic progression', () => {
    expect(taskEvaluationCanAdvance(taskEval(60))).toBe(true);
    expect(taskEvaluationCanAdvance(taskEval(59))).toBe(false);
    expect(taskEvaluationCanAdvance(taskEval(undefined))).toBe(false);
  });

  it('locks submitting while the chat is streaming or the panel is evaluating', () => {
    // Instructor reply / task eval / stage card streaming → locked, so a submit
    // can't interleave with the in-flight response and scramble ordering.
    expect(isSubmitLockedDuringStream({ instructorStreaming: true, evaluating: false })).toBe(true);
    // This panel's own post-submit evaluation running → locked (no double submit).
    expect(isSubmitLockedDuringStream({ instructorStreaming: false, evaluating: true })).toBe(true);
    // Idle → submitting is allowed.
    expect(isSubmitLockedDuringStream({ instructorStreaming: false, evaluating: false })).toBe(
      false,
    );
    // Missing flag (undefined) behaves as not-streaming.
    expect(isSubmitLockedDuringStream({ evaluating: false })).toBe(false);
  });

  it('requires a caption only for an image on a non-vision model', () => {
    // Non-vision model + image with no caption → the model can't see the
    // picture, so a text caption is mandatory before submit.
    expect(imageRequiresCaption({ hasImage: true, hasVision: false, hasCaption: false })).toBe(
      true,
    );
    // A caption satisfies the requirement.
    expect(imageRequiresCaption({ hasImage: true, hasVision: false, hasCaption: true })).toBe(
      false,
    );
    // Vision model can grade the picture itself → no caption required.
    expect(imageRequiresCaption({ hasImage: true, hasVision: true, hasCaption: false })).toBe(
      false,
    );
    // No image at all → never gated by this rule.
    expect(imageRequiresCaption({ hasImage: false, hasVision: false, hasCaption: false })).toBe(
      false,
    );
  });

  it('tolerates a soft EMPTY_LLM_OUTPUT from the post-eval reaction turn, not other errors (#593)', () => {
    const empty: PBLSSEEvent = {
      type: 'error',
      code: 'EMPTY_LLM_OUTPUT',
      message: '导师本轮没有产生新的内容。',
    };
    const llmErr: PBLSSEEvent = { type: 'error', code: 'LLM_ERROR', message: 'boom' };

    // The chained best-effort reaction turn going empty must NOT fail the
    // already-recorded task evaluation — degrade to "no wrap-up".
    expect(isToleratedReactionStreamError('instructor', empty)).toBe(true);

    // A real failure on the reaction stream still aborts.
    expect(isToleratedReactionStreamError('instructor', llmErr)).toBe(false);

    // ANY error on the evaluation streams stays fatal — a silent eval is a real
    // problem, never a tolerable "no wrap-up".
    expect(isToleratedReactionStreamError('eval-task', empty)).toBe(false);
    expect(isToleratedReactionStreamError('eval-milestone', empty)).toBe(false);
    expect(isToleratedReactionStreamError('eval-final', empty)).toBe(false);

    // Non-error frames are never "tolerated errors".
    expect(isToleratedReactionStreamError('instructor', { type: 'done' })).toBe(false);
  });

  it('builds revision guidance without calling the submission failed', () => {
    const message = buildRevisionGuidanceMessage({
      evaluation: taskEval(45, ['补充程序运行结果', '修正输入字段缺失']),
      instructorId: 'role-i',
      microtaskId: 'mt-1',
      language: 'zh-CN',
    });

    expect(message?.content).toContain('先别急着往下走');
    expect(message?.content).toContain('参照上面的任务点评');
    expect(message?.content).not.toContain('不合格');
  });
});
