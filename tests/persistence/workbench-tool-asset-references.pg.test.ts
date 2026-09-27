/**
 * What the workbench tools' new write path leaves in the database.
 *
 * The tools allocate through `storeGeneratedAsset` and then let the runner's
 * own document write name the id. The claim that makes the whole design safe
 * is that this needs no reference-writing code of its own: the owner-bound
 * PostgreSQL document store maintains `document_asset_refs` and commits the
 * pending allocation inside the same transaction as the write. That claim
 * cannot be checked with a fake store or by asserting a constructor argument —
 * it is a property of a real PostgreSQL — so it is checked here, against the
 * real helper, the real `PgAssetStore`, and the real completion patch the
 * detached video job issues.
 *
 * This file provisions its own schema and drops it again, for the reason
 * `document-asset-references.pg.test.ts` states: the CI job points several
 * suites at one database, and `stage_meta`'s foreign key to `document_stages`
 * breaks a neighbouring suite's non-cascading TRUNCATE. The search path is
 * this schema alone, so `CREATE TABLE IF NOT EXISTS` cannot resolve to another
 * suite's table and provision nothing here.
 */
import type { Scene, Stage } from '@openmaic/dsl';
import type { MaicDocument } from '@openmaic/storage';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { SHARED_ASSET_PRINCIPAL } from '@/lib/persistence/server-auth';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { CourseStore } from '@/lib/server/agent-runtime/course-tools';
import { patchStageVideoPlaceholder } from '@/lib/server/agent-runtime/generate-video';
import { storeGeneratedAsset } from '@/lib/server/store-generated-asset';

const FIXED_NOW = 1_700_000_000_000;

const contractUrl = process.env.PG_CONTRACT_URL;
if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    'workbench asset references: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL suite',
  );
}

const OWNER = 'anon:22222222-2222-4222-8222-222222222222';
const TEST_SCHEMA = 'openmaic_workbench_asset_pool_test';

interface EntryLifecycleRow extends Record<string, unknown> {
  committed_at: Date | null;
  expires_at: Date | null;
  unreferenced_at: Date | null;
}

interface ReferenceRow extends Record<string, unknown> {
  stage_id: string;
  scope: string;
  scene_id: string;
  asset_id: string;
}

