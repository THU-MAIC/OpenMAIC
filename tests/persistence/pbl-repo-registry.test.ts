import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  ensurePBLRepoRegistrySchema,
  findRepoByFullName,
  findRepoByOwnerStage,
  upsertPBLRepo,
  type UpsertPBLRepoInput,
} from '@/lib/persistence/pbl-repo-registry';

/** The node-postgres pool surface, backed by the single-connection PGlite. */
class PGlitePool {
  readonly statements: string[] = [];

  constructor(readonly db: PGlite) {}

  query<TRow>(text: string, params?: unknown[]) {
    this.statements.push(text);
    return this.db.query<TRow>(text, params);
  }

  async connect() {
    return {
      query: <TRow>(text: string, params?: unknown[]) => {
        this.statements.push(text);
        return this.db.query<TRow>(text, params);
      },
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const input = (overrides: Partial<UpsertPBLRepoInput> = {}): UpsertPBLRepoInput => ({
  ownerId: 'owner-1',
  stageId: 'stage-1',
  giteaUsername: 'stu-abc12345',
  repoFullName: 'stu-abc12345/arkts-pbl',
  cloneUrl: 'http://gitea/stu-abc12345/arkts-pbl.git',
  htmlUrl: 'http://gitea/stu-abc12345/arkts-pbl',
  token: 'learner-token',
  tokenLastEight: 'token',
  ...overrides,
});

describe('pbl repo registry', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    await ensurePBLRepoRegistrySchema(db);
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    await pool.end();
  });

  it('fences the write with the per-owner identity lock before inserting', async () => {
    await upsertPBLRepo(pool as unknown as ConnectableQueryable, input());

    const lockIndex = pool.statements.findIndex((statement) =>
      statement.includes('pg_advisory_xact_lock_shared'),
    );
    const insertIndex = pool.statements.findIndex((statement) =>
      statement.includes('INSERT INTO pbl_repo_registry'),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(lockIndex);
  });

  it('inserts and resolves by owner+stage and by full name', async () => {
    await upsertPBLRepo(pool as unknown as ConnectableQueryable, input());

    const byOwner = await findRepoByOwnerStage(pool as unknown as Queryable, 'owner-1', 'stage-1');
    expect(byOwner?.repoFullName).toBe('stu-abc12345/arkts-pbl');
    expect(byOwner?.token).toBe('learner-token');

    const byFullName = await findRepoByFullName(
      pool as unknown as Queryable,
      'stu-abc12345/arkts-pbl',
    );
    expect(byFullName?.ownerId).toBe('owner-1');
  });

  it('is idempotent: a second upsert returns the first row and never overwrites', async () => {
    const first = await upsertPBLRepo(pool as unknown as ConnectableQueryable, input());
    const second = await upsertPBLRepo(
      pool as unknown as ConnectableQueryable,
      input({ cloneUrl: 'http://gitea/DIFFERENT.git' }),
    );

    expect(second.cloneUrl).toBe(first.cloneUrl);

    const rows = await pool.query<{ owner_id: string }>('SELECT owner_id FROM pbl_repo_registry');
    expect(rows.rows).toHaveLength(1);
  });

  it('returns null for unknown lookups', async () => {
    expect(
      await findRepoByOwnerStage(pool as unknown as Queryable, 'owner-1', 'stage-1'),
    ).toBeNull();
    expect(await findRepoByFullName(pool as unknown as Queryable, 'x/y')).toBeNull();
  });

  it('keeps one fork per project: one owner enrolling two stages gets two distinct repos', async () => {
    // Regression: the provisioning used to yield the same repo_full_name for
    // every stage a learner enrolled, tripping the UNIQUE constraint (enroll
    // 500). Per-project accounts give distinct full names; each (owner, stage)
    // must persist and resolve independently.
    const firstName = 'stu-abc12345-11111111';
    const secondName = 'stu-abc12345-22222222';
    const first = await upsertPBLRepo(
      pool as unknown as ConnectableQueryable,
      input({
        stageId: 'stage-1',
        giteaUsername: firstName,
        repoFullName: `${firstName}/arkts-pbl`,
      }),
    );
    const second = await upsertPBLRepo(
      pool as unknown as ConnectableQueryable,
      input({
        stageId: 'stage-2',
        giteaUsername: secondName,
        repoFullName: `${secondName}/arkts-pbl`,
      }),
    );

    expect(first.repoFullName).not.toBe(second.repoFullName);
    expect(
      (await findRepoByOwnerStage(pool as unknown as Queryable, 'owner-1', 'stage-1'))
        ?.repoFullName,
    ).toBe(`${firstName}/arkts-pbl`);
    expect(
      (await findRepoByOwnerStage(pool as unknown as Queryable, 'owner-1', 'stage-2'))
        ?.repoFullName,
    ).toBe(`${secondName}/arkts-pbl`);

    const rows = await pool.query<{ owner_id: string }>('SELECT owner_id FROM pbl_repo_registry');
    expect(rows.rows).toHaveLength(2);
  });
});
