import type { CoachPhaseState, CoachState } from './coach-state';

export const COACH_MODEL_ACTIONS = [
  'start_problem',
  'get_state',
  'submit_attempt',
  'request_hint',
  'request_full_solution',
  'submit_transfer_answer',
  'abandon_problem',
] as const;

export type CoachModelAction = (typeof COACH_MODEL_ACTIONS)[number];

export const COACH_DIRECTIVES = [
  'ASK_FOR_ATTEMPT',
  'GENERATE_ONE_HINT',
  'FULL_SOLUTION_LOCKED',
  'FULL_SOLUTION_AVAILABLE',
  'GENERATE_FULL_SOLUTION',
  'GENERATE_TRANSFER_QUESTION',
  'WAIT_FOR_TRANSFER_ANSWER',
  'EVALUATE_TRANSFER_ANSWER',
  'PROJECT_STUDY_ATTEMPTS',
  'COMPLETED',
  'ABANDONED',
] as const;

export type CoachDirective = (typeof COACH_DIRECTIVES)[number];

export function isFullSolutionAvailable(
  state: Pick<CoachPhaseState, 'attemptCount' | 'hintsIssued'>,
): boolean {
  return state.attemptCount >= 2 || (state.attemptCount >= 1 && state.hintsIssued === 3);
}

function canRequestHint(phase: CoachPhaseState): boolean {
  return phase.hintsIssued < 3 && phase.pendingHintRequestEventId === undefined;
}

export function allowedCoachActions(state: CoachState): CoachModelAction[] {
  if (state.status === 'completed' || state.status === 'abandoned') return ['get_state'];
  if (state.original.authoritativeCorrectEvaluationEventId && !state.original.resolved) {
    return ['get_state'];
  }

  const actions: CoachModelAction[] = ['get_state'];
  if (state.transfer.assigned) {
    if (state.transfer.attemptCount > 0) return actions;
    actions.push('submit_transfer_answer');
    if (canRequestHint(state.transfer)) actions.push('request_hint');
    actions.push('abandon_problem');
    return actions;
  }
  if (state.original.resolved || state.original.viewedFullAnswer) {
    actions.push('abandon_problem');
    return actions;
  }

  actions.push('submit_attempt');
  if (canRequestHint(state.original)) actions.push('request_hint');
  actions.push('request_full_solution', 'abandon_problem');
  return actions;
}

export function directiveForCoachState(state: CoachState): CoachDirective {
  if (state.status === 'completed') return 'COMPLETED';
  if (state.status === 'abandoned') return 'ABANDONED';
  if (state.transfer.attemptCount > 0) {
    return state.transfer.evaluationEventId === undefined
      ? 'EVALUATE_TRANSFER_ANSWER'
      : 'PROJECT_STUDY_ATTEMPTS';
  }
  if (state.transfer.assigned) {
    return state.transfer.pendingHintRequestEventId
      ? 'GENERATE_ONE_HINT'
      : 'WAIT_FOR_TRANSFER_ANSWER';
  }
  if (state.original.resolved || state.original.viewedFullAnswer) {
    return 'GENERATE_TRANSFER_QUESTION';
  }
  if (state.original.pendingFullSolutionRequestEventId) return 'GENERATE_FULL_SOLUTION';
  if (state.original.fullSolutionAvailable) return 'FULL_SOLUTION_AVAILABLE';
  if (state.original.pendingHintRequestEventId) return 'GENERATE_ONE_HINT';
  if (state.original.fullSolutionRequestEventIds.length > 0) return 'FULL_SOLUTION_LOCKED';
  return 'ASK_FOR_ATTEMPT';
}
