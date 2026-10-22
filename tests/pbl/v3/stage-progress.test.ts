import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { hasStageCompletion } from '@/lib/server/pbl-v3/stage-progress';
import { invalidateWorkspace } from '@/lib/server/pbl-v3/runtime';
import {
  allowedStudentActions,
  startOrchestration,
} from '@/lib/pbl/v3/domain/orchestration/transition';
import type { Study } from '@/lib/server/pbl-v3/store';

const project = installedProject({ id: 'greeting-python', version: '1.0.0' }).definition;
function completed(index: number) {
  const state = startOrchestration(project).state;
  state.position.stageIndex = index;
  const collected = state.collected.greeting!;
  collected.teachingCompleted =
    collected.planReviewCompleted =
    collected.codeReviewCompleted =
    collected.recapCompleted =
      true;
  collected.plan = {
    id: 'plan',
    kind: 'plan',
    milestoneId: 'greeting',
    revision: 1,
    contentHash: 'plan-hash',
    workspaceRevisionId: 'files',
  };
  collected.code = {
    id: 'code',
    kind: 'code',
    milestoneId: 'greeting',
    revision: 1,
    value: 'Reviewed source',
    workspaceRevisionId: 'files',
  };
  const key = `greeting:${index}`;
  return {
    row: { state } as Study,
    stage: project.milestones[0]!.stages[index]!,
    binding: { stage_key: key, completion: { stageKey: key, feedbackSeq: 3, userMessageSeq: 12 } },
  };
}

describe('stage completion lifetime', () => {
  it.each([0, 2, 3, 6])('keeps step %s complete until its actual evidence changes', (index) => {
    const { row, stage, binding } = completed(index);
    expect(hasStageCompletion(row, stage, binding)).toBe(true);
    expect(hasStageCompletion(row, stage, undefined)).toBe(false);
    expect(hasStageCompletion(row, stage, { ...binding, stage_key: 'another:0' })).toBe(false);
    expect(hasStageCompletion(row, stage, { ...binding, completion: null })).toBe(false);
  });
  it.each([2, 3, 6])('invalidates step %s after a real workspace change', (index) => {
    const { row, stage, binding } = completed(index);
    row.state = invalidateWorkspace(row, index === 2 ? 'PLAN.md' : 'greeting.py').state;
    expect(hasStageCompletion(row, stage, binding)).toBe(false);
  });
  it('does not carry a previous stage receipt into a new stage', () => {
    const { row, stage, binding } = completed(0);
    row.state.position.stageIndex = 6;
    expect(hasStageCompletion(row, stage, binding)).toBe(false);
  });
  it('offers decision progression only after every required decision is submitted', () => {
    const { row } = completed(1);
    expect(allowedStudentActions(project, row.state)).not.toContain('next');
    row.state.collected.greeting!.decisions = [{ id: 'format', chosen: 'format', revision: 0 }];
    expect(allowedStudentActions(project, row.state)).toContain('next');
  });
});
