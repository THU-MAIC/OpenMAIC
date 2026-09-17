/**
 * Whether a reference could name something the asset pool holds.
 *
 * Asking the pool is not free once it is server-backed: each lease becomes a
 * real `GET /assets/<ref>/content`, and a reference the pool cannot possibly
 * hold answers 404 — one wasted request per element per load, forever on a
 * course that still carries generation placeholders.
 *
 * The test is a positive one: a reference may name a pool asset only if it
 * carries the `ast_` prefix. Every id this application stores comes from
 * `putAsset`, which the pool answers with `newAssetId`, and every allocated id
 * is prefixed — so a reference without the prefix was never issued by the pool
 * and cannot be in it. A negative test ("is it one of the shapes we mint?")
 * was tried first and is strictly weaker: it has to enumerate our own id
 * shapes, and every shape added later that nobody remembers to list here
 * silently becomes a per-load 404.
 *
 * This is an **application-layer convention about what this application puts
 * into the pool**, not a validator for the pool's id domain. That domain is
 * deliberately unconstrained (see `@openmaic/storage`'s `toAssetId`, and note
 * that the prefix constant is deliberately not exported from that package, so
 * a validator cannot be grown from it): the pool will happily store and return
 * an id of any shape. Nothing here decides what a *valid* id looks like — only
 * that this application never asks the pool about a reference it knows the
 * pool never issued to it. A deployment that installs its own pool store and
 * mints ids of another shape has to revisit this, which is why the reasoning
 * is written down rather than inferred from a regex.
 *
 * Applied unconditionally, in both persistence modes. Imported media is the
 * case worth naming: an import mints `nanoid()` ids, which carry no prefix,
 * and puts those bytes in the local media tables — never in the asset pool. So
 * skipping the pool for them changes nothing in browser-only mode either; the
 * lookup it replaces was an IndexedDB miss.
 */

/**
 * The prefix every id the pool allocates carries.
 *
 * Duplicated from the storage package on purpose: the package keeps its prefix
 * constant unexported precisely so downstream code cannot grow an id validator
 * from it, and this is not one — it is this application's own statement about
 * the references it writes into its own documents.
 */
const ALLOCATED_ASSET_ID_PREFIX = 'ast_';

/** Whether the pool could be holding bytes under this reference. */
export function mayNameAPoolAsset(ref: string | undefined): ref is string {
  return ref !== undefined && ref.startsWith(ALLOCATED_ASSET_ID_PREFIX);
}
