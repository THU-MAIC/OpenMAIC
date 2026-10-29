import 'server-only';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { Study } from './store';
import type { InstalledProject } from './catalog';
import { isProjectSource } from './workspace-files';

/** Reuse the completion snapshot for read-only review; never allocate a sandbox. */
export async function completedProjectFiles(
  db: Queryable,
  row: Pick<Study, 'id' | 'state'>,
  project: InstalledProject,
): Promise<Record<string, string> | null> {
  if (row.state.status !== 'completed') return null;
  const { rows } = await db.query<{ files: unknown }>(
    "SELECT detail->'files' AS files FROM pbl_v3_evidence WHERE study_id=$1 AND kind='artifact' AND detail->>'artifactKind'='final' ORDER BY id DESC LIMIT 1",
    [row.id],
  );
  const files = rows[0]?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
  return Object.fromEntries(
    Object.entries(files).filter(
      ([path, text]) => isProjectSource(project, path) && typeof text === 'string',
    ),
  );
}
