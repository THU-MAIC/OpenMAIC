/**
 * The one-time import of file-stored classrooms, on PostgreSQL and a real
 * directory: references rewritten to asset-pool ids, a course that already
 * holds an id never overwritten, every outcome recorded once, and a second run
 * that changes nothing.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { recordLegacyClassroomFailure } from '@/lib/persistence/legacy-classroom-imports';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  importLegacyClassrooms,
  LEGACY_CLASSROOM_OWNER_ID,
  resolveLegacyClassroomOwner,
} from '@/lib/server/legacy-classroom-import';

// The real asset pool, with two seams: refuse for room, or run a hook first
// (to create a competing course while an import is between its check and its
// create).
const assetSeams = vi.hoisted(() => ({
  /** Refuse for room once this many allocations have been stored. */
  refuseAfter: Infinity,
  stored: 0,
  beforeStore: undefined as undefined | (() => Promise<void>),
}));
// The host create hooks, switchable per test.
const hookSeams = vi.hoisted(() => ({
  refuseCreate: undefined as string | undefined,
  authorizeCalls: 0,
}));
vi.mock('@/lib/server/persistence-hooks/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/persistence-hooks/registry')>();
  const hooks = {
    name: 'test-hooks',
    authorizeCreate: async () => {
      hookSeams.authorizeCalls += 1;
      return hookSeams.refuseCreate === undefined
        ? ({ allow: true } as const)
        : ({ allow: false, message: hookSeams.refuseCreate } as const);
    },
  };
  return { ...actual, getPersistenceHooks: () => hooks };
});

vi.mock('@/lib/server/store-generated-asset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/store-generated-asset')>();
  return {
    ...actual,
    storeGeneratedAsset: async (input: Parameters<typeof actual.storeGeneratedAsset>[0]) => {
      const hook = assetSeams.beforeStore;
      assetSeams.beforeStore = undefined;
      await hook?.();
      if (assetSeams.stored >= assetSeams.refuseAfter) {
        return { status: 'refused', reason: 'storage-full' } as const;
      }
      assetSeams.stored += 1;
      return actual.storeGeneratedAsset(input);
    },
  };
});

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_legacy_classroom_import_test';
const OWNER = 'team-owner';
const OTHER = 'user:someone-else';
const NOW = 1_780_000_000_000;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const MP3 = Buffer.from([0x49, 0x44, 0x33, 4]);

function canvas(elements: unknown[]) {
  return {
    id: 'canvas-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: { backgroundColor: '#fff', themeColors: ['#000'], fontColor: '#000', fontName: 'Inter' },
    elements,
  };
}

function legacyClassroom(id: string, name: string, extra: Record<string, unknown> = {}) {
  const media = (sub: string, file: string) =>
    `http://old.example:3000/api/classroom-media/${id}/${sub}/${file}`;
  return {
    id,
    createdAt: '2026-08-01T00:00:00.000Z',
    stage: { id, name, createdAt: NOW, updatedAt: NOW, currentSceneId: 'scene-1' },
    scenes: [
      {
        id: 'scene-1',
        stageId: id,
        type: 'slide',
        title: 'Leaves',
        order: 1,
        content: {
          type: 'slide',
          canvas: canvas([
            { id: 'img', type: 'image', src: media('media', 'gen_img_1.png') },
            {
              id: 'vid',
              type: 'video',
              src: media('media', 'gen_vid_1.mp4'),
              mediaRef: 'gen_vid_1',
            },
            { id: 'gone', type: 'image', src: `/api/classroom-media/${id}/media/missing.png` },
            {
              id: 'foreign',
              type: 'image',
              src: 'http://old.example:3000/api/classroom-media/other-room/media/x.png',
            },
            { id: 'text', type: 'text', content: '<p>Hello<script>alert(1)</script></p>' },
          ]),
        },
        actions: [
          {
            id: 'speech-1',
            type: 'speech',
            text: 'Leaves are green.',
            audioId: 'tts_s1_speech-1',
            audioUrl: media('audio', 'tts_s1_speech-1.mp3'),
          },
          {
            id: 'speech-2',
            type: 'speech',
            text: 'Its clip is gone.',
            audioId: 'tts_s1_speech-2',
            audioUrl: media('audio', 'tts_s1_speech-2.mp3'),
          },
        ],
      },
    ],
    ...extra,
  };
}

