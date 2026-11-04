import { PGlite } from '@electric-sql/pglite';
import JSZip from 'jszip';
import { afterEach, expect, it, vi } from 'vitest';
import type { PBLV3Reference } from '@openmaic/dsl';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
vi.mock('server-only', () => ({}));
const owner = vi.hoisted(() => ({ id: 'anonymous-importer' }));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (
    _request: Request,
    handle: (principal: unknown, headers: Headers) => Promise<Response>,
  ) =>
    handle(
      { ownerId: owner.id, kind: 'anonymous', assurance: 'unverified-legacy', roles: new Set() },
      new Headers(),
    ),
}));

import { POST } from '@/app/api/pbl/v3/packages/route';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { attachClassroomProjects, installClassroomProjects } from '@/lib/pbl/v3/package-client';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { packageBuiltin } from '@/lib/server/pbl-v3/project-package';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function courseDocument(id: string, ref: PBLV3Reference) {
  return {
    stage: { id, name: id, createdAt: 1, updatedAt: 1 },
    scenes: [
      {
        id: `${id}-scene`,
        stageId: id,
        type: 'pbl' as const,
        title: 'Project',
        order: 0,
        content: { type: 'pbl' as const, projectV3: ref },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

it('round-trips a classroom with a project for an anonymous owner while the sandbox is off', async () => {
  vi.stubEnv('ASSET_S3_BUCKET', '');
  vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
  vi.stubEnv('DATABASE_URL', 'postgres://import-without-sandbox');
  const db = new PGlite();
  await db.waitReady;
  const pool = {
    query: (text: string, params?: unknown[]) => db.query(text, params),
    connect: async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release() {},
    }),
    end: async () => {},
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    POST(new Request('http://localhost/api/pbl/v3/packages', init)),
  );
  try {
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const bundle = packageBuiltin(installedProject({ id: 'greeting-python', version: '1.0.0' }));
    const zip = new JSZip();
    for (const [path, text] of Object.entries(bundle.files))
      zip.file(`${bundle.entry.root}/${path}`, text);
    const packaged = {
      id: bundle.entry.id,
      version: bundle.entry.version,
      packageId: bundle.entry.checksum,
    };
    const manifest: ClassroomManifest = {
      formatVersion: 2,
      requiredCapabilities: ['pbl-v3-projects@1'],
      exportedAt: '',
      appVersion: '',
      agents: [],
      mediaIndex: {},
      stage: { name: 'Imported', createdAt: 1, updatedAt: 1 },
      pblProjects: [bundle.entry],
      scenes: [
        {
          type: 'pbl',
          title: 'Project',
          order: 0,
          content: { type: 'pbl', projectV3: packaged },
        },
      ],
    };
    // Import: the zip's project becomes an owned, pinned asset the classroom can publish.
    await installClassroomProjects(
      await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' })),
      manifest,
    );
    const installed = (manifest.scenes[0].content as { projectV3: PBLV3Reference }).projectV3;
    expect(installed).toMatchObject({ checksum: bundle.entry.checksum });
    expect(installed.assetId).toBeTruthy();
    const courses = await getOwnerScopedDocumentStore(owner.id);
    await courses.createDocument(courseDocument('imported', installed));
    await expect(courses.loadDocument('imported')).resolves.toBeTruthy();

    // Re-export: nothing about the course was lost by not being able to run it.
    const exported: ClassroomManifest = {
      ...structuredClone(manifest),
      pblProjects: undefined,
    };
    const files = new Map<string, Blob>();
    await attachClassroomProjects('imported', exported, files);
    expect(exported.pblProjects?.[0]?.checksum).toBe(bundle.entry.checksum);
    expect(files.size).toBe(Object.keys(bundle.files).length);

    // Another owner gets neither the classroom's project nor one pinned from its own course.
    owner.id = 'anonymous-other';
    const foreign = await POST(
      new Request('http://localhost/api/pbl/v3/packages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' },
        body: JSON.stringify({ action: 'export', stageId: 'imported', refs: [installed] }),
      }),
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: { code: 'PBL_PROJECT_UNAVAILABLE' } });
    const foreignCourses = await getOwnerScopedDocumentStore(owner.id);
    await foreignCourses.createDocument(
      courseDocument('foreign', { id: bundle.entry.id, version: bundle.entry.version }),
    );
    const pinned = await POST(
      new Request('http://localhost/api/pbl/v3/packages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' },
        body: JSON.stringify({ action: 'export', stageId: 'foreign', refs: [installed] }),
      }),
    );
    expect(pinned.status).toBe(404);
  } finally {
    owner.id = 'anonymous-importer';
    await db.close();
  }
}, 60_000);
