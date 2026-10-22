import 'server-only';
import { sandboxConflict } from '@/lib/sandbox/errors';
import type { LearningStore, Study } from './store';
import { digest, projectFor, stageFor } from './runtime';

/** Incremental planning appends the current milestone to the last approved plan; earlier chapters remain evidence. */
export async function assertIncrementalPlan(
  store: LearningStore,
  row: Study,
  text: string,
  completing = false,
) {
  const stage = stageFor(row);
  if (stage.kind !== 'produce' || stage.writes !== 'plan' || stage.planUpdateMode !== 'incremental')
    return;
  const previous = projectFor(row).definition.milestones[row.state.position.milestoneIndex - 1];
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
    (completing && !text.slice(length).trim())
  )
    throw sandboxConflict(
      'Preserve the approved earlier plan and append the current milestone section.',
    );
}
