/**
 * Which owner a browser's pre-server data belongs to, decided by the server.
 *
 * The one-way import of what earlier builds kept in a browser
 * (`lib/legacy-browser-import/`) runs once per browser: the browser keeps a
 * random id, and the first owner that binds it here holds it. The binding is
 * a row, inserted atomically, so two owners racing from two tabs cannot both
 * win; a claim re-keys it with everything else the claimed owner held (it is
 * a claim participant, `./owner-claims.ts`), so the account a visitor signs in
 * to simply owns it afterwards.
 *
 * Every request the importer sends carries its browser id in
 * `X-OpenMAIC-Legacy-Import`, and owner resolution refuses such a request
 * with `409 LEGACY_IMPORT_NOT_BOUND` unless the owner it resolves to holds the
 * binding (`lib/server/identity/with-owner.ts`). The importer can therefore
 * never write under an owner that does not hold the browser, whatever its
 * page believes the owner is.
 *
 * Temporary, like the importer: remove with it.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

/** The request header an importer request carries its browser id in. */
export const LEGACY_IMPORT_HEADER = 'x-openmaic-legacy-import';

/** The error code of a request whose browser is not bound to its owner. */
export const LEGACY_IMPORT_NOT_BOUND = 'LEGACY_IMPORT_NOT_BOUND';

/** A browser id: 128 random bits, lowercase hex. */
export const BROWSER_ID_PATTERN = /^[0-9a-f]{32}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS legacy_import_bindings (
  browser_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_import_bindings_owner_idx
  ON legacy_import_bindings (owner_id);
`;

export const LEGACY_IMPORT_BINDING_MIGRATIONS: SchemaMigrationSet = {
  store: 'legacy-import-bindings',
  migrations: [{ version: 1, name: 'baseline', up: SCHEMA }],
};

export async function ensureLegacyImportBindingSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, LEGACY_IMPORT_BINDING_MIGRATIONS);
}

/**
 * Bind `browserId` to `ownerId` unless some owner holds it already, and answer
 * whether `ownerId` holds it now. Atomic: the insert either creates the row or
 * finds one, and the answer is read from the row that exists.
 */
export async function bindLegacyImport(
  queryable: Queryable,
  browserId: string,
  ownerId: string,
): Promise<boolean> {
  await queryable.query(
    `INSERT INTO legacy_import_bindings (browser_id, owner_id) VALUES ($1, $2)
       ON CONFLICT (browser_id) DO NOTHING`,
    [browserId, ownerId],
  );
  return (await legacyImportBindingOwner(queryable, browserId)) === ownerId;
}

/** The owner that holds `browserId`, or null when no owner does. */
export async function legacyImportBindingOwner(
  queryable: Queryable,
  browserId: string,
): Promise<string | null> {
  const result = await queryable.query<{ owner_id: string } & Record<string, unknown>>(
    'SELECT owner_id FROM legacy_import_bindings WHERE browser_id = $1',
    [browserId],
  );
  return result.rows[0]?.owner_id ?? null;
}

/** The claim participant's work: every binding `fromOwnerId` holds moves to `toOwnerId`. */
export async function rekeyLegacyImportBindings(
  tx: Queryable,
  fromOwnerId: string,
  toOwnerId: string,
): Promise<number> {
  const result = await tx.query(
    `UPDATE legacy_import_bindings SET owner_id = $2, updated_at = now()
       WHERE owner_id = $1 RETURNING browser_id`,
    [fromOwnerId, toOwnerId],
  );
  return result.rows.length;
}
