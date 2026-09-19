'use client';

import { useEffect, useState } from 'react';
import { getAssetPool, type AssetPoolStore } from './asset-pool';
import type { AssetReplacementPool } from './asset-replacement-events';

const EMPTY_ASSET_URLS: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_ASSET_LEASES: Readonly<Record<string, AssetUrlLeaseState>> = Object.freeze({});

export type AssetUrlLeaseState =
  | { readonly status: 'pending' }
  | { readonly status: 'resolved'; readonly url: string }
  | { readonly status: 'missing' };

type AssetPoolView = Pick<AssetPoolStore, 'exists' | 'invalidate' | 'resolve' | 'release'>;
interface OwnedResolution {
  owners: number;
  resolution: Promise<string | null>;
}

interface AssetUrlTracker {
  active: boolean;
  observed?: Promise<string | null>;
  readonly onResolved: (url: string | null) => void;
}

const ownedResolutions = new WeakMap<object, Map<string, OwnedResolution>>();
const pendingReleases = new WeakMap<object, Map<string, Promise<void>>>();
const activeTrackers = new WeakMap<object, Map<string, Set<AssetUrlTracker>>>();

function resolveAfterPendingRelease(ref: string, pool: AssetPoolView): Promise<string | null> {
  const pendingRelease = pendingReleases.get(pool)?.get(ref);
  return pendingRelease
    ? pendingRelease.catch(() => undefined).then(() => pool.resolve(ref))
    : pool.resolve(ref);
}

function acquireAssetUrl(
  ref: string,
  pool: AssetPoolView = getAssetPool(),
): { resolution: Promise<string | null>; release: () => Promise<void> } {
  let byRef = ownedResolutions.get(pool);
  if (!byRef) {
    byRef = new Map();
    ownedResolutions.set(pool, byRef);
  }
  let owned = byRef.get(ref);
  if (!owned) {
    owned = {
      owners: 0,
      resolution: resolveAfterPendingRelease(ref, pool),
    };
    byRef.set(ref, owned);
  }
  owned.owners += 1;
  let released = false;
  return {
    resolution: owned.resolution,
    release: async () => {
      if (released) return;
      released = true;
      owned.owners -= 1;
      try {
        await owned.resolution;
      } catch {
        // A failed resolve pins no URL, but removing the rejected shared
        // promise lets a later mount retry a transient IndexedDB failure.
        if (owned.owners === 0 && byRef?.get(ref) === owned) byRef.delete(ref);
        return;
      }
      if (owned.owners !== 0 || byRef?.get(ref) !== owned) return;
      let releasesByRef = pendingReleases.get(pool);
      if (!releasesByRef) {
        releasesByRef = new Map();
        pendingReleases.set(pool, releasesByRef);
      }
      const pendingRelease = Promise.resolve().then(() => pool.release(ref));
      releasesByRef.set(ref, pendingRelease);
      // A concurrent acquire must create a new resolution chained behind the
      // pending release, never inherit the snapshot that is being revoked.
      byRef.delete(ref);
      try {
        await pendingRelease;
      } finally {
        // Never retain a settled resolution after the final owner leaves. A
        // later owner must ask the pool again so replacement/removal is visible.
        if (releasesByRef.get(ref) === pendingRelease) releasesByRef.delete(ref);
      }
    },
  };
}

function observeTracker(
  ref: string,
  pool: AssetPoolView,
  owned: OwnedResolution,
  tracker: AssetUrlTracker,
): void {
  const resolution = owned.resolution;
  if (tracker.observed === resolution) return;
  tracker.observed = resolution;
  void resolution.then(
    (url) => {
      if (
        tracker.active &&
        tracker.observed === resolution &&
        ownedResolutions.get(pool)?.get(ref) === owned &&
        owned.resolution === resolution
      ) {
        tracker.onResolved(url);
      }
    },
    () => {
      if (
        tracker.active &&
        tracker.observed === resolution &&
        ownedResolutions.get(pool)?.get(ref) === owned &&
        owned.resolution === resolution
      ) {
        tracker.onResolved(null);
      }
    },
  );
}

