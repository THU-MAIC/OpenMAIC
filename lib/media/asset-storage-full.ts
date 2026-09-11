'use client';

/**
 * Whether this browser has been told the asset store has no room for a course.
 *
 * A quota refusal stops the generation pass, and the elements it never reached
 * are left as placeholders — deliberately, because nothing was attempted for
 * them and a persisted refusal per element would be a record of something that
 * never happened. But without any record at all, the next load has nothing to
 * stop it: the pass finds those placeholders, calls a provider for the next
 * one, and is refused at exactly the same point. One wasted generation per
 * reload, forever, on a store the deployment already knows is full.
 *
 * So the condition is remembered once per course rather than once per element.
 * It is not a property of any slide: it changes for reasons the document knows
 * nothing about — an operator raising the ceiling, a collector reclaiming space
 * — and the store checks each write against the headroom it has left, so it is
 * not a property of the deployment either. Per course is the granularity that
 * matches what it is used for: one course's pass standing down before it spends
 * the operator's money again. The cost of that choice is that another course
 * rediscovers the same ceiling at one provider call, which is the price of
 * never standing a course down on a condition nothing in that course
 * established. A pass that finds the marker stands down before spending
 * anything and leaves every placeholder in the "storage is full" state with its
 * Retry.
 *
 * It is retired in exactly one place: `putAsset` clears it for the course whose
 * bytes it just stored. A write the store accepted is the only evidence that
 * disproves "no room", and stating it at the seam rather than at each caller is
 * what keeps the next pool write path from silently leaving a course standing
 * down while the store has room.
 *
 * Device-local metadata, so it lives in the same browser KV as the rest of it
 * rather than in the media table, whose rows are scanned by half a dozen
 * readers that would each have to learn to ignore a row that is not media.
 * Every operation is best-effort: a browser that cannot store this still
 * generates, which is the behaviour that predates the marker.
 */
import { BrowserKVStore, type KVStore } from '@openmaic/storage';

const KEY_PREFIX = 'asset-storage-full:';
const DEVICE_SCOPE = 'device' as const;

let defaultKv: KVStore | undefined;
let kvOverride: KVStore | undefined;

function resolveKv(): KVStore | undefined {
  if (kvOverride) return kvOverride;
  try {
    // Inside the guard, deliberately. A browser whose storage is denied by
    // policy throws `SecurityError` on the property access itself — `typeof`
    // included — so an availability check outside the try is the one line that
    // can turn best-effort device metadata into a rejected promise, and this
    // one is awaited by a generation pass that has already enqueued its tasks.
    if (typeof localStorage === 'undefined') return undefined;
    return (defaultKv ??= new BrowserKVStore());
  } catch {
    return undefined;
  }
}

/** @internal Test seam: install a KV double, or `undefined` to restore. */
export function setAssetStorageFullStoreForTests(kv: KVStore | undefined): void {
  kvOverride = kv;
  defaultKv = undefined;
}

function key(stageId: string): string {
  return `${KEY_PREFIX}${stageId}`;
}

/** Remember that this course's next allocation has nowhere to go. */
export async function markAssetStorageFull(stageId: string): Promise<void> {
  const kv = resolveKv();
  if (!kv) return;
  await kv.set(key(stageId), Date.now(), DEVICE_SCOPE).catch(() => undefined);
}

/** Whether a pass for this course should stand down before spending anything. */
export async function isAssetStorageFull(stageId: string): Promise<boolean> {
  const kv = resolveKv();
  if (!kv) return false;
  const marked = await kv.get<unknown>(key(stageId), DEVICE_SCOPE).catch(() => undefined);
  return marked !== undefined && marked !== null;
}

/** The store took a write, so whatever was full is not full any more. */
export async function clearAssetStorageFull(stageId: string): Promise<void> {
  const kv = resolveKv();
  if (!kv) return;
  await kv.remove(key(stageId), DEVICE_SCOPE).catch(() => undefined);
}
