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
  /** Host-driven teaching: the exit is earned when the opening became visible. */
  teachingExit?: boolean;
}): string[] {
  const { definition, state, stage } = input;
  const actions: string[] =
    state.status === 'completed'
      ? []
      : [...allowedStudentActions(definition, state, input.teachingExit)];
  if (
    actions.includes('edit') &&
    stage.kind === 'produce' &&
    stage.writes === 'code' &&
    input.buildAvailable
  )
    actions.push('compile');
  const guided = stage.kind === 'produce' || stage.kind === 'mentor_say';
  const completed = input.teachingExit ?? input.completionRecorded;
  return input.evaluation || (guided && !completed)
    ? actions.filter((action) => action !== 'next')
    : actions;
}
