/**
 * PGlite contract for the PostgreSQL user-skill backend.
 *
 * Mirrors the agent-session backend's PGlite harness: the real pinned DDL, the
 * real store, and the pure validation/patch logic imported from the package
 * types module — so the CHECK constraints, the `updated_at` write and the
 * at-least-once duplicate/retry semantics are exercised against a real database
 * rather than a fake of the query builder.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_USER_SKILL_TABLE_NAMES,
  PgUserSkillStore,
  ensureUserSkillSchema,
  type PgUserSkillStoreOptions,
  type Queryable,
} from '../src/skill/pg.js';
import { USER_SKILL_LIMIT, UserSkillError, applyUserSkillPatchOps } from '../src/skill/types.js';

function optionsFor(db: PGlite): PgUserSkillStoreOptions {
  return { withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)) };
}

const OWNER = 'owner-1';
const input = (name: string) => ({
  name,
  title: `Title ${name}`,
  description: `Description for ${name}`,
  content: `Instructions for ${name}`,
});

describe('PgUserSkillStore with PGlite', () => {
  let db: PGlite;
  let store: PgUserSkillStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureUserSkillSchema(db);
    store = new PgUserSkillStore(db, optionsFor(db));
  });

  afterEach(async () => {
    await db.close();
  });

  test('provisions the table and both indexes idempotently', async () => {
    await expect(ensureUserSkillSchema(db)).resolves.toBeUndefined();
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [Object.values(DEFAULT_USER_SKILL_TABLE_NAMES)],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      Object.values(DEFAULT_USER_SKILL_TABLE_NAMES).sort(),
    );
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'agent_user_skill' ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
      'agent_user_skill_owner_name_unique',
      'agent_user_skill_pkey',
      'idx_agent_user_skill_owner',
    ]);
  });

  test('create, list and find round-trip a record with normalized fields', async () => {
    const created = await store.create(OWNER, input('my-method'));
    expect(created).toMatchObject({
      id: created.id,
      ownerId: OWNER,
      name: 'my-method',
      version: 1,
    });
    expect(created.id).toMatch(/^usk_/);
    expect(await store.find(created.id, OWNER)).toEqual(created);
    expect(await store.list(OWNER)).toEqual([created]);
    expect(await store.findByRef(OWNER, created.id)).toEqual(created);
    expect(await store.findByRef(OWNER, 'my-method')).toEqual(created);
    expect(await store.findByRef(OWNER, '/my-method')).toEqual(created);
    // Handles are case-insensitive at lookup.
    expect(await store.findByRef(OWNER, '/MY-METHOD')).toMatchObject({ id: created.id });
  });

  test('isolates owners: a foreign row is invisible and unaddressable', async () => {
    const mine = await store.create(OWNER, input('my-shared'));
    await store.create('owner-2', input('my-shared'));
    expect(await store.find(mine.id, 'owner-2')).toBeNull();
    expect(await store.findByRef('owner-2', mine.id)).toBeNull();
    // The same handle under another owner is a DIFFERENT row, not an error.
    expect(await store.findByRef('owner-2', 'my-shared')).toMatchObject({ ownerId: 'owner-2' });
  });

  test('deduplicates an identical at-least-once retry and refuses a conflicting duplicate', async () => {
    const first = await store.create(OWNER, input('my-method'));
    // Identical content: the same create request redelivered — same receipt.
    await expect(store.create(OWNER, input('my-method'))).resolves.toMatchObject({
      id: first.id,
    });
    await expect(store.list(OWNER)).resolves.toHaveLength(1);
    // Conflicting content under a taken handle: a hard duplicate error.
    const conflict = { ...input('my-method'), content: 'different instructions' };
    const caught = await store.create(OWNER, conflict).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(UserSkillError);
    expect((caught as UserSkillError).code).toBe('duplicate');
    await expect(store.list(OWNER)).resolves.toHaveLength(1);
  });

  test('soft-deletes only the owner row and excludes its tombstone from every read path', async () => {
    const deleted = await store.create(OWNER, input('my-deleted'));
    const kept = await store.create(OWNER, input('my-kept'));

    await expect(store.delete(OWNER, deleted.id)).resolves.toBeUndefined();
    await expect(store.find(deleted.id, OWNER)).resolves.toBeNull();
    await expect(store.findByRef(OWNER, deleted.id)).resolves.toBeNull();
    await expect(store.findByRef(OWNER, deleted.name)).resolves.toBeNull();
    await expect(store.list(OWNER)).resolves.toEqual([kept]);

    const row = await db.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM agent_user_skill WHERE id = $1',
      [deleted.id],
    );
    expect(row.rows[0]!.deleted_at).not.toBeNull();
  });

  test('delete makes absent, foreign and already-deleted refs indistinguishable', async () => {
    const foreign = await store.create('owner-2', input('my-private'));
    const mine = await store.create(OWNER, input('my-once'));
    await store.delete(OWNER, mine.id);

    for (const ref of [foreign.id, 'usk_missing', mine.id]) {
      const caught = await store.delete(OWNER, ref).then(
        () => null,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(UserSkillError);
      expect((caught as UserSkillError).code).toBe('not-found');
      expect((caught as UserSkillError).message).not.toContain('owner-2');
    }
    await expect(store.find(foreign.id, 'owner-2')).resolves.toEqual(foreign);
  });

  test('a deleted handle can be reused because uniqueness and quota count only live rows', async () => {
    const first = await store.create(OWNER, input('my-reusable'));
    await store.delete(OWNER, first.id);
    const replacement = await store.create(OWNER, {
      ...input('my-reusable'),
      content: 'Replacement instructions',
    });

    expect(replacement.id).not.toBe(first.id);
    await expect(store.findByRef(OWNER, 'my-reusable')).resolves.toEqual(replacement);
    await expect(store.list(OWNER)).resolves.toEqual([replacement]);
  });

  test('patch sees a deleted Skill as not-found', async () => {
    const skill = await store.create(OWNER, input('my-gone'));
    await store.delete(OWNER, skill.id);
    await expect(
      store.patch(OWNER, skill.id, [{ op: 'set', path: '/title', value: 'Too late' }]),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  test('enforces the exact 50-Skill owner quota', async () => {
    for (let index = 0; index < USER_SKILL_LIMIT; index += 1) {
      await store.create(OWNER, input(`my-skill-${index}`));
    }
    const caught = await store.create(OWNER, input('my-over-limit')).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(UserSkillError);
    expect((caught as UserSkillError).code).toBe('quota');
  });

  test('serializes the quota check-and-insert with a per-owner advisory lock', async () => {
    const statements: string[] = [];
    const recording: PgUserSkillStoreOptions = {
      withTransaction: (body) =>
        db.transaction(async (tx) => {
          const proxy: Queryable = {
            query: async (sql: string, params?: unknown[]) => {
              statements.push(sql);
              return tx.query(sql, params);
            },
          };
          return body(proxy);
        }),
    };
    const recordingStore = new PgUserSkillStore(db, recording);
    await recordingStore.create(OWNER, input('my-locked'));
    expect(statements.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  test('an at-least-once retry still returns its receipt at the exact quota boundary', async () => {
    for (let index = 0; index < USER_SKILL_LIMIT - 1; index += 1) {
      await store.create(OWNER, input(`my-skill-${index}`));
    }
    // The 50th row lands via this create...
    const fiftieth = await store.create(OWNER, input('my-last-slot'));
    await expect(store.list(OWNER)).resolves.toHaveLength(USER_SKILL_LIMIT);
    // ...and an identical redelivery of that same create must NOT surface as a
    // quota error: the same-name idempotency check runs before the count check.
    await expect(store.create(OWNER, input('my-last-slot'))).resolves.toMatchObject({
      id: fiftieth.id,
    });
    await expect(store.list(OWNER)).resolves.toHaveLength(USER_SKILL_LIMIT);
  });

  test('rejects invalid input before any write', async () => {
    for (const bad of [
      { ...input('my-method'), name: 'not-my-prefixed' },
      { ...input('my-method'), name: 'my-bad--name' },
      { ...input('my-method'), title: '' },
      { ...input('my-method'), content: '' },
      { ...input('my-method'), content: 'a'.repeat(65_537) },
    ]) {
      await expect(store.create(OWNER, bad)).rejects.toBeInstanceOf(UserSkillError);
    }
    await expect(store.list(OWNER)).resolves.toHaveLength(0);
  });

  test("create shares the patch path's storability gate: NUL and lone surrogates never reach PG", async () => {
    // The create path must refuse these BEFORE the database, with the same
    // codes the patch path uses — not as an opaque PG error (NUL) or a silent
    // U+FFFD rewrite (lone surrogate).
    const nul = await store.create(OWNER, { ...input('my-nul'), content: 'a\u0000b' }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(nul).toBeInstanceOf(UserSkillError);
    expect((nul as UserSkillError).code).toBe('unstorable-character');

    const lone = await store.create(OWNER, { ...input('my-lone'), content: 'a\ud800b' }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(lone).toBeInstanceOf(UserSkillError);
    expect((lone as UserSkillError).code).toBe('unpaired-surrogate');

    // Nothing was persisted: the table is still empty.
    await expect(store.list(OWNER)).resolves.toHaveLength(0);
  });

  test('patch persists a str_replace, advances updated_at, and reports applied ops', async () => {
    const skill = await store.create(OWNER, {
      ...input('my-method'),
      content: 'alpha beta gamma',
    });
    const outcome = await store.patch(OWNER, skill.id, [
      { op: 'str_replace', path: '/content', oldText: 'beta', newText: 'BETA' },
    ]);
    expect(outcome.changed).toBe(true);
    expect(outcome.applied).toEqual([{ op: 'str_replace', path: '/content', status: 'applied' }]);
    expect(outcome.skill.content).toBe('alpha BETA gamma');
    expect(outcome.skill.updatedAt.getTime()).toBeGreaterThanOrEqual(skill.updatedAt.getTime());

    // Replay: the anchor is gone and the replacement is present — success, no write.
    const replay = await store.patch(OWNER, skill.id, [
      { op: 'str_replace', path: '/content', oldText: 'beta', newText: 'BETA' },
    ]);
    expect(replay.changed).toBe(false);
    expect(replay.applied[0]!.status).toBe('already-applied');
    expect(replay.skill.updatedAt.getTime()).toBe(outcome.skill.updatedAt.getTime());
  });

  test('patch is atomic: a failing op writes nothing', async () => {
    const skill = await store.create(OWNER, input('my-method'));
    await expect(
      store.patch(OWNER, skill.id, [
        { op: 'set', path: '/title', value: 'New title' },
        { op: 'str_replace', path: '/content', oldText: 'missing anchor', newText: 'x' },
      ]),
    ).rejects.toBeInstanceOf(UserSkillError);
    const reread = await store.find(skill.id, OWNER);
    expect(reread?.title).toBe(`Title my-method`);
    expect(reread?.content).toBe(`Instructions for my-method`);
  });

  test('patch refuses a batch that is not a fixpoint, and validates the result', async () => {
    const skill = await store.create(OWNER, { ...input('my-method'), content: 'a' });
    const doubling = [
      { op: 'str_replace', path: '/content', oldText: 'a', newText: 'b', replaceAll: true },
      { op: 'str_replace', path: '/content', oldText: 'b', newText: 'aa', replaceAll: true },
    ];
    await expect(store.patch(OWNER, skill.id, doubling)).rejects.toMatchObject({
      code: 'batch-not-idempotent',
    });
    const oversized = [{ op: 'set', path: '/content', value: '中'.repeat(21_846) }];
    await expect(store.patch(OWNER, skill.id, oversized)).rejects.toMatchObject({
      code: 'invalid-content',
    });
    await expect(store.find(skill.id, OWNER)).resolves.toMatchObject({ content: 'a' });
  });

  test('patch reports not-found for an absent or foreign ref, without a hint', async () => {
    const foreign = await store.create('owner-2', input('my-private'));
    const caught = await store
      .patch(OWNER, foreign.id, [{ op: 'set', path: '/title', value: 'hijacked' }])
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(caught).toBeInstanceOf(UserSkillError);
    const error = caught as UserSkillError;
    expect(error.code).toBe('not-found');
    expect(error.message).not.toContain('owner-2');
  });

  test('supports a table-name override with its own DDL', async () => {
    const names = { skills: 'custom_agent_user_skill' };
    await ensureUserSkillSchema(db, names);
    const renamed = new PgUserSkillStore(db, { ...optionsFor(db), tableNames: names });
    const created = await renamed.create(OWNER, input('my-custom'));
    expect((await renamed.find(created.id, OWNER))?.name).toBe('my-custom');
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'custom_agent_user_skill'`,
    );
    expect(tables.rows).toHaveLength(1);
  });

  test('requires a correctly pinned transaction hook', () => {
    expect(() => new PgUserSkillStore(db, {} as PgUserSkillStoreOptions)).toThrow(
      /withTransaction.*fresh.*connection.*transaction/i,
    );
  });

  test('the pure patch logic is reachable from the package root', () => {
    const { fields } = applyUserSkillPatchOps(
      { title: 'T', description: 'D', content: 'alpha beta' },
      [{ op: 'str_replace', path: '/content', oldText: 'alpha', newText: 'ALPHA' }],
    );
    expect(fields.content).toBe('ALPHA beta');
  });
});
