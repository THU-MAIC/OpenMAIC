import 'server-only';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { Study } from './store';

/** Evidence is append-only and independent of progression. Never store course protocols or answer keys here. */
export async function recordLearningEvidence(
  db: Queryable,
  row: Study,
  actor: string,
  kind: string,
  detail: Record<string, unknown>,
) {
  await db.query(
    `INSERT INTO pbl_v3_evidence(study_id,milestone_id,stage_index,kind,actor,detail)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      row.id,
      row.state.position.milestoneId,
      row.state.position.stageIndex,
      kind,
      actor,
      JSON.stringify(detail),
    ],
  );
}
