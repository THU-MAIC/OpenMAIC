import 'server-only';
import { diffLines } from 'diff';
import { createHash } from 'node:crypto';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { FileChangeRange } from '@/lib/pbl/v3/file-reference';

export function changedLineRanges(before: string, after: string): FileChangeRange[] {
  const ranges: FileChangeRange[] = [];
  let line = 1;
  const chunks = diffLines(before, after, { timeout: 100 });
  // A presentation budget cannot fail a write or invent a changed range.
  if (!chunks) return ranges;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    if (chunk.removed) {
      if (chunks[i + 1]?.added) continue;
      const anchor = Math.min(line, after.split('\n').length);
      ranges.push({ start: anchor, end: anchor, kind: 'deleted' });
    } else {
      if (chunk.added)
        ranges.push({
          start: line,
          end: line + chunk.count - 1,
          kind: chunks[i - 1]?.removed ? 'modified' : 'added',
        });
      line += chunk.count;
    }
  }
  return ranges;
}

/** Only the latest write to this public file may decorate the current content. */
export async function latestFileChanges(
  db: Queryable,
  studyId: string,
  path: string,
  hash: string,
) {
  const { rows } = await db.query<{
    actor: string;
    detail: { text?: string; changes?: FileChangeRange[] };
  }>(
    "SELECT actor,detail FROM pbl_v3_evidence WHERE study_id=$1 AND kind='file-edit' AND detail->>'path'=$2 ORDER BY id DESC LIMIT 1",
    [studyId, path],
  );
  const event = rows[0];
  if (
    !event ||
    !['planner', 'coder'].includes(event.actor) ||
    typeof event.detail.text !== 'string'
  )
    return [];
  if (createHash('sha256').update(event.detail.text).digest('hex') !== hash) return [];
  return event.detail.changes ?? [];
}
