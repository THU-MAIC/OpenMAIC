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
import {
  packageBuiltin,
  indexProjectFiles,
  canonicalJson,
  sha256,
} from '@/lib/server/pbl-v3/project-package';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { PgAssetByteStore } from '@openmaic/storage/asset/pg-bytes';
import { AssetCollector } from '@openmaic/storage/asset/collector';
import type { PBLV3Reference } from '@openmaic/dsl';
import { STAGE_META_OWNERSHIP } from '@/lib/persistence/stage-meta-ownership';
import { applySchemaMigrations } from '@openmaic/storage/pg-migrations';
import { LearningStore } from '@/lib/server/pbl-v3/store';
import { PBL_MIGRATIONS } from '@/lib/persistence/pbl-studies';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
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
  it('resolves and exports previously installed authoring errors without weakening new admission or ownership', async () => {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const db = new PGlite();
    await db.waitReady;
    const pool = new DiskPool(db),
      url = 'postgres://installed-authoring-validation';
    vi.stubEnv('DATABASE_URL', url);
    try {
      const persistence = await getServerPersistenceProvider(url, () => pool as never);
      const courses = await getOwnerScopedDocumentStore('existing-author');
      const original = packageBuiltin(
        installedProject({ id: 'greeting-python-lab', version: '1.1.0' }),
      );
      for (const kind of ['empty-choice', 'quiz-feedback']) {
        const files = { ...original.files },
          descriptor = JSON.parse(files['project.json']);
        if (kind === 'empty-choice') descriptor.definition.decisions[0].options = [];
        else descriptor.definition.milestones[0].quiz[0].optionFeedback = ['Only one hint'];
        files['project.json'] = JSON.stringify(descriptor);
        const bundle = indexProjectFiles(original.entry.id, original.entry.version, files);
        await expect(installProjectPackage('existing-author', bundle)).rejects.toMatchObject({
          code: 'PBL_PACKAGE_INVALID',
        });
        // Seed bytes admitted by the previous release; production admission stays strict.
        const bytes = canonicalJson(bundle),
          mime = 'application/vnd.openmaic.pbl-project+json';
        const assetId = await persistence.assetStore.put(
          assetPrincipalForOwner('existing-author'),
          new Blob([bytes], { type: mime }),
          { contentType: mime },
        );
        await persistence.pool.query(
          'INSERT INTO pbl_project_installations(asset_id,project_id,project_version,checksum,content_hash) VALUES($1,$2,$3,$4,$5)',
          [
            assetId,
            bundle.entry.id,
            bundle.entry.version,
            bundle.entry.checksum,
            `sha256-${sha256(bytes)}`,
          ],
        );
        const ref = {
          id: bundle.entry.id,
          version: bundle.entry.version,
          assetId,
          checksum: bundle.entry.checksum,
        };
        await courses.createDocument(document(kind, ref));
        expect((await resolveProject('existing-author', kind, ref)).coursePackage?.bundle).toEqual(
          bundle,
        );
        expect(await exportProjectPackage('existing-author', kind, ref)).toEqual(bundle);
        await expect(resolveProject('other-owner', kind, ref)).rejects.toMatchObject({
          status: 404,
        });
      }
    } finally {
      await db.close();
    }
  }, 30_000);
  it('keeps a study pin alive after its last scene changes or disappears, until the classroom is deleted', async () => {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const db = new PGlite();
    await db.waitReady;
    const pool = new DiskPool(db),
      url = 'postgres://last-scene-study-pin';
    vi.stubEnv('DATABASE_URL', url);
    try {
      const persistence = await getServerPersistenceProvider(url, () => pool as never);
      await applySchemaMigrations(persistence.pool, PBL_MIGRATIONS);
      const studies = new LearningStore(persistence.pool);
      const bundle = packageBuiltin(
        installedProject({ id: 'greeting-python-lab', version: '1.1.0' }),
      );
      const ref = await installProjectPackage('pin-owner', bundle);
      const courses = await getOwnerScopedDocumentStore('pin-owner');
      await courses.createDocument(document('only-classroom', ref));
      const study = await studies.create(
        {
          ownerId: 'pin-owner',
          stageId: 'only-classroom',
          sceneId: 'only-classroom-scene',
          projectId: ref.id,
          version: ref.version,
          projectRef: ref,
        },
        startOrchestration(JSON.parse(bundle.files['project.json']).definition),
      );
      const replacement = await installProjectPackage(
        'pin-owner',
        indexProjectFiles(ref.id, ref.version, {
          ...bundle.files,
          'docs/0.md': 'A replacement course introduction.',
        }),
      );
      await courses.putScene('only-classroom', document('only-classroom', replacement).scenes[0]);
      await expect(
        studies.create(
          {
            ownerId: 'pin-owner',
            stageId: 'only-classroom',
            sceneId: 'missing-scene',
            projectId: ref.id,
            version: ref.version,
            projectRef: ref,
          },
          startOrchestration(JSON.parse(bundle.files['project.json']).definition),
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect((await db.query('SELECT 1 FROM pbl_v3_studies')).rows).toHaveLength(1);
      expect((await studies.get(study.id, 'pin-owner')).project?.coursePackage?.bundle).toEqual(
        bundle,
      );
      await courses.deleteScene('only-classroom', 'only-classroom-scene');
      await courses.putScene('only-classroom', {
        ...document('only-classroom', replacement).scenes[0],
        id: study.id,
      });
      await courses.deleteScene('only-classroom', study.id);
      await courses.saveDocument({ ...document('only-classroom', replacement), scenes: [] });
      const collector = new AssetCollector(
        persistence.pool,
        new PgAssetByteStore(persistence.pool),
        {
          withTransaction: persistence.withTransaction,
          graceMs: 0,
          documentReferences: true,
          assetReferencePrincipals: assetReferencePrincipalsForOwner,
          documentOwnership: STAGE_META_OWNERSHIP,
          now: () => new Date(Date.now() + 7 * 86400000),
        },
      );
      await collector.collectPass();
      expect(
        (await new LearningStore(persistence.pool).get(study.id, 'pin-owner')).project
          ?.coursePackage?.bundle,
      ).toEqual(bundle);
      expect(
        (await db.query('SELECT unreferenced_at FROM asset_entries WHERE id=$1', [ref.assetId]))
          .rows,
      ).toEqual([{ unreferenced_at: null }]);
      await expect(studies.get(study.id, 'other-owner')).rejects.toMatchObject({ status: 404 });
      await courses.deleteDocument('only-classroom');
      await expect(studies.get(study.id, 'pin-owner')).rejects.toMatchObject({ status: 404 });
      await collector.collectPass();
      expect(
        (await db.query('SELECT 1 FROM asset_entries WHERE id=$1', [ref.assetId])).rows,
      ).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 30_000);
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
      installedProject({ id: 'greeting-python-lab', version: '1.1.0' }),
    );
    // A course-specific id proves no static catalog entry can resolve this course.
    const files = structuredClone(original.files),
      descriptor = JSON.parse(files['project.json']);
    descriptor.id = descriptor.definition.id = 'author-course';
    descriptor.version = '1.0.0';
    files['project.json'] = JSON.stringify(descriptor);
    const bundle = indexProjectFiles('author-course', '1.0.0', files);
    const ref = await installProjectPackage('author-a', bundle);
    expect(await installProjectPackage('author-a', bundle)).toEqual(ref);
    let courses = await getOwnerScopedDocumentStore('author-a');
    await courses.createDocument(document('original', ref));
    await courses.createDocument(document('copy', ref));
    await applySchemaMigrations(persistence.pool, PBL_MIGRATIONS);
    let studies = new LearningStore(persistence.pool);
    const study = await studies.create(
      {
        ownerId: 'author-a',
        stageId: 'original',
        sceneId: 'original-scene',
        projectId: ref.id,
        version: ref.version,
        projectRef: ref,
      },
      startOrchestration(descriptor.definition),
    );
    expect(
      (
        await persistence.pool.query('SELECT * FROM document_asset_refs WHERE asset_id=$1', [
          ref.assetId,
        ])
      ).rows,
    ).toHaveLength(3);
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
    // An admitted study keeps its own pin even after its original scene changes.
    expect((await studies.get(study.id, 'author-a')).project?.coursePackage?.bundle).toEqual(
      bundle,
    );
    await expect(studies.get(study.id, 'author-b')).rejects.toMatchObject({ status: 404 });
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
    studies = new LearningStore(persistence.pool);
    courses = await getOwnerScopedDocumentStore('author-a');
    foreignCourses = await getOwnerScopedDocumentStore('author-b');
    const resolved = await resolveProject('author-a', 'original', ref);
    expect(resolved.files).toEqual(
      installedProject({ id: 'greeting-python-lab', version: '1.1.0' }).files,
    );
    expect(resolved.coursePackage?.bundle).toEqual(bundle);
    const resumed = await studies.get(study.id, 'author-a');
    expect(resumed.project_reference).toEqual(ref);
    expect(resumed.project?.coursePackage?.bundle).toEqual(bundle);
    const exported = await exportProjectPackage('author-a', 'original', ref);
    const receiving = await installProjectPackage('author-b', exported);
    expect(receiving.assetId).not.toBe(ref.assetId);
    expect(receiving.checksum).toBe(ref.checksum);
    await foreignCourses.createDocument(document('receiving', receiving));
    expect(await exportProjectPackage('author-b', 'receiving', receiving)).toEqual(exported);
    await courses.deleteDocument('original');
    await expect(studies.get(study.id, 'author-a')).rejects.toMatchObject({ status: 404 });
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

  it('renews pending retries and keeps reinstalled resources alive until classroom publication', async () => {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('ASSET_PENDING_TTL_MS', '60000');
    const db = new PGlite();
    await db.waitReady;
    const pool = new DiskPool(db),
      url = 'postgres://project-package-reinstall';
    vi.stubEnv('DATABASE_URL', url);
    try {
      const persistence = await getServerPersistenceProvider(url, () => pool as never);
      const bundle = packageBuiltin(
        installedProject({ id: 'greeting-python-lab', version: '1.1.0' }),
      );
      const ref = await installProjectPackage('reimport-owner', bundle);
      await db.query(
        "UPDATE asset_entries SET expires_at=now()+interval '10 seconds' WHERE id=$1",
        [ref.assetId],
      );
      expect(await installProjectPackage('reimport-owner', bundle)).toEqual(ref);
      expect(
        (
          await db.query<{ renewed: boolean }>(
            "SELECT expires_at>now()+interval '50 seconds' AS renewed FROM asset_entries WHERE id=$1",
            [ref.assetId],
          )
        ).rows[0]?.renewed,
      ).toBe(true);

      const courses = await getOwnerScopedDocumentStore('reimport-owner');
      await courses.createDocument(document('before-reimport', ref));
      await courses.deleteDocument('before-reimport');
      await db.query(
        "UPDATE asset_entries SET unreferenced_at=now()-interval '2 hours' WHERE id=$1",
        [ref.assetId],
      );
      const reinstalled = await installProjectPackage('reimport-owner', bundle);
      expect(reinstalled.assetId).not.toBe(ref.assetId);
      const collector = new AssetCollector(
        persistence.pool,
        new PgAssetByteStore(persistence.pool),
        {
          withTransaction: persistence.withTransaction,
          graceMs: 60 * 60 * 1000,
          documentReferences: true,
          assetReferencePrincipals: assetReferencePrincipalsForOwner,
          documentOwnership: STAGE_META_OWNERSHIP,
        },
      );
      await collector.collectPass();
      expect(
        (await db.query('SELECT 1 FROM pbl_project_installations WHERE asset_id=$1', [ref.assetId]))
          .rows,
      ).toHaveLength(0);
      await courses.createDocument(document('after-reimport', reinstalled));
      expect(
        (await resolveProject('reimport-owner', 'after-reimport', reinstalled)).coursePackage
          ?.bundle,
      ).toEqual(bundle);
    } finally {
      await db.close();
    }
  }, 30_000);
});
