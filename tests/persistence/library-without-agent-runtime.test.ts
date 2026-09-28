import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerAuthMethod } from '@/lib/server/identity/types';

/**
 * The course library and folders need server persistence (a DATABASE_URL),
 * not the agent runtime. This suite drives the REAL routes, the real
 * owner-bound store, the real feature flags and the real owner identity seam
 * against an in-memory PostgreSQL, once with the agent runtime off and once
 * with it on, and requires the same outcome from both.
 */

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

/** A host method that signs in a publisher on one header; anyone else stays anonymous. */
const PUBLISHER_HEADER = 'x-test-publisher';
const publisherMethod: OwnerAuthMethod = {
  name: 'test-publisher',
  authenticate: async (req) =>
    req.headers.get(PUBLISHER_HEADER) === 'alice'
      ? {
          status: 'authenticated',
          principal: {
            ownerId: 'user:alice',
            kind: 'user',
            roles: new Set(['course:publish']),
            assurance: 'verified',
          },
        }
      : { status: 'not-applicable' },
};

const asPublisher = { [PUBLISHER_HEADER]: 'alice' };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function jsonRequest(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { ...asPublisher, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe.each([
  ['off', undefined],
  ['on', 'true'],
])('course library with the agent runtime %s', (_label, runtimeFlag) => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://library-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', runtimeFlag ?? '');
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    const { configureOwnerAuthentication } = await import('@/lib/server/identity');
    configureOwnerAuthentication({ methods: [publisherMethod] });
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('reports the runtime state and server persistence through the probe', async () => {
    const { GET } = await import('@/app/api/agent/runtime/route');
    await expect((await GET()).json()).resolves.toEqual({
      enabled: runtimeFlag === 'true',
      runtimeEnabled: runtimeFlag === 'true',
      persistence: true,
    });
  });

  it('lists an empty library for a new anonymous visitor and mints its owner cookie', async () => {
    const { GET } = await import('@/app/api/stages/route');
    const response = await GET(new NextRequest('http://localhost/api/stages'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ stages: [] });
    expect(response.headers.get('set-cookie')).toMatch(/anonymous_id=/);
  });

  it('creates, files, reads, syncs, publishes and deletes courses and folders', async () => {
    const stages = await import('@/app/api/stages/route');
    const stage = await import('@/app/api/stages/[id]/route');
    const manifest = await import('@/app/api/stages/[id]/manifest/route');
    const scenes = await import('@/app/api/stages/[id]/scenes/route');
    const freshness = await import('@/app/api/stages/[id]/freshness/route');
    const status = await import('@/app/api/stages/[id]/status/route');
    const generationComplete = await import('@/app/api/stages/[id]/generation-complete/route');
    const publish = await import('@/app/api/stages/[id]/publish/route');
    const unpublish = await import('@/app/api/stages/[id]/unpublish/route');
    const folders = await import('@/app/api/folders/route');
    const folder = await import('@/app/api/folders/[id]/route');
    const members = await import('@/app/api/folders/members/route');

    // Create a course and see it in the library.
    const created = await stages.POST(
      jsonRequest('http://localhost/api/stages', 'POST', { name: 'Day 1' }),
    );
    expect(created.status).toBe(201);
    const { stage: createdStage } = (await created.json()) as { stage: { id: string } };
    const id = createdStage.id;

    const listed = await stages.GET(
      new NextRequest('http://localhost/api/stages', { headers: asPublisher }),
    );
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { stages: { id: string }[] }).stages).toEqual([
      expect.objectContaining({ id, name: 'Day 1' }),
    ]);

    // Folder CRUD and membership.
    const madeFolder = await folders.POST(
      jsonRequest('http://localhost/api/folders', 'POST', { name: 'Week 1' }),
    );
    expect(madeFolder.status).toBe(200);
    const { folder: newFolder } = (await madeFolder.json()) as { folder: { id: string } };

    const filed = await members.POST(
      jsonRequest('http://localhost/api/folders/members', 'POST', {
        stageId: id,
        folderId: newFolder.id,
      }),
    );
    expect(filed.status).toBe(200);

    const renamedFolder = await folder.PATCH(
      jsonRequest(`http://localhost/api/folders/${newFolder.id}`, 'PATCH', { name: 'Week one' }),
      params(newFolder.id),
    );
    expect(renamedFolder.status).toBe(200);

    const folderList = await folders.GET(
      new NextRequest('http://localhost/api/folders', { headers: asPublisher }),
    );
    expect(folderList.status).toBe(200);
    expect(((await folderList.json()) as { folders: unknown[] }).folders).toEqual([
      expect.objectContaining({ id: newFolder.id, name: 'Week one' }),
    ]);
    const relisted = await stages.GET(
      new NextRequest('http://localhost/api/stages', { headers: asPublisher }),
    );
    expect(((await relisted.json()) as { stages: unknown[] }).stages).toEqual([
      expect.objectContaining({ id, folderId: newFolder.id }),
    ]);

    // Read, rename, and the manifest sync surfaces.
    const read = await stage.GET(
      new NextRequest(`http://localhost/api/stages/${id}`, { headers: asPublisher }),
      params(id),
    );
    expect(read.status).toBe(200);
    const renamed = await stage.PATCH(
      jsonRequest(`http://localhost/api/stages/${id}`, 'PATCH', { name: 'Day one' }),
      params(id),
    );
    expect(renamed.status).toBe(200);
    const manifestResponse = await manifest.GET(
      new NextRequest(`http://localhost/api/stages/${id}/manifest`, { headers: asPublisher }),
      params(id),
    );
    expect(manifestResponse.status).toBe(200);
    await expect(manifestResponse.json()).resolves.toMatchObject({ scenes: [] });
    const scenesResponse = await scenes.GET(
      new NextRequest(`http://localhost/api/stages/${id}/scenes?ids=scene-1`, {
        headers: asPublisher,
      }),
      params(id),
    );
    expect(scenesResponse.status).toBe(200);
    const stream = await freshness.GET(
      new NextRequest(`http://localhost/api/stages/${id}/freshness`, { headers: asPublisher }),
      params(id),
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);
    await stream.body?.cancel().catch(() => undefined);

    // Generation state and publishing.
    const completed = await generationComplete.POST(
      new NextRequest(`http://localhost/api/stages/${id}/generation-complete`, {
        method: 'POST',
        headers: asPublisher,
      }),
      params(id),
    );
    expect(completed.status).toBe(200);
    const published = await publish.POST(
      new NextRequest(`http://localhost/api/stages/${id}/publish`, {
        method: 'POST',
        headers: asPublisher,
      }),
      params(id),
    );
    expect(published.status).toBe(200);
    const publicState = await status.GET(
      new NextRequest(`http://localhost/api/stages/${id}/status`),
      params(id),
    );
    expect(publicState.status).toBe(200);
    await expect(publicState.json()).resolves.toMatchObject({ isPublic: true });
    const unpublished = await unpublish.POST(
      new NextRequest(`http://localhost/api/stages/${id}/unpublish`, {
        method: 'POST',
        headers: asPublisher,
      }),
      params(id),
    );
    expect(unpublished.status).toBe(200);

    // Cleanup paths.
    const removedFolder = await folder.DELETE(
      new NextRequest(`http://localhost/api/folders/${newFolder.id}`, {
        method: 'DELETE',
        headers: asPublisher,
      }),
      params(newFolder.id),
    );
    expect(removedFolder.status).toBe(200);
    const removed = await stage.DELETE(
      new NextRequest(`http://localhost/api/stages/${id}`, {
        method: 'DELETE',
        headers: asPublisher,
      }),
      params(id),
    );
    expect(removed.status).toBe(200);
    const emptied = await stages.GET(
      new NextRequest('http://localhost/api/stages', { headers: asPublisher }),
    );
    await expect(emptied.json()).resolves.toEqual({ stages: [] });
  });
});
