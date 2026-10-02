/**
 * A session id is taken whoever holds it and whatever state its course is in.
 * A course's tombstone hides its runtime sessions from reads, so the handler's
 * read-before-create cannot see such a holder; the answer must still be the
 * uniform `409 SESSION_ALREADY_EXISTS`, classified from the real unique
 * violation PostgreSQL raises, not a 500.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_runtime_tombstone_collision_test';
const ALICE_COOKIE = '11111111-1111-4111-8111-111111111111';
const ALICE = `anon:${ALICE_COOKIE}`;
const NOW = 1_800_000_000_000;
const ISO = new Date(NOW).toISOString();

describe.skipIf(!contractUrl)('runtime session id collisions across a tombstone', () => {
  let admin: Pool;
  let pool: Pool;
  const previousEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ASSET_S3_BUCKET: process.env.ASSET_S3_BUCKET,
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=tombstone-collision`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    await getServerPersistenceProvider(databaseUrl, () => pool);
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  async function call(path: string, method: string, body?: unknown): Promise<Response> {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return handlePersistenceRequest(
      new Request(`http://localhost/api/persistence${path}`, {
        method,
        headers: { cookie: `anonymous_id=${ALICE_COOKIE}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { poolFactory: () => pool },
    );
  }

  const session = (stageId: string) => ({
    id: 'session-held',
    stageId,
    learnerKey: ALICE,
    kind: 'chat',
    status: 'active',
    createdAt: ISO,
    updatedAt: ISO,
  });

  it('answers 409, not 500, when the holder is hidden by its course tombstone', async () => {
    const saved = await call('/documents/stage-deleted', 'PUT', {
      stage: { id: 'stage-deleted', name: 'Deleted', createdAt: NOW, updatedAt: NOW },
      scenes: [],
      outline: {
        outlines: [],
        requirement: 'Deleted',
        generationComplete: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    expect(saved.status).toBeLessThan(300);
    expect((await call('/runtime/sessions', 'POST', session('stage-deleted'))).status).toBe(201);
    expect((await call('/documents/stage-deleted', 'DELETE')).status).toBeLessThan(300);
    expect((await call('/runtime/sessions/session-held', 'GET')).status).toBe(404);

    const collided = await call('/runtime/sessions', 'POST', session('stage-live'));

    expect(collided.status).toBe(409);
    await expect(collided.json()).resolves.toMatchObject({
      error: { code: 'SESSION_ALREADY_EXISTS' },
    });
    const rows = await pool.query('SELECT stage_id FROM runtime_sessions WHERE id = $1', [
      'session-held',
    ]);
    expect(rows.rows).toEqual([{ stage_id: 'stage-deleted' }]);
  });
});
