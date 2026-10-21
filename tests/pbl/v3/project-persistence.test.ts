import { afterAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('server-only', () => ({}));
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import {
  installProjectPackage,
  resolveProject,
  exportProjectPackage,
} from '@/lib/server/pbl-v3/project-resolver';
import { packageBuiltin, indexProjectFiles } from '@/lib/server/pbl-v3/project-package';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { PgAssetByteStore } from '@openmaic/storage/asset/pg-bytes';
import { AssetCollector } from '@openmaic/storage/asset/collector';
import type { PBLV3Reference } from '@openmaic/dsl';
import { STAGE_META_OWNERSHIP } from '@/lib/persistence/stage-meta-ownership';
import {
  assetReferencePrincipalsForOwner,
  assetPrincipalForOwner,
  createOwnerAssetStore,
} from '@/lib/persistence/owner-assets';

class DiskPool {
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
  async end() {}
}
function document(id: string, ref: PBLV3Reference) {
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
describe('persisted project templates and classroom lifecycle', () => {
  let database: PGlite | undefined,
    root = '';
  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('survives a database reopen, round-trips between owners, rejects foreign references and collects only unused templates', async () => {
    root = await mkdtemp(join(tmpdir(), 'pbl-installed-projects-'));
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    async function boot(phase: number) {
      database = new PGlite(join(root, 'database'));
      await database.waitReady;
      const pool = new DiskPool(database),
        url = `postgres://project-package-phase-${phase}`;
      vi.stubEnv('DATABASE_URL', url);
      return getServerPersistenceProvider(url, () => pool as never);
    }
    let persistence = await boot(1);
    const original = packageBuiltin(
      installedProject({ id: 'greeting-python-lab', version: '1.0.0' }),
    );
    // A course-specific id proves no static catalog entry can resolve this course.
    const files = structuredClone(original.files),
      descriptor = JSON.parse(files['project.json']);
    descriptor.id = descriptor.definition.id = 'author-course';
    files['project.json'] = JSON.stringify(descriptor);
    const bundle = indexProjectFiles('author-course', '1.0.0', files);
    const ref = await installProjectPackage('author-a', bundle);
    expect(await installProjectPackage('author-a', bundle)).toEqual(ref);
    let courses = await getOwnerScopedDocumentStore('author-a');
    await courses.createDocument(document('original', ref));
    await courses.createDocument(document('copy', ref));
    expect(
      (
        await persistence.pool.query('SELECT * FROM document_asset_refs WHERE asset_id=$1', [
          ref.assetId,
        ])
      ).rows,
    ).toHaveLength(2);
    const conflicting = {
      ...files,
      'docs/0.md': 'Revised teaching content under the same declared version.',
    };
    const otherRef = await installProjectPackage(
      'author-a',
      indexProjectFiles('author-course', '1.0.0', conflicting),
    );
    expect(otherRef.checksum).not.toBe(ref.checksum);
    expect(otherRef.assetId).not.toBe(ref.assetId);
    await courses.putScene('original', {
      ...document('original', ref).scenes[0],
      id: 'second-reference',
    });
    await courses.putScene('original', document('original', otherRef).scenes[0]);
    await expect(
      resolveProject('author-a', 'original', ref, persistence, 'original-scene'),
    ).rejects.toMatchObject({ status: 404 });
    await courses.putScene('original', document('original', ref).scenes[0]);
    expect((await resolveProject('author-a', 'original', ref)).coursePackage?.bundle).toEqual(
      bundle,
    );
    await expect(resolveProject('author-b', 'original', ref)).rejects.toMatchObject({
      status: 404,
    });
    let foreignCourses = await getOwnerScopedDocumentStore('author-b');
    await expect(foreignCourses.createDocument(document('forged', ref))).rejects.toThrow(
      'unavailable',
    );
    expect(await foreignCourses.loadDocument('forged')).toBeNull();
    const corrupted = structuredClone(bundle);
    corrupted.files['docs/0.md'] = 'tampered';
    await expect(installProjectPackage('author-a', corrupted)).rejects.toThrow('checksum');
    const ownerAssets = createOwnerAssetStore(persistence.assetStore, {
      ownerId: 'author-a',
      queryable: persistence.pool,
      transactions: {
        withTransaction: persistence.withTransaction,
        storeIn: persistence.assetStoreIn,
      },
    });
    await expect(
      ownerAssets.remove(assetPrincipalForOwner('author-a'), ref.assetId!),
    ).rejects.toMatchObject({ code: 'ASSET_IMMUTABLE' });
    await expect(
      ownerAssets.replace(
        assetPrincipalForOwner('author-a'),
        ref.assetId! as never,
        new Blob(['changed']),
      ),
    ).rejects.toMatchObject({ code: 'ASSET_IMMUTABLE' });
    const readerAssets = createOwnerAssetStore(persistence.assetStore, {
      ownerId: 'author-b',
      queryable: persistence.pool,
    });
    expect(await readerAssets.resolve(assetPrincipalForOwner('author-b'), ref.assetId!)).toBeNull();
    await database!.close();
    database = undefined;
    persistence = await boot(2);
    courses = await getOwnerScopedDocumentStore('author-a');
    foreignCourses = await getOwnerScopedDocumentStore('author-b');
    const resolved = await resolveProject('author-a', 'original', ref);
    expect(resolved.files).toEqual(
      installedProject({ id: 'greeting-python-lab', version: '1.0.0' }).files,
    );
    expect(resolved.coursePackage?.bundle).toEqual(bundle);
    const exported = await exportProjectPackage('author-a', 'original', ref);
    const receiving = await installProjectPackage('author-b', exported);
    expect(receiving.assetId).not.toBe(ref.assetId);
    expect(receiving.checksum).toBe(ref.checksum);
    await foreignCourses.createDocument(document('receiving', receiving));
    expect(await exportProjectPackage('author-b', 'receiving', receiving)).toEqual(exported);
    await courses.deleteDocument('original');
    const collector = new AssetCollector(persistence.pool, new PgAssetByteStore(persistence.pool), {
      withTransaction: persistence.withTransaction,
      graceMs: 0,
      documentReferences: true,
      assetReferencePrincipals: assetReferencePrincipalsForOwner,
      documentOwnership: STAGE_META_OWNERSHIP,
      now: () => new Date(Date.now() + 7 * 86400000),
    });
    await collector.collectPass();
    expect((await resolveProject('author-a', 'copy', ref)).ref).toEqual(ref);
    await expect(resolveProject('author-a', 'original', ref)).rejects.toMatchObject({
      status: 404,
    });
    await courses.deleteDocument('copy');
    await collector.collectPass();
    expect(
      (
        await persistence.pool.query('SELECT 1 FROM pbl_project_installations WHERE asset_id=$1', [
          ref.assetId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect((await resolveProject('author-b', 'receiving', receiving)).ref).toEqual(receiving);
    expect(
      (
        await persistence.pool.query('SELECT 1 FROM pbl_project_installations WHERE asset_id=$1', [
          otherRef.assetId,
        ])
      ).rows,
    ).toHaveLength(0);
  }, 30_000);
});
