import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { projectEditAccess } from '@/lib/pbl/v3/edit-access';
import {
  allowedStudentActions,
  startOrchestration,
} from '@/lib/pbl/v3/domain/orchestration/transition';
const definition = installedProject({ id: 'greeting-python', version: '1.0.0' }).definition;
function context(index: number, repair = false) {
  const state = startOrchestration(definition).state;
  state.position.stageIndex = index;
  if (repair)
    state.collected.greeting!.remediation = {
      id: 'repair',
      kind: 'implementation_repair',
      target: 'coder',
      reason: 'tests',
      attempt: 1,
      evaluationId: 'failed',
    };
  return {
    state,
    stage: definition.milestones[0]!.stages[index]!,
    actions: allowedStudentActions(definition, state),
    busy: false,
    evaluation: null,
  };
}
describe('OpenPBL editing boundaries', () => {
  it.each([
    [0, 'teaching'],
    [1, 'discussion'],
    [4, 'assessment'],
    [5, 'quiz'],
    [6, 'recap'],
  ] as const)('keeps step %i read-only with its own reason', (index, reason) => {
    expect(projectEditAccess(context(index), 'greeting.py')).toMatchObject({
      canEdit: false,
      reason,
    });
  });
  it('allows only PLAN.md in planning and only source files in coding', () => {
    expect(projectEditAccess(context(2), 'PLAN.md').canEdit).toBe(true);
    expect(projectEditAccess(context(2), 'greeting.py').reason).toBe('planOnly');
    expect(projectEditAccess(context(3), 'greeting.py').canEdit).toBe(true);
    expect(projectEditAccess(context(3), 'PLAN.md').reason).toBe('planLocked');
  });
  it('opens failed-test code repair in the same test step, but locks it during tests and Agent activity', () => {
    const repair = context(4, true);
    expect(projectEditAccess(repair, 'greeting.py').canEdit).toBe(true);
    expect(repair.stage.kind).toBe('check');
    expect(projectEditAccess({ ...repair, busy: true }, 'greeting.py').reason).toBe('agent');
    expect(projectEditAccess({ ...repair, evaluation: {} }, 'greeting.py').reason).toBe('testing');
    expect(
      projectEditAccess({ ...context(3), evaluation: { purpose: 'compile' } }, 'greeting.py')
        .reason,
    ).toBe('building');
    expect(
      projectEditAccess(
        { ...repair, state: { ...repair.state, status: 'completed' } },
        'greeting.py',
      ).reason,
    ).toBe('completed');
  });
});