describe.skipIf(!contractUrl)('workbench tool media through the asset pool', () => {
  let admin: Pool;
  let pool: Pool;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${TEST_SCHEMA}`,
    });
    // The helper resolves its store through `getServerPersistenceProvider`
    // keyed on DATABASE_URL, so priming the memo for that exact string with
    // this schema's pool is what puts the real helper — default store
    // resolution included — on this database.
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = contractUrl;
    await getServerPersistenceProvider(contractUrl!, () => pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE document_asset_refs, document_asset_withdrawals, asset_entries, asset_blobs, ' +
        'stage_meta, document_stages CASCADE',
    );
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  function store(): CourseStore {
    return createOwnerBoundDocumentStore({
      pool,
      ownerId: OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }) as unknown as CourseStore;
  }

  /** A slide holding one video element still carrying the generation placeholder. */
  function scenePendingVideo(stageId: string, sceneId: string, ref: string): Scene {
    return {
      id: sceneId,
      stageId,
      order: 1,
      title: sceneId,
      type: 'slide',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      content: {
        type: 'slide',
        canvas: {
          id: `canvas-${sceneId}`,
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          theme: {
            backgroundColor: '#ffffff',
            themeColors: ['#2563eb'],
            fontColor: '#111827',
            fontName: 'Inter',
          },
          elements: [
            {
              id: `${sceneId}-video`,
              type: 'video',
              mediaRef: ref,
              left: 0,
              top: 0,
              width: 400,
              height: 225,
            },
          ],
        },
      },
    } as unknown as Scene;
  }

  /** A slide whose image element names `assetId`, as `patch_stage` would write it. */
  function sceneNamingImage(stageId: string, sceneId: string, assetId: string): Scene {
    const scene = scenePendingVideo(stageId, sceneId, 'unused') as unknown as {
      content: { canvas: { elements: unknown[] } };
    };
    scene.content.canvas.elements = [
      {
        id: `${sceneId}-image`,
        type: 'image',
        src: assetId,
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      },
    ];
    return scene as unknown as Scene;
  }

  function documentWith(stageId: string, name: string, scenes: Scene[]) {
    return {
      stage: { id: stageId, name, createdAt: FIXED_NOW, updatedAt: FIXED_NOW },
      scenes,
      outline: {
        outlines: [],
        requirement: name,
        generationComplete: false,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    } as unknown as MaicDocument<Scene, Stage>;
  }

  async function lifecycle(assetId: string): Promise<EntryLifecycleRow> {
    const result = await pool.query<EntryLifecycleRow>(
      'SELECT committed_at, expires_at, unreferenced_at FROM asset_entries WHERE id = $1',
      [assetId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`no entry for ${assetId}`);
    return row;
  }

  async function references(stageId: string): Promise<ReferenceRow[]> {
    const result = await pool.query<ReferenceRow>(
      'SELECT stage_id, scope, scene_id, asset_id FROM document_asset_refs WHERE stage_id = $1' +
        ' ORDER BY asset_id',
      [stageId],
    );
    return result.rows;
  }

  async function storedId(stageId: string, kind: 'image' | 'video' | 'poster'): Promise<string> {
    const stored = await storeGeneratedAsset({
      stageId,
      bytes: Buffer.from(`${kind}-bytes-for-${stageId}`),
      mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
      kind,
    });
    if (stored.status !== 'stored') throw new Error(`unexpected refusal: ${stored.reason}`);
    return stored.assetId;
  }

  it('allocates under the shared principal, with the content type and the course on the entry', async () => {
    const assetId = await storedId('stage-wb-meta', 'image');
    const result = await pool.query<{ principal: string; mime: string; meta: unknown }>(
      'SELECT principal, mime, meta FROM asset_entries WHERE id = $1',
      [assetId],
    );
    expect(assetId).toMatch(/^ast_/);
    expect(result.rows[0]).toMatchObject({
      principal: SHARED_ASSET_PRINCIPAL,
      mime: 'image/png',
      meta: { contentType: 'image/png', stageId: 'stage-wb-meta', kind: 'image' },
    });
  });

  it('holds a generated image pending until the patch_stage write names it', async () => {
    const stageId = 'stage-wb-image';
    await store().saveDocument(documentWith(stageId, 'Workbench image', []));
    const assetId = await storedId(stageId, 'image');

    // Before the document write: bytes are stored, nothing claims them, and
    // the entry carries the deadline the collector reclaims it on.
    const allocated = await lifecycle(assetId);
    expect(allocated.committed_at).toBeNull();
    expect(allocated.expires_at).not.toBeNull();
    expect(await references(stageId)).toEqual([]);

    // What `patch_stage` does with the id the tool returned: one scene write
    // through the owner-bound store.
    await store().putScene(stageId, sceneNamingImage(stageId, 'scene-1', assetId));

    expect(await references(stageId)).toEqual([
      { stage_id: stageId, scope: 'scene', scene_id: 'scene-1', asset_id: assetId },
    ]);
    const committed = await lifecycle(assetId);
    expect(committed.committed_at).not.toBeNull();
    expect(committed.expires_at).toBeNull();
    expect(committed.unreferenced_at).toBeNull();
  });

  it("commits the video and its poster on the completion patch's single write", async () => {
    const stageId = 'stage-wb-video';
    const ref = 'gen_vid_contract';
    await store().saveDocument(
      documentWith(stageId, 'Workbench video', [scenePendingVideo(stageId, 'scene-1', ref)]),
    );
    const videoId = await storedId(stageId, 'video');
    const posterId = await storedId(stageId, 'poster');

    expect((await lifecycle(videoId)).committed_at).toBeNull();
    expect((await lifecycle(posterId)).committed_at).toBeNull();
    expect(await references(stageId)).toEqual([]);

    // The detached job's real completion patch, against the real store.
    const patched = await patchStageVideoPlaceholder(store(), stageId, ref, {
      src: videoId,
      poster: posterId,
    });

    expect(patched).toBe(1);
    // Read back through the real store: every slot that held the placeholder
    // now names an allocated id. `mediaRef` is the one every resolver reads
    // first, so a row in `document_asset_refs` with a placeholder still on the
    // element would be a reference to bytes nothing can reach.
    const persisted = (await store().getScene(stageId, 'scene-1')) as unknown as {
      content: { canvas: { elements: { src?: string; mediaRef?: string; poster?: string }[] } };
    };
    expect(persisted.content.canvas.elements[0]).toMatchObject({
      mediaRef: videoId,
      src: videoId,
      poster: posterId,
    });
    expect(JSON.stringify(persisted.content.canvas.elements[0])).not.toContain(ref);
    expect(await references(stageId)).toEqual(
      [
        { stage_id: stageId, scope: 'scene', scene_id: 'scene-1', asset_id: videoId },
        { stage_id: stageId, scope: 'scene', scene_id: 'scene-1', asset_id: posterId },
      ].sort((left, right) => left.asset_id.localeCompare(right.asset_id)),
    );
    for (const id of [videoId, posterId]) {
      const committed = await lifecycle(id);
      expect(committed.committed_at).not.toBeNull();
      expect(committed.expires_at).toBeNull();
    }
  });

  it('records nothing for the legacy classroom-media path the tools no longer write', async () => {
    // The contrast that makes the change worth making: the same write, with
    // the value the tools used to produce, leaves no reference and no
    // committed entry — which is why the local-disk path had no quota, no
    // reclamation and no owner.
    const stageId = 'stage-wb-legacy';
    const ref = 'gen_vid_legacy';
    await store().saveDocument(
      documentWith(stageId, 'Legacy video', [scenePendingVideo(stageId, 'scene-1', ref)]),
    );

    const patched = await patchStageVideoPlaceholder(store(), stageId, ref, {
      src: `/api/classroom-media/${stageId}/media/generated-abc.mp4`,
    });

    expect(patched).toBe(1);
    expect(await references(stageId)).toEqual([]);
  });
});