/** A classroom naming two media files of its own, `a.png` and `b.png`. */
function flakyClassroom(id: string) {
  return {
    stage: { id, name: id, createdAt: NOW, updatedAt: NOW },
    scenes: [
      {
        id: 'scene-1',
        stageId: id,
        type: 'slide',
        title: 'Media',
        order: 1,
        content: {
          type: 'slide',
          canvas: canvas([
            { id: 'a', type: 'image', src: `/api/classroom-media/${id}/media/a.png` },
            { id: 'b', type: 'image', src: `/api/classroom-media/${id}/media/b.png` },
          ]),
        },
      },
    ],
  };
}

function ownerStore(pool: Pool, ownerId: string) {
  return createOwnerBoundDocumentStore({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

describe.skipIf(!contractUrl)('legacy classroom import on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  let directory: string;
  const previousEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ASSET_S3_BUCKET: process.env.ASSET_S3_BUCKET,
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=legacy-classroom-import`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    await getServerPersistenceProvider(databaseUrl, () => pool);

    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openmaic-legacy-classrooms-'));
    const write = async (file: string, data: string | Buffer) => {
      await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await fs.writeFile(path.join(directory, file), data);
    };
    await write('legacy01.json', JSON.stringify(legacyClassroom('legacy01', 'Plants')));
    await write('legacy01/media/gen_img_1.png', PNG);
    await write('legacy01/media/gen_vid_1.mp4', MP4);
    await write('legacy01/audio/tts_s1_speech-1.mp3', MP3);
    await write('taken01.json', JSON.stringify(legacyClassroom('taken01', 'Legacy copy')));
    await write(
      'reserved01.json',
      JSON.stringify({ ...legacyClassroom('reserved01', 'Pending'), scenes: [], reserved: true }),
    );
    await write('broken01.json', '{ not json');
    await write('notes.txt', 'not a classroom');
    await write('legacy01.json.123.456.tmp', '{}');

    // Someone already holds `taken01`: it stands.
    await ownerStore(pool, OTHER).saveDocument({
      stage: { id: 'taken01', name: 'Current course', createdAt: NOW, updatedAt: NOW },
      scenes: [],
    });
  });

  async function ownerAssetCount(ownerId: string): Promise<number> {
    const result = await pool.query(
      'SELECT COUNT(*)::int AS n FROM asset_entries WHERE principal = $1',
      [`owner:${ownerId}`],
    );
    return result.rows[0].n;
  }

  async function ledgerRow(legacyId: string) {
    const result = await pool.query(
      'SELECT outcome, detail, attempts FROM legacy_classroom_imports WHERE legacy_id = $1',
      [legacyId],
    );
    return result.rows[0];
  }

  async function withMedia(dir: string, legacyId: string, files: string[]) {
    await fs.mkdir(path.join(dir, legacyId, 'media'), { recursive: true });
    for (const file of files) await fs.writeFile(path.join(dir, legacyId, 'media', file), PNG);
  }

  const scratch: string[] = [];
  async function freshDirectory(files: Record<string, unknown>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openmaic-legacy-classrooms-'));
    scratch.push(dir);
    for (const [name, value] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), JSON.stringify(value));
    }
    return dir;
  }

  afterAll(async () => {
    for (const dir of scratch) await fs.rm(dir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  it('imports once, rewrites media references to pool ids, and never overwrites', async () => {
    const first = await importLegacyClassrooms({ directory, ownerId: OWNER });
    expect(first).toEqual({
      found: 4,
      imported: 1,
      alreadySettled: 0,
      skipped: 3,
      failed: 0,
      mediaStored: 3,
      mediaMissing: 2,
    });

    const document = await ownerStore(pool, OWNER).loadDocument('legacy01');
    expect(document?.stage).toMatchObject({ id: 'legacy01', name: 'Plants' });
    expect(document?.stage).not.toHaveProperty('currentSceneId');
    expect(document?.outline).toMatchObject({ generationComplete: true });
    const meta = await pool.query(
      'SELECT owner_id, generation_complete FROM stage_meta WHERE stage_id = $1',
      ['legacy01'],
    );
    expect(meta.rows).toEqual([{ owner_id: OWNER, generation_complete: true }]);
    expect((await ownerStore(pool, OWNER).listDocuments()).map((doc) => doc.id)).toEqual([
      'legacy01',
    ]);

    const scene = document!.scenes[0]!;
    const elements = (
      scene.content as {
        canvas: {
          elements: Array<{ id: string; src?: string; mediaRef?: string; content?: string }>;
        };
      }
    ).canvas.elements;
    const byId = Object.fromEntries(elements.map((element) => [element.id, element]));
    expect(byId.img!.src).toMatch(/^ast_/);
    expect(byId.vid!.src).toMatch(/^ast_/);
    // Playback resolves `mediaRef` first: it moves with the video.
    expect(byId.vid!.mediaRef).toBe(byId.vid!.src);
    // A file that is gone, and another classroom's file, stay as they were.
    expect(byId.gone!.src).toBe('/api/classroom-media/legacy01/media/missing.png');
    expect(byId.foreign!.src).toBe(
      'http://old.example:3000/api/classroom-media/other-room/media/x.png',
    );
    expect(byId.text!.content).not.toContain('<script>');
    const speech = scene.actions![0] as { audioId?: string; audioUrl?: string };
    expect(speech.audioId).toMatch(/^ast_/);
    expect(speech).not.toHaveProperty('audioUrl');
    // A clip that is gone leaves the line unvoiced, not half a legacy pair.
    const silent = scene.actions![1] as { audioId?: string; audioUrl?: string };
    expect(silent).not.toHaveProperty('audioId');
    expect(silent).not.toHaveProperty('audioUrl');

    const entries = await pool.query(
      `SELECT e.mime, e.principal, e.committed_at IS NOT NULL AS committed
         FROM asset_entries e WHERE e.id = ANY($1) ORDER BY e.mime`,
      [[byId.img!.src, byId.vid!.src, speech.audioId]],
    );
    expect(entries.rows).toEqual([
      { mime: 'audio/mpeg', principal: `owner:${OWNER}`, committed: true },
      { mime: 'image/png', principal: `owner:${OWNER}`, committed: true },
      { mime: 'video/mp4', principal: `owner:${OWNER}`, committed: true },
    ]);

    // The course that held `taken01` is untouched.
    const taken = await ownerStore(pool, OTHER).loadDocument('taken01');
    expect(taken?.stage.name).toBe('Current course');

    const ledger = await pool.query(
      'SELECT legacy_id, outcome, stage_id, owner_id FROM legacy_classroom_imports ORDER BY legacy_id',
    );
    expect(ledger.rows).toEqual([
      { legacy_id: 'broken01', outcome: 'skipped', stage_id: null, owner_id: null },
      { legacy_id: 'legacy01', outcome: 'imported', stage_id: 'legacy01', owner_id: OWNER },
      { legacy_id: 'reserved01', outcome: 'skipped', stage_id: null, owner_id: null },
      { legacy_id: 'taken01', outcome: 'skipped', stage_id: 'taken01', owner_id: null },
    ]);

    // The files stay where they were.
    await expect(fs.stat(path.join(directory, 'legacy01.json'))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(directory, 'legacy01/media/gen_img_1.png')),
    ).resolves.toBeTruthy();

    // A second boot settles nothing new and allocates nothing.
    const assetCount = await pool.query('SELECT COUNT(*)::int AS n FROM asset_entries');
    const second = await importLegacyClassrooms({ directory, ownerId: OWNER });
    expect(second).toMatchObject({ found: 4, imported: 0, alreadySettled: 4, skipped: 0 });
    const assetCountAfter = await pool.query('SELECT COUNT(*)::int AS n FROM asset_entries');
    expect(assetCountAfter.rows[0].n).toBe(assetCount.rows[0].n);
  });

  it('skips a classroom whose id the owner already holds, leaving that course as it is', async () => {
    await fs.writeFile(
      path.join(directory, 'saved01.json'),
      JSON.stringify(legacyClassroom('saved01', 'Legacy copy')),
    );
    await ownerStore(pool, OWNER).saveDocument({
      stage: { id: 'saved01', name: 'Edited in the browser', createdAt: NOW, updatedAt: NOW },
      scenes: [],
    });

    const summary = await importLegacyClassrooms({ directory, ownerId: OWNER });

    expect(summary).toMatchObject({ imported: 0, skipped: 1, alreadySettled: 4, mediaStored: 0 });
    const course = await ownerStore(pool, OWNER).loadDocument('saved01');
    expect(course?.stage.name).toBe('Edited in the browser');
    expect(course?.scenes).toEqual([]);
    const ledger = await pool.query(
      'SELECT outcome, detail FROM legacy_classroom_imports WHERE legacy_id = $1',
      ['saved01'],
    );
    expect(ledger.rows).toEqual([
      { outcome: 'skipped', detail: 'a course with this id already exists' },
    ]);
  });

  it('never replaces a course created while the import was allocating its media', async () => {
    const dir = await freshDirectory({ 'race01.json': legacyClassroom('race01', 'Legacy') });
    await fs.mkdir(path.join(dir, 'race01/media'), { recursive: true });
    await fs.writeFile(path.join(dir, 'race01/media/gen_img_1.png'), PNG);
    // Another writer of the same owner (a browser import, say) creates the id
    // after the import checked it and before its create.
    assetSeams.beforeStore = () =>
      ownerStore(pool, OWNER).saveDocument({
        stage: { id: 'race01', name: 'Created concurrently', createdAt: NOW, updatedAt: NOW },
        scenes: [],
      });

    const assetsBefore = await ownerAssetCount(OWNER);
    const summary = await importLegacyClassrooms({ directory: dir, ownerId: OWNER });

    expect(summary).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
    const course = await ownerStore(pool, OWNER).loadDocument('race01');
    expect(course?.stage.name).toBe('Created concurrently');
    // The attempt's allocation was released.
    expect(await ownerAssetCount(OWNER)).toBe(assetsBefore);
  });

  it('ends a run at once when another instance holds the import lock', async () => {
    const dir = await freshDirectory({ 'lock01.json': legacyClassroom('lock01', 'Locked') });
    const holder = await admin.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(71310524)');
      const busy = await importLegacyClassrooms({ directory: dir, ownerId: OWNER });
      expect(busy).toMatchObject({ interrupted: 'lock-busy', imported: 0 });
      expect(await ledgerRow('lock01')).toBeUndefined();
    } finally {
      await holder.query('SELECT pg_advisory_unlock(71310524)');
      holder.release();
    }

    const free = await importLegacyClassrooms({ directory: dir, ownerId: OWNER });
    expect(free).toMatchObject({ imported: 1 });
    expect(free.interrupted).toBeUndefined();
  });

  it('counts a failed attempt, releases its media, and settles after three failures', async () => {
    const dir = await freshDirectory({ 'flaky01.json': flakyClassroom('flaky01') });
    await withMedia(dir, 'flaky01', ['a.png', 'b.png']);
    const unreadable = path.join(dir, 'flaky01/media/b.png');
    await fs.chmod(unreadable, 0o000);
    const assetsBefore = await ownerAssetCount(OWNER);
    try {
      for (const attempt of [1, 2]) {
        const run = await importLegacyClassrooms({ directory: dir, ownerId: OWNER });
        expect(run).toMatchObject({ imported: 0, failed: 1, skipped: 0 });
        expect(await ledgerRow('flaky01')).toMatchObject({ outcome: 'failed', attempts: attempt });
        // `a.png` was stored, then released when `b.png` failed.
        expect(await ownerAssetCount(OWNER)).toBe(assetsBefore);
      }
      const third = await importLegacyClassrooms({ directory: dir, ownerId: OWNER });
      expect(third).toMatchObject({ imported: 0, failed: 0, skipped: 1 });
      expect(await ledgerRow('flaky01')).toMatchObject({
        outcome: 'skipped',
        detail: expect.stringMatching(/^repeated failure: EACCES/),
      });
    } finally {
      await fs.chmod(unreadable, 0o644);
    }
    await expect(importLegacyClassrooms({ directory: dir, ownerId: OWNER })).resolves.toMatchObject(
      { alreadySettled: 1, imported: 0 },
    );
  });

  it('settles the failure that reaches the limit in the one statement that counts it', async () => {
    await recordLegacyClassroomFailure(pool, 'atomic01', 'first');
    await recordLegacyClassroomFailure(pool, 'atomic01', 'second');
    // A connection that dies after its first statement: whatever that
    // statement did is all that lands.
    let statements = 0;
    const interrupted = {
      query: (text: string, params?: unknown[]) => {
        statements += 1;
        if (statements > 1) throw new Error('connection lost');
        return pool.query(text, params);
      },
    } as unknown as Parameters<typeof recordLegacyClassroomFailure>[0];

    await expect(recordLegacyClassroomFailure(interrupted, 'atomic01', 'third')).resolves.toEqual({
      attempts: 3,
      settled: true,
    });
    expect(await ledgerRow('atomic01')).toEqual({
      outcome: 'skipped',
      detail: 'repeated failure: third',
      attempts: 3,
    });
  });

  it('never changes a settled row, however many failures follow it', async () => {
    for (const message of ['one', 'two', 'three']) {
      await recordLegacyClassroomFailure(pool, 'settled01', message);
    }
    const settled = await ledgerRow('settled01');

    const again = await Promise.all([
      recordLegacyClassroomFailure(pool, 'settled01', 'late a'),
      recordLegacyClassroomFailure(pool, 'settled01', 'late b'),
    ]);

    expect(again).toEqual([
      { attempts: 3, settled: true },
      { attempts: 3, settled: true },
    ]);
    expect(await ledgerRow('settled01')).toEqual(settled);
  });

  it('counts concurrent failures at the limit once', async () => {
    await recordLegacyClassroomFailure(pool, 'race02', 'one');
    await recordLegacyClassroomFailure(pool, 'race02', 'two');

    const results = await Promise.all([
      recordLegacyClassroomFailure(pool, 'race02', 'three a'),
      recordLegacyClassroomFailure(pool, 'race02', 'three b'),
    ]);

    expect(results.every((result) => result.settled)).toBe(true);
    expect(await ledgerRow('race02')).toMatchObject({ outcome: 'skipped', attempts: 3 });
  });

  it('imports on a later run once a failed attempt stops failing', async () => {
    const dir = await freshDirectory({ 'flaky02.json': flakyClassroom('flaky02') });
    await withMedia(dir, 'flaky02', ['a.png', 'b.png']);
    const unreadable = path.join(dir, 'flaky02/media/b.png');
    await fs.chmod(unreadable, 0o000);
    try {
      await importLegacyClassrooms({ directory: dir, ownerId: OWNER });
    } finally {
      await fs.chmod(unreadable, 0o644);
    }
    expect(await ledgerRow('flaky02')).toMatchObject({ outcome: 'failed', attempts: 1 });

    const retried = await importLegacyClassrooms({ directory: dir, ownerId: OWNER });
    expect(retried).toMatchObject({ imported: 1, failed: 0 });
    expect(await ledgerRow('flaky02')).toMatchObject({ outcome: 'imported' });
  });

  it('stops the whole run at a full asset store, records nothing, and resumes later', async () => {
    const dir = await freshDirectory({
      'quota01.json': flakyClassroom('quota01'),
      'quota02.json': flakyClassroom('quota02'),
    });
    await withMedia(dir, 'quota01', ['a.png', 'b.png']);
    await withMedia(dir, 'quota02', ['a.png', 'b.png']);
    const assetsBefore = await ownerAssetCount(OWNER);
    // The first file of quota01 fits; the second is refused.
    assetSeams.stored = 0;
    assetSeams.refuseAfter = 1;
    try {
      const stopped = await importLegacyClassrooms({ directory: dir, ownerId: OWNER });
      expect(stopped).toMatchObject({ interrupted: 'storage-full', imported: 0, failed: 0 });
    } finally {
      assetSeams.refuseAfter = Infinity;
    }
    expect(await ledgerRow('quota01')).toBeUndefined();
    expect(await ledgerRow('quota02')).toBeUndefined();
    expect(await ownerAssetCount(OWNER)).toBe(assetsBefore);

    const resumed = await importLegacyClassrooms({ directory: dir, ownerId: OWNER });
    expect(resumed).toMatchObject({ imported: 2 });
    expect(resumed.interrupted).toBeUndefined();
  });

  it('settles a create the host refuses as skipped and releases its media', async () => {
    const dir = await freshDirectory({ 'refused01.json': flakyClassroom('refused01') });
    await withMedia(dir, 'refused01', ['a.png', 'b.png']);
    const assetsBefore = await ownerAssetCount(OWNER);
    assetSeams.stored = 0;
    hookSeams.refuseCreate = 'over the course limit';
    try {
      const summary = await importLegacyClassrooms({ directory: dir, ownerId: OWNER });
      expect(summary).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
    } finally {
      hookSeams.refuseCreate = undefined;
    }
    // The real create asked the host, after the media was stored.
    expect(assetSeams.stored).toBe(2);
    expect(await ownerAssetCount(OWNER)).toBe(assetsBefore);
    await expect(ownerStore(pool, OWNER).loadDocument('refused01')).resolves.toBeNull();
    expect(await ledgerRow('refused01')).toMatchObject({
      outcome: 'skipped',
      detail: expect.stringMatching(/^course creation refused: /),
    });
  });

  it('ends a stopped run after the classroom it is on', async () => {
    const dir = await freshDirectory({
      'stop01.json': flakyClassroom('stop01'),
      'stop02.json': flakyClassroom('stop02'),
    });
    await withMedia(dir, 'stop01', ['a.png', 'b.png']);
    await withMedia(dir, 'stop02', ['a.png', 'b.png']);
    const controller = new AbortController();
    // Stop while the first classroom is allocating its media.
    assetSeams.beforeStore = async () => controller.abort();

    const summary = await importLegacyClassrooms({
      directory: dir,
      ownerId: OWNER,
      signal: controller.signal,
    });

    expect(summary).toMatchObject({ interrupted: 'stopped', imported: 1 });
    expect(await ledgerRow('stop01')).toMatchObject({ outcome: 'imported' });
    expect(await ledgerRow('stop02')).toBeUndefined();
  });

  it('imports for the dedicated legacy owner: readable by link, writable by nobody else', async () => {
    const dir = await freshDirectory({ 'shared01.json': legacyClassroom('shared01', 'Shared') });

    await importLegacyClassrooms({ directory: dir, ownerId: LEGACY_CLASSROOM_OWNER_ID });

    const visitor = ownerStore(pool, 'anon:3c1f7e2a-9b4d-4e6f-8a0b-1c2d3e4f5a6b');
    const course = await visitor.loadDocument('shared01');
    expect(course?.stage.name).toBe('Shared');
    expect((await visitor.listDocuments()).map((doc) => doc.id)).not.toContain('shared01');
    await expect(
      visitor.putStage('shared01', { ...course!.stage, name: 'Hijacked' }),
    ).rejects.toThrow();
    const after = await ownerStore(pool, LEGACY_CLASSROOM_OWNER_ID).loadDocument('shared01');
    expect(after?.stage.name).toBe('Shared');
  });

  it('does nothing when the directory does not exist', async () => {
    await expect(
      importLegacyClassrooms({ directory: path.join(directory, 'absent'), ownerId: OWNER }),
    ).resolves.toMatchObject({ found: 0, imported: 0 });
  });
});

describe('resolveLegacyClassroomOwner', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the shared team owner when one answers every request', () => {
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team');
    vi.stubEnv('ACCESS_CODE', 'secret');
    vi.stubEnv('OWNER_SINGLE_USER', '');
    expect(resolveLegacyClassroomOwner()).toBe('team');
  });

  it('uses the single user in single-user mode', () => {
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_SINGLE_USER', 'true');
    vi.stubEnv('OWNER_SINGLE_USER_ID', 'me');
    expect(resolveLegacyClassroomOwner()).toBe('me');
  });

  it('uses the dedicated legacy owner when every visitor is their own owner', () => {
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_SINGLE_USER', '');
    expect(resolveLegacyClassroomOwner()).toBe(LEGACY_CLASSROOM_OWNER_ID);
  });
});
