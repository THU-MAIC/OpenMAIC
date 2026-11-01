import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { StageAccessError } from '@/lib/persistence/stage-meta';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

function courseDocument(id: string, name = 'Agent course') {
  const now = 1_800_000_000_000;
  return {
    stage: { id, name, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function ownerStore(pool: PGlitePool, ownerId: string) {
  return createOwnerBoundDocumentStore({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

/** A single row read back from stage_meta after a delete. */
interface StageMetaTombstoneRow {
  deleted_at: string | Date | null;
}

describe('reference-fidelity stage access', () => {
  let pool: PGlitePool;
  const ownerCookie = '11111111-1111-4111-8111-111111111111';
  const visitorCookie = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://stage-access-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('loads an agent-created stage through the browser path using the same owner cookie', async () => {
    const connectionString = process.env.DATABASE_URL!;
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const provider = await getServerPersistenceProvider(connectionString, () => pool as never);
    const stageId = 'stage-agent-browser-regression';
    await ownerStore(pool, `anon:${ownerCookie}`).saveDocument(courseDocument(stageId));

    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const response = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${stageId}`, {
        headers: { cookie: `anonymous_id=${ownerCookie}` },
      }),
      { poolFactory: () => pool as never },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ stage: { id: stageId } });
    expect(provider.pool).toBe(pool);
  });

  it('allows capability reads, refuses foreign writes, and filters the owner library', async () => {
    const connectionString = process.env.DATABASE_URL!;
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(connectionString, () => pool as never);
    const stageId = 'stage-capability-policy';
    const owner = ownerStore(pool, `anon:${ownerCookie}`);
    const visitor = ownerStore(pool, `anon:${visitorCookie}`);
    await owner.saveDocument(courseDocument(stageId));

    await expect(visitor.loadDocument(stageId)).resolves.toMatchObject({ stage: { id: stageId } });
    await expect(
      visitor.saveDocument(courseDocument(stageId, 'Foreign edit')),
    ).rejects.toBeInstanceOf(StageAccessError);
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const visitorRead = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${stageId}`, {
        headers: { cookie: `anonymous_id=${visitorCookie}` },
      }),
      { poolFactory: () => pool as never },
    );
    expect(visitorRead.status).toBe(200);
    await expect(visitorRead.json()).resolves.toMatchObject({ stage: { id: stageId } });

    const foreignWrite = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${stageId}`, {
        method: 'PUT',
        headers: {
          cookie: `anonymous_id=${visitorCookie}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(courseDocument(stageId, 'Foreign edit')),
      }),
      { poolFactory: () => pool as never },
    );
    expect(foreignWrite.status).toBe(403);
    await expect(foreignWrite.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN_DOCUMENTS' },
    });

    const { GET: listStages } = await import('@/app/api/stages/route');
    const ownerList = await listStages(
      new NextRequest('http://localhost/api/stages', {
        headers: { cookie: `anonymous_id=${ownerCookie}` },
      }),
    );
    const visitorList = await listStages(
      new NextRequest('http://localhost/api/stages', {
        headers: { cookie: `anonymous_id=${visitorCookie}` },
      }),
    );
    await expect(ownerList.json()).resolves.toMatchObject({
      stages: [expect.objectContaining({ id: stageId })],
    });
    await expect(visitorList.json()).resolves.toEqual({ stages: [] });
  });

  it('loadStage reads the stage row alone, behind the same gate as loadDocument', async () => {
    const connectionString = process.env.DATABASE_URL!;
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(connectionString, () => pool as never);
    const stageId = 'stage-row-read';
    const owner = ownerStore(pool, `anon:${ownerCookie}`);
    const visitor = ownerStore(pool, `anon:${visitorCookie}`);
    const course = courseDocument(stageId);
    const now = course.stage.createdAt;
    await owner.saveDocument({
      ...course,
      stage: {
        ...course.stage,
        agentIds: ['gen-t'],
        generatedAgentConfigs: [
          {
            id: 'gen-t',
            name: 'Teacher Chen',
            role: 'teacher',
            persona: '',
            avatar: '/avatars/teacher.png',
            color: '#000000',
            priority: 10,
          },
        ],
      },
      scenes: [
        {
          id: 'scene-1',
          stageId,
          type: 'slide',
          title: 'One',
          order: 0,
          content: {
            type: 'slide',
            canvas: {
              id: 'c',
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: '' },
              elements: [],
            },
          },
          createdAt: now,
          updatedAt: now,
        },
      ],
    } as never);

    const full = await owner.loadDocument(stageId);
    const queries: string[] = [];
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await connect();
      return {
        ...client,
        query: (text: string, params?: unknown[]) => {
          queries.push(text);
          return client.query(text, params);
        },
      };
    };
    const stage = await owner.loadStage(stageId);
    expect(stage).toEqual(full!.stage);
    expect(stage).toMatchObject({ agentIds: ['gen-t'] });
    expect(queries.some((text) => /FROM document_stages/.test(text))).toBe(true);
    expect(queries.some((text) => /document_scenes|document_outlines/.test(text))).toBe(false);

    // Same answers as loadDocument: capability reads by id, null when absent
    // or retired.
    await expect(visitor.loadStage(stageId)).resolves.toEqual(
      (await visitor.loadDocument(stageId))!.stage,
    );
    await expect(owner.loadStage('stage-absent')).resolves.toBeNull();
    await expect(owner.loadStage('bad\u0000id')).resolves.toBeNull();
    await owner.deleteDocument(stageId);
    await expect(owner.loadStage(stageId)).resolves.toBeNull();
  });

  it('tombstones deletions and permanently retires the stage id', async () => {
    const connectionString = process.env.DATABASE_URL!;
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(connectionString, () => pool as never);
    const stageId = 'stage-retired-id';
    const owner = ownerStore(pool, `anon:${ownerCookie}`);
    await owner.saveDocument(courseDocument(stageId));
    await owner.deleteDocument(stageId);

    await expect(owner.loadDocument(stageId)).resolves.toBeNull();
    await expect(
      owner.saveDocument(courseDocument(stageId, 'Resurrection')),
    ).rejects.toBeInstanceOf(StageAccessError);
    const rows = await pool.query(
      `SELECT meta.deleted_at
         FROM stage_meta AS meta
         JOIN document_stages AS stages ON stages.id = meta.stage_id
        WHERE meta.stage_id = $1`,
      [stageId],
    );
    expect((rows.rows[0] as StageMetaTombstoneRow | undefined)?.deleted_at).not.toBeNull();
  });
});
