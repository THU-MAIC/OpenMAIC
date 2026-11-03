/**
 * Reference roots: explicit rows that keep asset entries alive.
 *
 * A document keeps the entries it names alive through `document_asset_refs`,
 * which the document store derives from the document itself
 * (`./references.ts`). Some owners of an asset are not documents -- a library
 * entry that holds an uploaded original, say -- and name their assets
 * directly. Such an owner records `(root_kind, root_id, asset_id)` rows in
 * `asset_root_refs` through {@link changeAssetRoots}, and the entry lifecycle
 * treats a root exactly like a document reference (`./liveness.ts`): while a
 * row names an entry, nothing stamps it and the collector never releases it.
 *
 * `root_kind` and `root_id` are opaque to this package. It never interprets
 * either, and it never decides which roots exist -- the caller owns that, in
 * its own records, in the same transaction as the call.
 *
 * ## What a call does
 *
 * One call changes any number of roots, and it runs entirely in the caller's
 * transaction (`queryable` must be a transaction the caller owns and
 * commits), so a caller's own records and the roots they imply commit or roll
 * back together:
 *
 * 1. Every entry the call touches -- the union of the ids it adds and removes
 *    -- is locked in ONE ascending statement, before any write, following the
 *    package's lock rule (see `lockEntriesInOrder` in `./references.ts`).
 * 2. Ownership is checked under that lock: each id being added must exist and
 *    be held by one of `principals`, and each id being removed whose entry
 *    still exists must be held by one of `principals`. Anything else refuses
 *    the whole call with {@link AssetRootTargetError} before a row is written.
 *    This is deliberately stricter than document references, which skip ids
 *    they cannot resolve: a root is an explicit claim, not something inferred
 *    from content.
 * 3. The removed rows are deleted -- exactly the named `(kind, id, asset)`
 *    rows, reported back by `RETURNING` -- and the added rows are inserted.
 * 4. Every entry that gained a root is committed, exactly as a document write
 *    commits what it names: `committed_at` is set once, and `expires_at` and
 *    `unreferenced_at` are cleared.
 * 5. Only the entries whose root row was ACTUALLY deleted are considered for a
 *    stamp, in a statement of their own that sees both reference tables in a
 *    fresh snapshot. An entry still named by any document or any root is left
 *    alone, and an id whose root row did not exist changes nothing at all.
 * 6. The tracking marker's reference-rule version is raised to this
 *    package's if it records an older one (`raiseAssetReferenceRuleVersion`).
 *    No marker is created: a root says nothing about whether documents
 *    maintain references.
 *
 * Nothing here deletes an entry or a byte. Releasing is the collector's job,
 * after its own grace period and its own locked re-check.
 *
 * ## What a caller must not combine it with
 *
 * The one-statement lock above is only a guarantee if it is the only
 * `asset_entries` lock the transaction takes. Call this at most once per
 * transaction, and not in a transaction that also maintains document
 * references (a document save or delete), calls `PgAssetStore.replace`,
 * `remove` or `reassignPrincipal`, or runs the collector's backfill: each of
 * those locks entries in a statement of its own, and two ascending sequences
 * in one transaction can still deadlock another writer. Allocating a new
 * entry with `PgAssetStore.put` earlier in the same transaction is fine; no
 * other transaction can see or lock that row before the commit.
 *
 * ## How a caller keeps roots attributable
 *
 * `principals` bounds which entries a call may root or unroot; it cannot say
 * which roots belong to whom, because this package does not interpret
 * `root_id`. A caller that attaches roots to its own records keeps that
 * relation itself: it locks the record the root belongs to, confirms the
 * record is the caller's, passes only that record's id as `rootId`, and
 * removes only the asset ids its root rows actually hold. Removing a whole
 * record means reading those rows under the record's lock and passing them
 * here.
 *
 * A host that fences its owners' writes (an identity lock a merge of two
 * owners takes exclusively) takes that fence first in the same transaction,
 * then the row locks of every record the call touches -- all of them in ONE
 * `SELECT … ORDER BY id FOR UPDATE`, so two writers covering overlapping
 * records queue rather than deadlock -- then calls this: the one order in
 * which a root write, a merge and the collector cannot wait on each other in
 * a cycle. It passes only the owner's own partition as `principals`, never a
 * partition every owner shares: a host that lets several owners mutate one
 * partition must also refuse those mutations while any root holds the entry,
 * because this package cannot tell whose a root is.
 */
import {
  commitReferencedEntries,
  lockEntriesInOrder,
  queryableCandidates,
  raiseAssetReferenceRuleVersion,
  stampUnreferencedEntries,
} from './references.js';
import { isLosslessJsonString } from '../runtime/json-value.js';
import type { Queryable } from '../runtime/pg.js';

/** The asset ids one root holds, or is to stop holding. */
export interface AssetRootChange {
  /** Opaque to this package; the caller's own classification of the root. */
  readonly rootKind: string;
  /** Opaque to this package; the caller's own id for the root. */
  readonly rootId: string;
  /** The entries this change names. Duplicates are ignored. */
  readonly assetIds: readonly string[];
}

export interface ChangeAssetRootsInput {
  /** Roots to add. */
  readonly add?: readonly AssetRootChange[];
  /** Exact root rows to remove. */
  readonly remove?: readonly AssetRootChange[];
  /**
   * The principals whose entries this call may root or unroot. Required, and
   * never widened by the package: an id held by any other principal refuses
   * the call.
   */
  readonly principals: readonly string[];
}

