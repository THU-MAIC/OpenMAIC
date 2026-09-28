/**
 * Claiming anonymous work into an account, on PGlite. The same scenarios run
 * on PostgreSQL in the `.pg` suite, which adds the concurrency cases.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import {
  atomicityScenario,
  bootClaimHarness,
  claimRulesScenario,
  forwardingScenario,
  fullClaimScenario,
  type ClaimHarness,
  type ClaimScenarioPool,
} from './_owner-claim-scenarios';

class PGlitePool implements ClaimScenarioPool {
  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {}
}

describe('claiming anonymous work (PGlite)', () => {
  let db: PGlite;
  let harness: ClaimHarness;

  beforeEach(async () => {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const databaseUrl = `postgres://owner-claims-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    db = new PGlite();
    await db.waitReady;
    harness = await bootClaimHarness(new PGlitePool(db), databaseUrl);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  it('re-keys every participant and leaves nothing under the anonymous owner', async () => {
    await fullClaimScenario(harness);
  });

  it('keeps nothing when a participant throws mid-claim', async () => {
    await atomicityScenario(harness);
  });

  it('is idempotent and refuses sources, targets and chains the rules exclude', async () => {
    await claimRulesScenario(harness);
  });

  it('refuses a stale request and forwards background work', async () => {
    await forwardingScenario(harness);
  });
});
