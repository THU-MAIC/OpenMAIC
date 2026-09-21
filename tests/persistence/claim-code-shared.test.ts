/**
 * A code minted on one server instance must redeem on another.
 *
 * Found on prod: Vercel ran the mint and the redeem on different instances,
 * and the in-process store answered every redemption "invalid or expired".
 * Two backends over one database stand in for two instances.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLAIM_TTL_MS,
  mintClaimCode,
  pgClaimBackend,
  redeemClaimCode,
  setClaimBackendForTests,
} from '@/lib/persistence/claim-code';

let db: PGlite;
const pool = () => ({
  query: (text: string, params?: unknown[]) => db.query(text, params) as never,
});

beforeEach(async () => {
  db = new PGlite();
  await db.waitReady;
});

afterEach(async () => {
  setClaimBackendForTests(undefined);
  await db.close();
});

describe('claim codes shared through the database', () => {
  it('redeems on a different instance from the one that minted it', async () => {
    setClaimBackendForTests(pgClaimBackend(pool()));
    const { code } = await mintClaimCode('owner-A', 1_000);

    setClaimBackendForTests(pgClaimBackend(pool()));
    expect(await redeemClaimCode(code, 2_000)).toEqual({ owner: 'owner-A' });
  });

  it('lets a code be spent once across instances', async () => {
    setClaimBackendForTests(pgClaimBackend(pool()));
    const { code } = await mintClaimCode('owner-A', 1_000);

    const [first, second] = await Promise.all([
      pgClaimBackend(pool()).take(await digestOf(code)),
      pgClaimBackend(pool()).take(await digestOf(code)),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('refuses a code past its window', async () => {
    setClaimBackendForTests(pgClaimBackend(pool()));
    const { code } = await mintClaimCode('owner-A', 1_000);
    expect(await redeemClaimCode(code, 1_000 + CLAIM_TTL_MS)).toBeUndefined();
  });

  it('keeps only the hash in the table', async () => {
    setClaimBackendForTests(pgClaimBackend(pool()));
    const { code } = await mintClaimCode('owner-A', 1_000);
    const { rows } = await db.query<{ hash: string }>('SELECT hash FROM claim_codes');
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).not.toContain(code);
  });
});

async function digestOf(code: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const { canonicalClaimCode } = await import('@/lib/persistence/claim-code-format');
  return createHash('sha256').update(canonicalClaimCode(code), 'utf8').digest('hex');
}
