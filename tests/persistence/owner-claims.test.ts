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
  materialFolderClaimScenario,
  unfiledOnlyMaterialClaimScenario,
  emptyFoldersOnlyMaterialClaimScenario,
  selfReassignMaterialFoldersScenario,
  materialFolderAtomicityScenario,
  rootedMaterialClaimScenario,
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

  it('moves material folders by the course-folder rules, filed and Unfiled materials alike', async () => {
    await materialFolderClaimScenario(harness);
  });

  it('moves an owner that has Unfiled materials only', async () => {
    await unfiledOnlyMaterialClaimScenario(harness);
  });

  it('moves an owner that has empty material folders only', async () => {
    await emptyFoldersOnlyMaterialClaimScenario(harness);
  });

  it('leaves a library reassigned onto its own owner unchanged', async () => {
    await selfReassignMaterialFoldersScenario(harness);
  });

  it('keeps both material libraries as they were when the claim fails', async () => {
    await materialFolderAtomicityScenario(harness);
  });

  it('keeps a material s reference root and re-keys its asset', async () => {
    await rootedMaterialClaimScenario(harness);
  });
});
