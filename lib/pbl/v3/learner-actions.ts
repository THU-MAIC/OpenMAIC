import { allowedStudentActions } from './domain/orchestration/transition';
import type { ProjectDefinition, StageDefinition } from './domain/project/project-schema';
import type { PblSessionState } from './domain/orchestration/types';

/** The learning view and Agent guidance expose the same committed transition gates. */
export function learnerActions(input: {
  definition: ProjectDefinition;
  state: PblSessionState;
  stage: StageDefinition;
  evaluation: unknown;
  completionRecorded: boolean;
  buildAvailable: boolean;
}): string[] {
  const { definition, state, stage } = input;
  const actions: string[] =
    state.status === 'completed' ? [] : [...allowedStudentActions(definition, state)];
  if (
    actions.includes('edit') &&
    stage.kind === 'produce' &&
    stage.writes === 'code' &&
    input.buildAvailable
  )
    actions.push('compile');
  const guided = stage.kind === 'produce' || stage.kind === 'mentor_say';
  return input.evaluation || (guided && !input.completionRecorded)
    ? actions.filter((action) => action !== 'next')
    : actions;
}
