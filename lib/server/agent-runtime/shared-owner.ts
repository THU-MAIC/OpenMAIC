/**
 * Deployment-wide owner identity, for single-tenant installations.
 *
 * Course documents, folders, materials and agent sessions are partitioned by an
 * owner id. Without a host auth layer that id comes from a 30-day anonymous
 * cookie (`./owner.ts`), which means one physical browser is one learner: a
 * second browser sees an empty course list, a cleared cookie looks like a new
 * installation, and `POST /api/stages/[id]/publish` refuses every owner because
 * publishing an anonymous partition is not something the product allows.
 *
 * For one team behind one `ACCESS_CODE` that partitioning buys nothing — those
 * visitors already share the site password and can read each other's courses by
 * id (`SECURITY.md` says as much about `ACCESS_CODE`). `PERSISTENCE_SHARED_OWNER_ID`
 * replaces the cookie-derived id with that fixed value, so the deployment has
 * one course library, and publishing works.
 *
 * It **requires** `ACCESS_CODE`, and refuses to run without one: see the note
 * in {@link resolveSharedOwnerId}. It is also not a substitute for server
 * persistence — Postgres answers where courses live, this answers who owns
 * them, and a multi-user or multi-instance deployment still wants the former.
 *
 * Unset — the default — changes nothing: every request keeps resolving to its
 * cookie partition.
 */

const SHARED_OWNER_ENV = 'PERSISTENCE_SHARED_OWNER_ID';

/**
 * The value becomes an owner id and part of material object keys, so it is
 * restricted to characters that survive that path unchanged. `:` is excluded,
 * which also rules out the reserved `anon:` prefix — an id in that namespace
 * would still be refused by `publish` and would alias onto a cookie owner.
 */
const SHARED_OWNER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The configured shared owner id, or `undefined` when the deployment has none.
 *
 * Read from the environment on each call so a value changed for a test is
 * observed without a module reload, matching `allowLocalNetworksEnabled()` in
 * `lib/server/ssrf-guard.ts`.
 *
 * An empty or whitespace-only value is treated as unset rather than rejected:
 * a blank variable is how `KEY=` in an env file reads, and it cannot be told
 * apart from an operator who meant to leave the feature off. Any other
 * malformed value throws instead of being ignored — silently falling back to
 * cookie owners would reproduce exactly the confusing behaviour this setting
 * exists to remove. `instrumentation.ts` calls this at startup so the mistake
 * fails a deployment rather than every request that follows.
 */
export function resolveSharedOwnerId(): string | undefined {
  const raw = process.env[SHARED_OWNER_ENV]?.trim();
  if (!raw) return undefined;
  if (!SHARED_OWNER_PATTERN.test(raw)) {
    throw new Error(
      `${SHARED_OWNER_ENV} must be 1-128 characters of [A-Za-z0-9._-], got ${JSON.stringify(raw)}. ` +
        'It becomes the owner id for every request and part of material object keys, so it ' +
        'cannot use the reserved "anon:" prefix or a character the key sanitiser would rewrite.',
    );
  }
  // The gate this assumes is the middleware's: with `ACCESS_CODE` unset it lets
  // every request through, and resolving them all to one owner would hand a
  // single readable, editable, publishable course library to whoever asks. That
  // is a far worse deployment than the per-browser partitioning this setting
  // exists to remove, so it is refused rather than warned about — the operator
  // either wants an access code or did not mean to set this.
  if (!process.env.ACCESS_CODE) {
    throw new Error(
      `${SHARED_OWNER_ENV} requires ACCESS_CODE. Without an access code the middleware lets ` +
        'every request through, so a single shared owner would expose one course library to ' +
        `anyone who can reach the deployment. Set ACCESS_CODE, or unset ${SHARED_OWNER_ENV}.`,
    );
  }
  return raw;
}
