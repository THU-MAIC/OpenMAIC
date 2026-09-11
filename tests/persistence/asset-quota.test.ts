/**
 * Allocation is reachable by any caller the deployment admits, and until
 * per-user asset principals land every one of them shares a single principal.
 * The store's quota is therefore the only thing bounding how much a deployment
 * can be made to hold.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveAssetQuotaBytes } from '@/lib/persistence/asset-quota';

const DEFAULT = 10 * 1024 * 1024 * 1024;

describe('asset quota configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('bounds a deployment that configured nothing', () => {
    vi.stubEnv('ASSET_QUOTA_BYTES', '');
    expect(resolveAssetQuotaBytes()).toBe(DEFAULT);
  });

  it('takes an operator’s own ceiling', () => {
    vi.stubEnv('ASSET_QUOTA_BYTES', '1048576');
    expect(resolveAssetQuotaBytes()).toBe(1_048_576);
  });

  // Zero is an intent, not a spelling. An operator who opted out with `0.0`
  // and silently got a 10 GiB ceiling would find out from a refused upload.
  it.each(['0', ' 0 ', '00', '0.0', '+0', '0e0'])('lets a deployment opt out with %s', (raw) => {
    vi.stubEnv('ASSET_QUOTA_BYTES', raw);
    expect(resolveAssetQuotaBytes()).toBeUndefined();
  });

  // Falling back to a default here is the worst outcome available: the
  // operator gets neither the ceiling they wrote nor a failure they notice.
  it.each(['-1', 'lots', '1.5', '10GB', '1e999', 'NaN', 'Infinity'])(
    'refuses %s instead of quietly running on a limit nobody chose',
    (raw) => {
      vi.stubEnv('ASSET_QUOTA_BYTES', raw);
      expect(() => resolveAssetQuotaBytes()).toThrow(/ASSET_QUOTA_BYTES/);
    },
  );
});
