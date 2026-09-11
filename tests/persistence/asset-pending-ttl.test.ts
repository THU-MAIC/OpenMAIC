/**
 * The window between "the bytes are stored" and "a document names them". Too
 * short and the server expires an allocation whose write-back was still coming,
 * which costs a course its media; too long and unclaimed bytes sit against the
 * principal's quota. Neither end of that is something a typo should choose.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ASSET_PENDING_TTL_MS } from '@openmaic/storage';

import { resolveAssetPendingTtlMs } from '@/lib/persistence/asset-pending-ttl';

describe('asset pending TTL configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('defaults to the package window, which is a day', () => {
    vi.stubEnv('ASSET_PENDING_TTL_MS', '');
    // A day outlives a generation pass plus a parked write-back, which is the
    // gap this has to cover. Pinning the number as well as the source keeps a
    // package-side change from silently shortening it.
    expect(resolveAssetPendingTtlMs()).toBe(DEFAULT_ASSET_PENDING_TTL_MS);
    expect(resolveAssetPendingTtlMs()).toBe(24 * 60 * 60 * 1000);
  });

  it('takes an operator’s own window', () => {
    vi.stubEnv('ASSET_PENDING_TTL_MS', '3600000');
    expect(resolveAssetPendingTtlMs()).toBe(3_600_000);
  });

  it('trims surrounding whitespace rather than refusing it', () => {
    vi.stubEnv('ASSET_PENDING_TTL_MS', '  60000  ');
    expect(resolveAssetPendingTtlMs()).toBe(60_000);
  });

  // Zero is not an opt-out here, unlike the quota: an allocation that expires
  // immediately is one the very next document write cannot commit.
  it.each(['0', '-1', '1.5', '24h', 'soon', '1e999', 'NaN', 'Infinity'])(
    'refuses %s instead of running on a window nobody chose',
    (raw) => {
      vi.stubEnv('ASSET_PENDING_TTL_MS', raw);
      expect(() => resolveAssetPendingTtlMs()).toThrow(/ASSET_PENDING_TTL_MS/);
    },
  );
});
