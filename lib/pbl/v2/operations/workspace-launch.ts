import type { PBLProjectV2, PriorQuizResult } from '../types';
import { transitionProjectUiPhase } from './runtime-events';

/** Prepare the project state written by the Hero when the learner starts.
 *
 * The Workspace mounts immediately; its Chat consumes
 * `pendingOpenTaskPriorQuizResults` to start the first `/open-task` stream,
 * then clears that transient payload before the request begins.
 */
export function prepareWorkspaceLaunchProject(
  project: PBLProjectV2,
  priorQuizResults: PriorQuizResult[],
): PBLProjectV2 {
  const next = transitionProjectUiPhase(project, 'workspace');
  if (priorQuizResults.length > 0) {
    next.pendingOpenTaskPriorQuizResults = priorQuizResults;
  } else {
    delete next.pendingOpenTaskPriorQuizResults;
  }
  return next;
}
