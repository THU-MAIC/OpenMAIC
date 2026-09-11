/**
 * How many bytes one asset principal may hold.
 *
 * The asset store enforces this inside its write transaction, under a
 * per-principal advisory lock, so concurrent uploads cannot race past it. What
 * it needs from here is a number — and until real per-user principals land,
 * every caller of this deployment resolves to one shared principal, so the
 * number is a deployment-wide ceiling rather than a per-user one.
 *
 * A default is set deliberately rather than left off. Allocation is reachable
 * by any caller the deployment admits, and this application only began writing
 * to the registry recently, so an unbounded store is unbounded database growth
 * with no operator-visible brake. Ten gibibytes is generous for a course
 * library and small enough to notice.
 */
const DEFAULT_ASSET_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * Resolve the configured ceiling, or `undefined` for "no quota".
 *
 * Zero means opt out, and it means that however it is spelled: `0`, `00`,
 * `0.0`, `+0` and `0e0` are one intent, and a deployment that wrote one of the
 * unusual spellings must not silently get a 10 GiB ceiling instead of the
 * unbounded store it asked for. So the value is parsed first and compared to
 * zero afterwards, rather than matched as text.
 *
 * Anything that is not a non-negative integer is a configuration mistake, and
 * this throws rather than falling back. A warning plus a default is the worst
 * of both: the operator who typed `10GB` gets neither the ceiling they wrote
 * nor a failure they will notice, and the deployment quietly runs on a limit
 * nobody chose.
 *
 * Called from `instrumentation.ts`, which Next runs once per server instance
 * before it serves anything, so the throw stops the process from starting. That
 * placement is the point: the persistence provider that consumes the number is
 * lazy and memoised, so resolving it only there would let a misconfigured
 * deployment boot, pass its health check, and then fail every persistence
 * request -- documents and runtime, not only assets -- one at a time.
 */
export function resolveAssetQuotaBytes(): number | undefined {
  const raw = process.env.ASSET_QUOTA_BYTES?.trim();
  if (!raw) return DEFAULT_ASSET_QUOTA_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `ASSET_QUOTA_BYTES must be a non-negative integer number of bytes, or 0 to opt out of the quota entirely; received ${JSON.stringify(raw)}.`,
    );
  }
  return parsed === 0 ? undefined : parsed;
}