/** Re-resolve a same-id replacement and publish it to every mounted lease. */
export async function invalidateAssetUrlLeaseCache(
  ref: string,
  pool: AssetReplacementPool = getAssetPool(),
): Promise<void> {
  // A peer's replacement can arrive while the HTTP store still has the old
  // revision in flight. Advance its generation before asking for fresh bytes
  // so that request cannot satisfy this refresh or a later caller.
  await pool.invalidate(ref);
  const owned = ownedResolutions.get(pool)?.get(ref);
  if (!owned || owned.owners === 0) return;
  const resolution = resolveAfterPendingRelease(ref, pool);
  owned.resolution = resolution;
  for (const tracker of activeTrackers.get(pool)?.get(ref) ?? []) {
    observeTracker(ref, pool, owned, tracker);
  }
  await resolution.then(
    () => undefined,
    () => {
      // Do not retain a rejected refresh for later acquirers. Mounted trackers
      // still receive the miss, while the next lease gets an independent retry.
      if (ownedResolutions.get(pool)?.get(ref) === owned && owned.resolution === resolution) {
        ownedResolutions.get(pool)?.delete(ref);
      }
    },
  );
}

/** Run work while holding one shared, scoped URL lease. */
export async function withAssetUrl<T>(
  ref: string,
  fn: (url: string | null) => Promise<T> | T,
  pool: AssetPoolView = getAssetPool(),
): Promise<T> {
  const lease = acquireAssetUrl(ref, pool);
  try {
    return await fn(await lease.resolution);
  } finally {
    await lease.release();
  }
}

/** Batch counterpart that acquires each unique ref once for the callback. */
export async function runWithAssetUrls<T>(
  refs: readonly string[],
  fn: (urls: Readonly<Record<string, string>>) => Promise<T> | T,
  pool: AssetPoolView = getAssetPool(),
): Promise<T> {
  const uniqueRefs = [...new Set(refs)];
  const leases = uniqueRefs.map((ref) => ({ ref, lease: acquireAssetUrl(ref, pool) }));
  try {
    const resolved = await Promise.all(
      leases.map(async ({ ref, lease }) => [ref, await lease.resolution] as const),
    );
    return await fn(
      Object.fromEntries(
        resolved.filter((entry): entry is readonly [string, string] => !!entry[1]),
      ),
    );
  } finally {
    await Promise.all(leases.map(({ lease }) => lease.release()));
  }
}

export function trackAssetUrl(
  ref: string,
  onResolved: (url: string | null) => void,
  pool: AssetPoolView = getAssetPool(),
): () => void {
  const lease = acquireAssetUrl(ref, pool);
  const owned = ownedResolutions.get(pool)?.get(ref);
  if (!owned) throw new Error('Asset URL lease ownership was not initialized.');
  let trackersByRef = activeTrackers.get(pool);
  if (!trackersByRef) {
    trackersByRef = new Map();
    activeTrackers.set(pool, trackersByRef);
  }
  let trackers = trackersByRef.get(ref);
  if (!trackers) {
    trackers = new Set();
    trackersByRef.set(ref, trackers);
  }
  const tracker: AssetUrlTracker = { active: true, onResolved };
  trackers.add(tracker);
  observeTracker(ref, pool, owned, tracker);
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    tracker.active = false;
    trackers?.delete(tracker);
    if (trackers?.size === 0) trackersByRef?.delete(ref);
    // Pool URLs are immutable Blob snapshots pinned until release. App-level
    // ownership prevents one renderer surface from revoking a snapshot while
    // another surface still uses the shared singleton URL.
    void lease.release().catch(() => undefined);
  };
}

/** Probe an opaque ref without revoking a URL owned by a mounted renderer. */
export async function assetRefExists(
  ref: string,
  pool: AssetPoolView = getAssetPool(),
): Promise<boolean> {
  // Metadata-only when the store supports it: the resolve fallback downloads
  // every probed byte, which a per-open migration check cannot afford.
  if (typeof pool.exists === 'function') return pool.exists(ref);
  return withAssetUrl(ref, (url) => url !== null, pool);
}

