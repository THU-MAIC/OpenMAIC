/**
 * The custom agent store on a real PostgreSQL: its migration, the owner
 * scoping of every read and write, the per-owner limit under concurrent
 * creates (the case PGlite cannot run in parallel), and the claim step.
 *
 * Works in a schema of its own, so it shares nothing with the other suites on
 * the contract database.
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MAX_CUSTOM_AGENTS, type CustomAgent } from '@/lib/orchestration/registry/schema';
import {
  createOwnerAgent,
  deleteOwnerAgent,
  ensureOwnerAgentSchema,
  importOwnerAgents,
  listOwnerAgents,
  OwnerAgentExistsError,
  OwnerAgentLimitError,
  readOwnerAgents,
  rekeyOwnerAgents,
  updateOwnerAgent,
} from '@/lib/server/agents/store';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_owner_agents_test';

function agent(id: string, name = `Agent ${id}`): CustomAgent {
  return {
    id,
    name,
    role: 'student',
    persona: 'Asks good questions.',
    avatar: '/avatars/curious.png',
    color: '#ec4899',
    allowedActions: [],
    priority: 5,
  };
}

describe.skipIf(!contractUrl)('custom agents on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  const queryable = () => pool as unknown as ConnectableQueryable;

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${TEST_SCHEMA}`,
      max: 12,
    });
    await ensureOwnerAgentSchema(queryable());
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE owner_agents');
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  it('records its migration once, and a second start changes nothing', async () => {
    await ensureOwnerAgentSchema(queryable());
    const recorded = await pool.query(
      `SELECT version, name FROM openmaic_schema_migrations WHERE store = 'owner-agents'`,
    );
    expect(recorded.rows).toEqual([{ version: 1, name: 'baseline' }]);
  });

  it('keeps every read and write to the owner', async () => {
    await createOwnerAgent(queryable(), 'user:alice', agent('tutor'));
    await createOwnerAgent(queryable(), 'user:bob', agent('tutor', 'Bob tutor'));
    await expect(
      createOwnerAgent(queryable(), 'user:alice', agent('tutor')),
    ).rejects.toBeInstanceOf(OwnerAgentExistsError);

    const updated = await updateOwnerAgent(queryable(), 'user:alice', agent('tutor', 'Renamed'));
    expect(updated.agent.name).toBe('Renamed');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.createdAt.getTime());

    expect((await listOwnerAgents(queryable(), 'user:bob'))[0]!.agent.name).toBe('Bob tutor');
    expect(
      (await readOwnerAgents(queryable(), 'user:alice', ['tutor', 'ghost'])).map((s) => s.agent),
    ).toEqual([agent('tutor', 'Renamed')]);

    expect(await deleteOwnerAgent(queryable(), 'user:alice', 'tutor')).toBe(true);
    expect(await deleteOwnerAgent(queryable(), 'user:alice', 'tutor')).toBe(false);
    expect(await listOwnerAgents(queryable(), 'user:bob')).toHaveLength(1);
  });

  it('holds the limit when creates race', async () => {
    await importOwnerAgents(
      queryable(),
      'user:alice',
      Array.from({ length: MAX_CUSTOM_AGENTS - 3 }, (_, index) => agent(`seed-${index}`)),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        createOwnerAgent(queryable(), 'user:alice', agent(`race-${index}`)),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(OwnerAgentLimitError);
    }
    expect(await listOwnerAgents(queryable(), 'user:alice')).toHaveLength(MAX_CUSTOM_AGENTS);
  });

  it('imports idempotently', async () => {
    const first = await importOwnerAgents(queryable(), 'user:alice', [agent('a'), agent('b')]);
    const second = await importOwnerAgents(queryable(), 'user:alice', [agent('a'), agent('b')]);
    expect(first).toEqual({ imported: ['a', 'b'], skipped: [] });
    expect(second).toEqual({
      imported: [],
      skipped: [
        { id: 'a', reason: 'exists' },
        { id: 'b', reason: 'exists' },
      ],
    });
  });

  it('moves an anonymous owner’s agents on a claim, keeping the account’s own', async () => {
    const anon = 'anon:0b5a3f4e-8c1d-4e2f-9a3b-1c2d3e4f5a6b';
    await createOwnerAgent(queryable(), anon, agent('mine'));
    await createOwnerAgent(queryable(), anon, agent('shared', 'Anonymous shared'));
    await createOwnerAgent(queryable(), 'user:alice', agent('shared', 'Account shared'));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await rekeyOwnerAgents(client, anon, 'user:alice')).toBe(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(await listOwnerAgents(queryable(), anon)).toEqual([]);
    expect(
      (await listOwnerAgents(queryable(), 'user:alice'))
        .map((stored) => [stored.agent.id, stored.agent.name])
        .sort(),
    ).toEqual([
      ['mine', 'Agent mine'],
      ['shared', 'Account shared'],
    ]);
  });
});
