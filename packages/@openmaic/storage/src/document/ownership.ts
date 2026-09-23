/**
 * Document ownership, as a relation the host keeps.
 *
 * `document_stages` carries no ownership column. A host that scopes documents
 * per owner already records who owns each course somewhere -- usually a
 * companion table beside the document tables, which also answers visibility
 * and tombstones -- and a second copy of that fact on the document row is one
 * more place a change of owner has to reach. So the PostgreSQL backends take
 * the host's relation by name and scope through it, instead of keeping their
 * own.
 *
 * The names are spliced into SQL, so they are validated here rather than
 * quoted: each must be a plain, lower-case, unquoted PostgreSQL identifier
 * (optionally `schema.table` for the table). Anything else is refused at
 * construction.
 */

/**
 * Where a host records which owner holds which document: one row per owned
 * document, keyed by the document id.
 *
 * The rows must go when their document goes: give the table a foreign key to
 * `document_stages(id) ON DELETE CASCADE`, or delete the ownership row with
 * the document. A row left behind keeps the id reserved for its owner, and no
 * other owner can create a document under it (which is also how a host keeps
 * retired ids from being reused).
 */
export interface DocumentOwnershipRelation {
  /** The table (or view) holding one row per owned document; may be `schema.table`. */
  table: string;
  /** The column naming the document (`document_stages.id`). Defaults to `stage_id`. */
  stageIdColumn?: string;
  /** The column naming the owner. Defaults to `owner_id`. */
  ownerIdColumn?: string;
  /**
   * A nullable column whose non-null value retires the document. Listings
   * leave retired documents out; nothing else consults it (a write to a
   * retired document is the host's to refuse, as it is today). Omit when the
   * host has no tombstones.
   */
  tombstoneColumn?: string;
  /**
   * Insert the ownership row when an owner-bound store creates a document,
   * in the same transaction as the document rows. Requires a unique
   * constraint on the document column, and that the row needs no other
   * values. Defaults to `false`: the host claims ownership itself, inside the
   * store's transaction (its `withTransaction`), as a host that runs its own
   * create hooks must.
   */
  claimOnCreate?: boolean;
}

/** A validated relation, with defaults applied. */
export interface ResolvedDocumentOwnership {
  table: string;
  stageId: string;
  ownerId: string;
  tombstone: string | null;
  claimOnCreate: boolean;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(
      `@openmaic/storage: documentOwnership.${label} must be a plain lower-case PostgreSQL ` +
        `identifier, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Validate a relation and apply its defaults. */
export function resolveDocumentOwnership(
  relation: DocumentOwnershipRelation,
): ResolvedDocumentOwnership {
  if (typeof relation !== 'object' || relation === null) {
    throw new Error('@openmaic/storage: documentOwnership must be a relation object or false');
  }
  const tableParts = typeof relation.table === 'string' ? relation.table.split('.') : [];
  if (tableParts.length < 1 || tableParts.length > 2) {
    identifier(relation.table, 'table');
  }
  const table = tableParts.map((part) => identifier(part, 'table')).join('.');
  return {
    table,
    stageId: identifier(relation.stageIdColumn ?? 'stage_id', 'stageIdColumn'),
    ownerId: identifier(relation.ownerIdColumn ?? 'owner_id', 'ownerIdColumn'),
    tombstone:
      relation.tombstoneColumn === undefined
        ? null
        : identifier(relation.tombstoneColumn, 'tombstoneColumn'),
    claimOnCreate: relation.claimOnCreate === true,
  };
}

/**
 * `EXISTS (...)`: the document `stageExpression` names is owned by the owner
 * in parameter `$ownerParameter`, and -- with `live` -- not retired.
 */
export function ownedByCondition(
  ownership: ResolvedDocumentOwnership,
  stageExpression: string,
  ownerParameter: number,
  live = false,
): string {
  const retired =
    live && ownership.tombstone !== null ? ` AND ownership.${ownership.tombstone} IS NULL` : '';
  return (
    `EXISTS (SELECT 1 FROM ${ownership.table} AS ownership ` +
    `WHERE ownership.${ownership.stageId} = ${stageExpression} ` +
    `AND ownership.${ownership.ownerId} = $${ownerParameter}${retired})`
  );
}

/** `$1` is the document id; answers `owner_id` rows (zero or one). */
export function ownerOfSql(ownership: ResolvedDocumentOwnership, lock = ''): string {
  return (
    `SELECT ${ownership.ownerId} AS owner_id FROM ${ownership.table} ` +
    `WHERE ${ownership.stageId} = $1${lock}`
  );
}

/** `$1` document id, `$2` owner; answers the inserted row's `owner_id`, or nothing. */
export function claimOwnershipSql(ownership: ResolvedDocumentOwnership): string {
  return (
    `INSERT INTO ${ownership.table} (${ownership.stageId}, ${ownership.ownerId}) ` +
    `VALUES ($1, $2) ON CONFLICT (${ownership.stageId}) DO NOTHING ` +
    `RETURNING ${ownership.ownerId} AS owner_id`
  );
}