/** Resolve one asset ref and release its pinned URL snapshot after this owner leaves. */
export function useAssetUrl(ref: string | undefined): string | null {
  const lease = useAssetUrlLease(ref);
  return lease.status === 'resolved' ? lease.url : null;
}

/** Resolve one ref while preserving pending versus confirmed-miss state. */
export function useAssetUrlLease(ref: string | undefined): AssetUrlLeaseState {
  const [resolved, setResolved] = useState<{
    ref: string;
    lease: Exclude<AssetUrlLeaseState, { status: 'pending' }>;
  } | null>(null);

  useEffect(() => {
    if (!ref) return;
    try {
      return trackAssetUrl(ref, (url) =>
        setResolved({
          ref,
          lease: url ? { status: 'resolved', url } : { status: 'missing' },
        }),
      );
    } catch {
      return;
    }
  }, [ref]);

  return ref && resolved?.ref === ref ? resolved.lease : { status: 'pending' };
}

/** Batch form used by a slide, whose element count cannot drive hook calls. */
export function useAssetUrls(refs: readonly string[]): Readonly<Record<string, string>> {
  const leases = useAssetUrlLeases(refs);
  const urls: Record<string, string> = {};
  for (const [ref, lease] of Object.entries(leases)) {
    if (lease.status === 'resolved') urls[ref] = lease.url;
  }
  return Object.keys(urls).length === 0 ? EMPTY_ASSET_URLS : urls;
}

/** Collect a batch's first result per ref, then publish every later refresh. */
export function createAssetUrlLeaseBatchPublisher(
  refs: readonly string[],
  publish: (leases: Readonly<Record<string, AssetUrlLeaseState>>) => void,
): (ref: string, url: string | null) => void {
  const uniqueRefs = [...new Set(refs)];
  const leases: Record<string, AssetUrlLeaseState> = Object.fromEntries(
    uniqueRefs.map((ref) => [ref, { status: 'pending' } satisfies AssetUrlLeaseState]),
  );
  const resolvedRefs = new Set<string>();
  let initialPublished = false;

  return (ref, url) => {
    if (!Object.hasOwn(leases, ref)) return;
    leases[ref] = url ? { status: 'resolved', url } : { status: 'missing' };
    resolvedRefs.add(ref);
    if (!initialPublished) {
      if (resolvedRefs.size !== uniqueRefs.length) return;
      initialPublished = true;
    }
    publish({ ...leases });
  };
}

/** Batch hook preserving pending/resolved/missing for the media state machine. */
export function useAssetUrlLeases(
  refs: readonly string[],
): Readonly<Record<string, AssetUrlLeaseState>> {
  const signature = JSON.stringify([...new Set(refs)].sort());
  const [resolved, setResolved] = useState<{
    signature: string;
    leases: Record<string, AssetUrlLeaseState>;
  } | null>(null);

  useEffect(() => {
    const currentRefs = JSON.parse(signature) as string[];
    if (currentRefs.length === 0) return;
    let pool: AssetPoolStore;
    try {
      pool = getAssetPool();
    } catch {
      return;
    }
    let active = true;
    const publish = createAssetUrlLeaseBatchPublisher(currentRefs, (leases) => {
      if (!active) return;
      setResolved((current) => {
        const previous = current?.signature === signature ? current.leases : undefined;
        if (previous) {
          const keys = Object.keys(leases);
          if (
            keys.length === Object.keys(previous).length &&
            keys.every((key) => JSON.stringify(previous[key]) === JSON.stringify(leases[key]))
          ) {
            return current;
          }
        }
        return {
          signature,
          leases: { ...leases },
        };
      });
    });
    const cleanups = currentRefs.map((ref) => trackAssetUrl(ref, (url) => publish(ref, url), pool));
    return () => {
      active = false;
      for (const cleanup of cleanups) cleanup();
    };
  }, [signature]);

  if (resolved?.signature === signature) return resolved.leases;
  if (refs.length === 0) return EMPTY_ASSET_LEASES;
  return Object.fromEntries(
    [...new Set(refs)].map((ref) => [ref, { status: 'pending' } satisfies AssetUrlLeaseState]),
  );
}
