import { describe, expect, it } from 'vitest';

import {
  milestoneHandoverCtaState,
  stripFinalMilestoneContinueGuidance,
} from '@/components/scene-renderers/pbl/v2/eval-cards/milestone-card';
import type { PBLHandover } from '@/lib/pbl/v2/types';

function handover(consumed: boolean): PBLHandover {
  return {
    completedMilestoneId: 'ms-1',
    completedMilestoneTitle: 'Stage 1',
    nextMilestoneId: 'ms-2',
    nextMilestoneTitle: 'Stage 2',
    nextTaskId: 'mt-2',
    nextTaskTitle: 'Task 2',
    consumed,
  };
}

describe('PBL v2 milestone card handover CTA', () => {
  it('uses a ready CTA before the learner continues', () => {
    expect(milestoneHandoverCtaState(handover(false))).toBe('ready');
  });

  it('keeps a consumed CTA state after the learner enters the next stage', () => {
    expect(milestoneHandoverCtaState(handover(true))).toBe('consumed');
  });

  it('hides the handover CTA for the final milestone', () => {
    expect(milestoneHandoverCtaState(undefined)).toBe('hidden');
  });

  it('removes Continue guidance from the final milestone narrative only', () => {
    expect(
      stripFinalMilestoneContinueGuidance(
        '这一阶段完成了。点击 Continue 继续往前走吧。你已经可以查看项目总评了。',
      ),
    ).toBe('这一阶段完成了。你已经可以查看项目总评了。');
  });
});
