/**
 * Browser-registry primitives: the branded content hash that keys its embedded
 * byte table, the hashing operation, and the object-URL cache used by resolve.
 *
 * These are implementation building blocks, not a replaceable blob-backend
 * seam. The browser registry keeps byte writes, reference counting, and
 * reclamation in the same IndexedDB transaction. Replaceable blob storage is a
 * server-backend concern, where the server enforces consistency.
 */
import type { AssetRef, BinaryBlob } from '@openmaic/dsl';

declare const contentHashBrand: unique symbol;

/** `sha256-<hex>` over the stored bytes. Internal to this package. */
export type ContentHash = string & { readonly [contentHashBrand]: true };

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

/** Read a blob's bytes and derive the content hash they are stored under. */
export async function contentHashOf(
  data: BinaryBlob,
): Promise<{ contentHash: ContentHash; bytes: ArrayBuffer }> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto crypto.subtle is unavailable; content hashing requires a secure context (HTTPS or localhost).',
    );
  }
  const bytes = await data.arrayBuffer();
  const digest = await subtle.digest('SHA-256', bytes);
  return { contentHash: `sha256-${toHex(digest)}` as ContentHash, bytes };
}

interface ResolvedObjectUrl<Identity> {
  /** Identity of the exact bytes from which `url` was minted. */
  identity: Identity;
  url: string;
}

interface CachedObjectUrl<Identity> {
  identity: Identity;
  promise: Promise<ResolvedObjectUrl<Identity> | null>;
  settled?: ResolvedObjectUrl<Identity> | null;
}

interface RetiredObjectUrl {
  promise: Promise<string | null>;
}

/**
 * Per-store cache of minted object URLs, keyed on whatever reference the store
 * resolves by.
 *
 * Keyed on the *promise* so concurrent `resolve(ref)` calls share one
 * `URL.createObjectURL` (a second would be orphaned, revocable by nothing), and
 * so repeated `resolve` returns one stable URL. Each entry also records the
 * identity of the bytes from which it was minted. Registry-backed callers use
 * the content hash for that identity, making a warm hit conditional on exact
 * content rather than merely on the reference still existing. Superseded URLs
 * are immutable snapshots: mutations retire them without revoking them, and
 * they stay alive until owner-level release or cache shutdown.
 */
export class ObjectUrlCache<Identity> {
  private readonly entries = new Map<AssetRef, CachedObjectUrl<Identity>>();
  private readonly retired = new Map<AssetRef, RetiredObjectUrl[]>();
  private closed = false;

  constructor(private readonly sameIdentity: (left: Identity, right: Identity) => boolean) {}

  /**
   * Return the cached resolution for `ref` when it has `identity`, or run
   * `read` and cache the exact identity it reports.
   *
   * Neither a miss nor a failure is cached: a miss must not survive a later
   * `put` of the same reference, and a transient IndexedDB failure must be
   * retried by the next call rather than replayed forever.
   */
  async resolve(
    ref: AssetRef,
    identity: Identity,
    read: () => Promise<ResolvedObjectUrl<Identity> | null>,
  ): Promise<string | null> {
    const cached = this.entries.get(ref);
    if (cached && this.sameIdentity(cached.identity, identity)) {
      return (await cached.promise)?.url ?? null;
    }
    if (cached) this.retire(ref, cached);

    const entry: CachedObjectUrl<Identity> = {
      identity,
      promise: Promise.resolve(null),
    };
    entry.promise = read().then(
      (resolved) => {
        entry.settled = resolved;
        if (resolved) entry.identity = resolved.identity;
        if (resolved && this.closed) {
          URL.revokeObjectURL(resolved.url);
        } else if (resolved === null && this.entries.get(ref) === entry) {
          this.entries.delete(ref);
        }
        return resolved;
      },
      (error: unknown) => {
        if (this.entries.get(ref) === entry) this.entries.delete(ref);
        throw error;
      },
    );
    if (!this.closed) this.entries.set(ref, entry);
    return (await entry.promise)?.url ?? null;
  }

  private addRetired(ref: AssetRef, entry: CachedObjectUrl<Identity>): void {
    let urls = this.retired.get(ref);
    if (!urls) {
      urls = [];
      this.retired.set(ref, urls);
    }
    urls.push({
      promise: entry.promise.then(
        (resolved) => resolved?.url ?? null,
        () => null,
      ),
    });
  }

  private retire(ref: AssetRef, entry: CachedObjectUrl<Identity>): void {
    if (this.entries.get(ref) !== entry) return;
    this.entries.delete(ref);
    this.addRetired(ref, entry);
  }

  private async revokeRetired(ref: AssetRef): Promise<void> {
    const urls = this.retired.get(ref);
    if (!urls) return;
    this.retired.delete(ref);
    const settled = await Promise.all(urls.map((url) => url.promise.catch(() => null)));
    for (const url of settled) {
      if (url) URL.revokeObjectURL(url);
    }
  }

  /**
   * Retire a ref's current snapshot without revoking it.
   *
   * A pending snapshot is enrolled in the retired set immediately; its URL is
   * filled in when it settles. Mutation never revokes a URL that a caller may
   * hold.
   */
  async invalidate(ref: AssetRef): Promise<void> {
    const entry = this.entries.get(ref);
    if (entry) this.retire(ref, entry);
  }

  /** Revoke the current and every retired snapshot for one owner-controlled ref. */
  async release(ref: AssetRef): Promise<void> {
    const entry = this.entries.get(ref);
    if (entry) this.retire(ref, entry);
    await this.revokeRetired(ref);
  }

  /**
   * Revoke every current, in-flight, and retired snapshot.
   *
   * If an unawaited `release` is already in flight, its last URL may be
   * revoked, at the latest, one microtask after this call resolves.
   */
  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.entries.values()].map((entry) => entry.promise.catch(() => null));
    for (const entry of this.entries.values()) {
      if (entry.settled) URL.revokeObjectURL(entry.settled.url);
    }
    const retired = [...this.retired.values()].flat();
    this.entries.clear();
    this.retired.clear();
    const retiredUrls = await Promise.all(retired.map((url) => url.promise.catch(() => null)));
    for (const url of retiredUrls) {
      if (url) URL.revokeObjectURL(url);
    }
    await Promise.all(pending);
  }
}
