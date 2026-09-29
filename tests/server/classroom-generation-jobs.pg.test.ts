/**
 * `POST /api/generate-classroom` jobs on PostgreSQL: the record the poll route
 * answers with, and who may poll it. A job is its creator's: any other owner
 * gets the same 404 as an unknown id, and an anonymous creator that was
 * claimed into an account keeps it under that account.
 */
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { GenerateClassroomResult } from '@/lib/server/classroom-generation';
import {
  createClassroomGenerationJob,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  readClassroomGenerationJob,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_classroom_jobs_test';
const OWNER_COOKIE = '0b8c4f2e-6a1d-4e3f-8b9a-1c2d3e4f5a6b';
const OTHER_COOKIE = '9d7e5c3b-1a2f-4e6d-8c0b-7a6f5e4d3c2b';
const OWNER = `anon:${OWNER_COOKIE}`;
const INCOMPLETE_WARNING = 'TTS generation INCOMPLETE: 1 written, 2 speech actions left silent';

function classroomResult(extra: Partial<GenerateClassroomResult> = {}): GenerateClassroomResult {
  return {
    id: 'stage-cls1',
    url: 'http://localhost/classroom/stage-cls1',
    stage: { id: 'stage-cls1' } as GenerateClassroomResult['stage'],
    scenes: [],
    scenesCount: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
    ...extra,
  };
}

async function poll(jobId: string, cookie?: string) {
  const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');
  return GET(
    new NextRequest(`http://localhost/api/generate-classroom/${jobId}`, {
      headers: cookie ? { cookie: `anonymous_id=${cookie}` } : {},
    }),
    { params: Promise.resolve({ jobId }) },
  );
}

describe.skipIf(!contractUrl)('classroom generation jobs on PostgreSQL', () => {
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
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=classroom-jobs`;
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

  it('records progress and a succeeded result with partial TTS coverage', async () => {
    await createClassroomGenerationJob(
      'jobpg1',
      { requirement: 'Teach pacing' },
      { ownerId: OWNER },
    );
    const running = await markClassroomGenerationJobRunning('jobpg1');
    await updateClassroomGenerationJobProgress('jobpg1', {
      step: 'generating_scenes',
      progress: 40,
      message: 'Generated 1/2 scenes',
      scenesGenerated: 1,
      totalScenes: 2,
    });
    // A second start never moves the recorded start time.
    await markClassroomGenerationJobRunning('jobpg1');
    await markClassroomGenerationJobSucceeded(
      'jobpg1',
      classroomResult({ ttsCoverage: { written: 1, total: 3 }, warning: INCOMPLETE_WARNING }),
    );

    const job = await readClassroomGenerationJob('jobpg1', OWNER);
    expect(job).toMatchObject({
      status: 'succeeded',
      step: 'completed',
      progress: 100,
      message: INCOMPLETE_WARNING,
      totalScenes: 2,
      scenesGenerated: 2,
      startedAt: running.startedAt,
      result: {
        classroomId: 'stage-cls1',
        url: 'http://localhost/classroom/stage-cls1',
        scenesCount: 2,
        ttsCoverage: { written: 1, total: 3 },
        warning: INCOMPLETE_WARNING,
      },
    });
  });

  it('answers the creator on poll and 404s everyone else like an unknown id', async () => {
    await createClassroomGenerationJob(
      'jobpg2',
      { requirement: 'Teach pacing' },
      { ownerId: OWNER },
    );
    await markClassroomGenerationJobSucceeded(
      'jobpg2',
      classroomResult({ ttsCoverage: { written: 4, total: 4 } }),
    );

    const own = await poll('jobpg2', OWNER_COOKIE);
    expect(own.status).toBe(200);
    const body = await own.json();
    expect(body).toMatchObject({
      success: true,
      jobId: 'jobpg2',
      status: 'succeeded',
      done: true,
      message: 'Classroom generation completed',
      result: { classroomId: 'stage-cls1', ttsCoverage: { written: 4, total: 4 } },
    });
    expect(body.result).not.toHaveProperty('warning');

    const foreign = await poll('jobpg2', OTHER_COOKIE);
    const unknown = await poll('jobpg-missing', OTHER_COOKIE);
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    await expect(foreign.json()).resolves.toEqual(await unknown.json());

    // A first-time poller is minted an owner, and still sees nothing.
    const fresh = await poll('jobpg2');
    expect(fresh.status).toBe(404);
    expect(fresh.headers.get('set-cookie')).toMatch(/anonymous_id=/);
  });

  it('follows a claim: the account the creator was claimed into sees the job', async () => {
    await createClassroomGenerationJob(
      'jobpg3',
      { requirement: 'Teach pacing' },
      { ownerId: OWNER },
    );
    await pool.query('INSERT INTO owner_merges (from_owner_id, to_owner_id) VALUES ($1, $2)', [
      OWNER,
      'user:alice',
    ]);
    try {
      await expect(readClassroomGenerationJob('jobpg3', 'user:alice')).resolves.toMatchObject({
        id: 'jobpg3',
      });
      await expect(readClassroomGenerationJob('jobpg3', 'user:bob')).resolves.toBeNull();
    } finally {
      await pool.query('DELETE FROM owner_merges WHERE from_owner_id = $1', [OWNER]);
    }
  });
});
