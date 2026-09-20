import { describe, expect, test } from 'vitest';

import { CLAIM_TTL_MS, mintClaimCode, redeemClaimCode } from '@/lib/persistence/claim-code';

describe('claim code', () => {
  test('TTL ceiling is the signed 10 minutes', () => {
    expect(CLAIM_TTL_MS, 'claim TTL exceeds the signed ceiling of 10 minutes').toBeLessThanOrEqual(
      10 * 60 * 1000,
    );
  });

  test('is valid before the mark', async () => {
    const { code } = await mintClaimCode('anon:owner-1', 0);
    expect(await redeemClaimCode(code, CLAIM_TTL_MS - 1)).toEqual({ owner: 'anon:owner-1' });
  });

  test('is dead after the mark', async () => {
    const { code } = await mintClaimCode('anon:owner-1', 0);
    expect(await redeemClaimCode(code, CLAIM_TTL_MS + 1)).toBeUndefined();
  });

  test('is redeemable exactly once', async () => {
    const { code } = await mintClaimCode('anon:owner-1', 0);
    expect(await redeemClaimCode(code, 1)).toEqual({ owner: 'anon:owner-1' });
    expect(await redeemClaimCode(code, 2), 'claim code was redeemable twice').toBeUndefined();
  });

  test('never stores the code in the clear', async () => {
    const { code } = await mintClaimCode('anon:owner-1', 0);
    const { dumpClaimStore } = await import('@/lib/persistence/claim-code');
    expect(JSON.stringify(dumpClaimStore())).not.toContain(code);
  });
});
