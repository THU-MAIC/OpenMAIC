import { DEFAULT_ASSET_PENDING_TTL_MS } from '@openmaic/storage';

/**
 * How long an allocated asset may stay pending before the server expires it.
 *
 * An allocation is *pending* from the moment its bytes are stored until the
 * first document write that names its id, which is what commits it. Nothing on
 * the wire leases that gap: a browser stores the bytes, then writes the id into
 * a scene that may not exist yet. So this is the window the server promises to
 * wait before deciding that no document is ever going to claim those bytes.
 *
 * The default is a day because the window has to outlive a whole generation
 * pass plus a parked write-back — media routinely finishes before the slide
 * that will carry it is built, and the id is only written when that slide is
 * committed. A day of unclaimed bytes costs storage; an expiry that fires
 * before the document write costs a course its media, which is not recoverable.
 *
 * This only has an effect where the collector's entry pass runs, which in this
 * deployment is wherever server persistence is configured at all.
 *
 * Parsed like `ASSET_QUOTA_BYTES` rather than like `ASSET_COLLECTION_GRACE_MS`:
 * a value that is not a positive integer throws instead of falling back,
 * because a deployment that typed `24h` must not silently run on a window
 * nobody chose. `instrumentation.ts` calls this before the server is ready, so
 * the throw stops a misconfigured process from starting.
 */
export function resolveAssetPendingTtlMs(): number {
  const raw = process.env.ASSET_PENDING_TTL_MS?.trim();
  if (!raw) return DEFAULT_ASSET_PENDING_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `ASSET_PENDING_TTL_MS must be a positive integer number of milliseconds; received ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}
