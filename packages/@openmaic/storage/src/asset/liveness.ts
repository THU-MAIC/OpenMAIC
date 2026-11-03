/**
 * Whether anything still holds an asset entry alive.
 *
 * **Internal to the package.** An entry is referenced when a row in EITHER
 * reference table names it: a document reference (`document_asset_refs`,
 * maintained by `./references.ts`) or an explicit root (`asset_root_refs`,
 * maintained by `./roots.ts`). Every lifecycle decision -- stamping an entry
 * unreferenced, the collector's legacy mark and sweep, and the final check
 * before a release -- asks this one question, so the two kinds cannot drift
 * apart: a lifecycle check that consulted only one table would stamp, and
 * eventually release, an entry the other still holds.
 *
 * This is a LIFECYCLE rule only. Who may read an entry is a separate question
 * the host answers from document references alone (a root keeps an entry
 * alive; it never makes the entry readable by another principal), so nothing
 * outside the lifecycle should use these helpers.
 */
import type { Queryable } from '../runtime/pg.js';

/**
 * A predicate that is true when no reference of either kind names the entry
 * aliased `entries` in the surrounding statement.
 *
 * Kept inside the stamping `UPDATE` rather than evaluated beforehand, so each
 * caller's stamp is decided in the statement's own fresh READ COMMITTED
 * snapshot, taken after the caller's entry locks -- see the stamp functions in
 * `./references.ts` and `./collector.ts`.
 */
export const ENTRY_UNREFERENCED_SQL = `NOT EXISTS (
                SELECT 1 FROM document_asset_refs AS refs WHERE refs.asset_id = entries.id
              )
          AND NOT EXISTS (
                SELECT 1 FROM asset_root_refs AS roots WHERE roots.asset_id = entries.id
              )`;

/**
 * True when a reference of either kind names `id`.
 *
 * One statement of its own: the collector's release asks it AFTER locking the
 * entry, so that it reads a fresh snapshot rather than the lock statement's
 * (see `AssetCollector.releaseEntries`).
 */
export async function entryIsReferenced(queryable: Queryable, id: string): Promise<boolean> {
  const referenced = await queryable.query(
    `SELECT 1 FROM document_asset_refs WHERE asset_id = $1
     UNION ALL
     SELECT 1 FROM asset_root_refs WHERE asset_id = $1
     LIMIT 1`,
    [id],
  );
  return referenced.rows.length > 0;
}