/**
 * The input itself is malformed: a missing or non-text field, no principals,
 * or the same root named twice in one call (including once to add and once
 * to remove -- a call does not replace a root). Nothing was written.
 */
export class AssetRootInputError extends Error {
  constructor() {
    super('@openmaic/storage: invalid asset root change');
    this.name = 'AssetRootInputError';
  }
}

/**
 * A named entry does not exist (for an addition) or is held by a principal
 * outside `principals`. Nothing was written. The ids are deliberately not in
 * the message: this package keeps caller-derived strings out of thrown text.
 */
export class AssetRootTargetError extends Error {
  constructor() {
    super('@openmaic/storage: asset root target is missing or not owned');
    this.name = 'AssetRootTargetError';
  }
}

function isRootText(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && isLosslessJsonString(value);
}

function isAssetIdText(value: unknown): value is string {
  return typeof value === 'string' && isLosslessJsonString(value);
}

interface RootRows {
  readonly kinds: string[];
  readonly ids: string[];
  readonly assets: string[];
}

/**
 * Validate every change before any SQL runs, and flatten it into column
 * arrays. The root key is compared as the (kind, id) pair; a JSON encoding
 * keeps two different pairs from ever colliding on a separator.
 */
function flatten(changes: readonly AssetRootChange[], seen: Set<string>): RootRows {
  const kinds: string[] = [];
  const ids: string[] = [];
  const assets: string[] = [];
  for (const change of changes) {
    if (
      typeof change !== 'object' ||
      change === null ||
      !isRootText(change.rootKind) ||
      !isRootText(change.rootId) ||
      !Array.isArray(change.assetIds) ||
      !change.assetIds.every(isAssetIdText)
    ) {
      throw new AssetRootInputError();
    }
    const key = JSON.stringify([change.rootKind, change.rootId]);
    if (seen.has(key)) throw new AssetRootInputError();
    seen.add(key);
    for (const assetId of queryableCandidates(change.assetIds)) {
      kinds.push(change.rootKind);
      ids.push(change.rootId);
      assets.push(assetId);
    }
  }
  return { kinds, ids, assets };
}

/**
 * Add and remove reference roots in the caller's transaction. See the module
 * docstring for exactly what one call does, and what it must not be combined
 * with.
 *
 * @throws AssetRootInputError when the input is malformed or names a root
 *   twice; nothing was written.
 * @throws AssetRootTargetError when an added id does not exist or any named
 *   entry is held outside `principals`; nothing was written.
 */
export async function changeAssetRoots(
  queryable: Queryable,
  input: ChangeAssetRootsInput,
): Promise<void> {
  const principals = input?.principals;
  if (
    !Array.isArray(principals) ||
    principals.length === 0 ||
    !principals.every(isRootText) ||
    (input.add !== undefined && !Array.isArray(input.add)) ||
    (input.remove !== undefined && !Array.isArray(input.remove))
  ) {
    throw new AssetRootInputError();
  }
  const seen = new Set<string>();
  const added = flatten(input.add ?? [], seen);
  const removed = flatten(input.remove ?? [], seen);
  const union = queryableCandidates([...added.assets, ...removed.assets]);
  if (union.length === 0) return;

  // (1) Every entry lock this transaction takes, ascending, in one statement.
  const locked = await lockEntriesInOrder(queryable, union, 'no-key-update');

  // (2) Ownership, under the lock just taken.
  const allowed = new Set(principals);
  const holders = new Map(locked.map((entry) => [entry.id, entry.principal]));
  for (const assetId of added.assets) {
    const holder = holders.get(assetId);
    if (holder === undefined || !allowed.has(holder)) throw new AssetRootTargetError();
  }
  for (const assetId of removed.assets) {
    const holder = holders.get(assetId);
    if (holder !== undefined && !allowed.has(holder)) throw new AssetRootTargetError();
  }

  // (3) Exactly the named rows go; RETURNING says which ones existed.
  let unrooted: string[] = [];
  if (removed.assets.length > 0) {
    const deleted = await queryable.query<{ asset_id: string }>(
      `DELETE FROM asset_root_refs AS roots
        USING unnest($1::text[], $2::text[], $3::text[]) AS gone(root_kind, root_id, asset_id)
        WHERE roots.root_kind = gone.root_kind
          AND roots.root_id = gone.root_id
          AND roots.asset_id = gone.asset_id
        RETURNING roots.asset_id`,
      [removed.kinds, removed.ids, removed.assets],
    );
    unrooted = deleted.rows.map((row) => row.asset_id);
  }
  if (added.assets.length > 0) {
    // Ordered for the same reason the document reference insert is: each row
    // makes the foreign key take KEY SHARE on the entry it names. Every one of
    // those entries is already locked above, so this cannot wait; the order
    // is the second line of defence.
    await queryable.query(
      `INSERT INTO asset_root_refs (root_kind, root_id, asset_id)
       SELECT root_kind, root_id, asset_id
         FROM unnest($1::text[], $2::text[], $3::text[]) AS rooted(root_kind, root_id, asset_id)
        ORDER BY asset_id ASC
       ON CONFLICT DO NOTHING`,
      [added.kinds, added.ids, added.assets],
    );
  }

  // (4) A root arriving commits the entry, like a document naming it.
  await commitReferencedEntries(queryable, added.assets, undefined);

  // (5) Only what actually lost a root row, judged against both tables.
  await stampUnreferencedEntries(queryable, unrooted);

  // (6) A root writer applies the rules that count roots; say so.
  await raiseAssetReferenceRuleVersion(queryable);
}
