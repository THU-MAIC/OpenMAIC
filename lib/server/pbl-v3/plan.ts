import 'server-only';
import { sandboxConflict } from '@/lib/sandbox/errors';
import type { LearningStore, Study } from './store';
import { currentMilestone } from '@/lib/pbl/v3/domain/orchestration/state';
import { digest, projectFor, stageFor } from './runtime';

/** Plans preserve previously approved incremental chapters. */
export async function assertLearningPlan(
  store: LearningStore,
  row: Study,
  text: string,
  completing = false,
) {
  const stage = stageFor(row);
  const { definition } = projectFor(row);
  const repairing = stage.kind === 'check' && stage.checker === 'tests';
  if (repairing && !text.trim()) throw sandboxConflict('PLAN.md must contain the learner’s plan.');
  const planning = repairing
    ? currentMilestone(definition, row.state)?.stages.find(
        (step) => step.kind === 'produce' && step.writes === 'plan',
      )
    : stage;
  if (
    planning?.kind !== 'produce' ||
    planning.writes !== 'plan' ||
    planning.planUpdateMode !== 'incremental'
  )
    return;
  const previous = definition.milestones[row.state.position.milestoneIndex - 1];
  if (!previous) return;
  const approved = row.state.collected[previous.id]?.plan;
  let length = approved?.contentLength;
  if (length === undefined) {
    const result = await store.pool.query<{ content: string }>(
      "SELECT event->>'content' AS content FROM pbl_v3_events WHERE study_id=$1 AND event->>'type'='artifact.recorded' AND event->'artifact'->>'kind'='plan' AND event->'artifact'->>'milestoneId'=$2 ORDER BY sequence DESC LIMIT 1",
      [row.id, previous.id],
    );
    length = result.rows[0]?.content?.length;
  }
  if (
    !approved ||
    !length ||
    digest(text.slice(0, length)) !== approved.contentHash ||
    ((completing || repairing) && !text.slice(length).trim())
  )
    throw sandboxConflict(
      'Preserve the approved earlier plan and append the current milestone section.',
    );
}
