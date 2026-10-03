/**
 * The material library's organizing routes and agent tools over PGlite: the
 * thin adapters answer what the shared operations decide, under the request
 * owner (routes) or the run's owner (tools). Only owner resolution and the
 * runtime gate are stubbed.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  ownerId: 'user:alice',
}));

vi.mock('@/lib/config/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config/feature-flags')>()),
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(() => mocks.ownerId),
);

import {
  GET as sessionMaterialRoute,
  PATCH as renameMaterialRoute,
} from '@/app/api/materials/[id]/route';
import { GET as sessionMaterialsRoute } from '@/app/api/materials/route';
import {
  DELETE as deleteFolderRoute,
  PATCH as renameFolderRoute,
} from '@/app/api/materials/folders/[id]/route';
import {
  GET as listFoldersRoute,
  POST as createFolderRoute,
} from '@/app/api/materials/folders/route';
import { GET as libraryRoute } from '@/app/api/materials/library/route';
import { POST as moveRoute } from '@/app/api/materials/move/route';
import { claimOwner } from '@/lib/persistence/owner-claims';
import { attachOwnerMaterialsToSession } from '@/lib/persistence/session-material-links';
import { ensureOwnerMaterialExtraction } from '@/lib/persistence/owner-material-extraction';
import { buildMaterialTools } from '@/lib/server/agent-runtime/material-tools';
import { startExtractionWatcher } from '@/lib/server/agent-runtime/extraction-watcher';
import { runNextOwnerExtraction } from '@/lib/server/material-extraction/owner-extraction';
import { buildMaterialLibraryTools } from '@/lib/server/agent-runtime/material-library-tools';
import { presentTool } from '@/components/workbench/chat/tool-presentation';
import { createWorkbenchTranslator } from '@/lib/i18n/workbench';
import type { ChatNode } from '@/lib/workbench/session-store';

import {
  ACCOUNT,
  ANON,
  OTHER,
  bootLibraryHarness,
  seedCopy,
  seedDerivative,
  seedSession,
  type ExtractionScenarioPool,
  type LibraryHarness,
} from '../persistence/_material-library-scenarios';
import { seedSource, stateOf } from '../persistence/_owner-extraction-scenarios';

class PGlitePool implements ExtractionScenarioPool {
  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {}
}

function request(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('material library routes and tools (PGlite)', () => {
  let db: PGlite | undefined;

  async function boot(): Promise<LibraryHarness> {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const databaseUrl = `postgres://library-routes-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    db = new PGlite();
    await db.waitReady;
    return bootLibraryHarness(new PGlitePool(db), databaseUrl);
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    mocks.runtimeConfigured = true;
    mocks.ownerId = ACCOUNT;
    await db?.close();
    db = undefined;
  });

  it('creates, lists, renames and deletes folders for the request owner', async () => {
    const h = await boot();
    const created = await createFolderRoute(
      request('POST', '/api/materials/folders', { name: 'Unit 1' }),
    );
    expect(created.status).toBe(201);
    const { folder } = (await created.json()) as { folder: { id: string } };
    const again = await createFolderRoute(
      request('POST', '/api/materials/folders', { name: 'unit 1' }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, folder: { id: folder.id } });
    const invalid = await createFolderRoute(
      request('POST', '/api/materials/folders', { name: ' ' }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ reason: 'name_empty' });
    await createFolderRoute(request('POST', '/api/materials/folders', { name: 'Unit 2' }));

    const listed = await listFoldersRoute(request('GET', '/api/materials/folders'));
    expect(
      ((await listed.json()) as { folders: Array<{ name: string }> }).folders.map((f) => f.name),
    ).toEqual(['Unit 1', 'Unit 2']);

    const taken = await renameFolderRoute(
      request('PATCH', `/api/materials/folders/${folder.id}`, { name: 'UNIT 2' }),
      params(folder.id),
    );
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ reason: 'name_taken' });
    const renamed = await renameFolderRoute(
      request('PATCH', `/api/materials/folders/${folder.id}`, { name: 'Cells' }),
      params(folder.id),
    );
    expect(await renamed.json()).toMatchObject({ status: 'renamed', folder: { name: 'Cells' } });

    await seedSource(h, 'src-a');
    await moveRoute(
      request('POST', '/api/materials/move', { materialIds: ['src-a'], folderId: folder.id }),
    );
    const notEmpty = await deleteFolderRoute(
      request('DELETE', `/api/materials/folders/${folder.id}`),
      params(folder.id),
    );
    expect(notEmpty.status).toBe(409);
    expect(await notEmpty.json()).toMatchObject({ reason: 'not_empty' });

    // Another owner sees none of it.
    mocks.ownerId = OTHER;
    expect(
      (
        await renameFolderRoute(
          request('PATCH', `/api/materials/folders/${folder.id}`, { name: 'Mine' }),
          params(folder.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await deleteFolderRoute(
          request('DELETE', `/api/materials/folders/${folder.id}`),
          params(folder.id),
        )
      ).status,
    ).toBe(404);
    mocks.ownerId = ACCOUNT;

    await moveRoute(
      request('POST', '/api/materials/move', { materialIds: ['src-a'], folderId: null }),
    );
    const deleted = await deleteFolderRoute(
      request('DELETE', `/api/materials/folders/${folder.id}`),
      params(folder.id),
    );
    expect(deleted.status).toBe(204);
  });

  it('moves all or nothing and renames sources only', async () => {
    const h = await boot();
    await seedSource(h, 'src-a');
    await seedDerivative(h, 'img-a1', 'src-a');
    const made = await createFolderRoute(
      request('POST', '/api/materials/folders', { name: 'Unit 1' }),
    );
    const { folder } = (await made.json()) as { folder: { id: string } };

    const refused = await moveRoute(
      request('POST', '/api/materials/move', {
        materialIds: ['src-a', 'img-a1'],
        folderId: folder.id,
      }),
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ reason: 'not_movable', materialIds: ['img-a1'] });
    expect((await stateOf(h, 'src-a')).folder_id).toBeNull();

    const moved = await moveRoute(
      request('POST', '/api/materials/move', { materialIds: ['src-a'], folderId: folder.id }),
    );
    expect(await moved.json()).toMatchObject({ status: 'moved' });
    expect((await stateOf(h, 'img-a1')).folder_id).toBe(folder.id);
    expect(
      (
        await moveRoute(
          request('POST', '/api/materials/move', { materialIds: ['src-a'], folderId: 'nope' }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await moveRoute(request('POST', '/api/materials/move', { materialIds: [], folderId: null })))
        .status,
    ).toBe(400);

    const renamed = await renameMaterialRoute(
      request('PATCH', '/api/materials/src-a', { name: 'Lesson 1' }),
      params('src-a'),
    );
    expect(await renamed.json()).toEqual({
      status: 'renamed',
      materialId: 'src-a',
      name: 'Lesson 1',
    });
    const derivative = await renameMaterialRoute(
      request('PATCH', '/api/materials/img-a1', { name: 'Mine' }),
      params('img-a1'),
    );
    expect(derivative.status).toBe(409);
    mocks.ownerId = OTHER;
    expect(
      (
        await renameMaterialRoute(
          request('PATCH', '/api/materials/src-a', { name: 'Mine' }),
          params('src-a'),
        )
      ).status,
    ).toBe(404);
  });

  it('refuses a retired owner’s request, while a run of it keeps organizing for the account', async () => {
    const h = await boot();
    await seedSource(h, 'src-anon', { owner: ANON });
    await claimOwner(ANON, ACCOUNT, { provider: h.provider });

    mocks.ownerId = ANON;
    const late = await createFolderRoute(
      request('POST', '/api/materials/folders', { name: 'Late' }),
    );
    expect(late.status).toBe(403);

    const tools = buildMaterialLibraryTools({ ownerId: ANON });
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((tool) => tool.name === name)!.execute('call', args as never) as Promise<{
        details: Record<string, unknown>;
        isError?: boolean;
      }>;
    const folder = await run('create_material_folder', { name: 'From the run' });
    expect(folder.details).toMatchObject({ status: 'created', created: true });
    expect(
      (
        await run('move_materials', {
          materialIds: ['src-anon'],
          folderId: folder.details.folderId,
        })
      ).details,
    ).toMatchObject({ status: 'moved' });
    expect(
      (await run('rename_material', { materialId: 'src-anon', name: 'Renamed' })).details,
    ).toMatchObject({
      status: 'renamed',
    });
    const listed = await run('list_material_folders', {});
    expect(listed.details.folders).toEqual([
      { folderId: folder.details.folderId, name: 'From the run', materialCount: 1 },
    ]);
    const refused = await run('move_materials', { materialIds: ['missing'], folderId: null });
    expect(refused).toMatchObject({ isError: true, details: { status: 'not_movable' } });
  });

  it('tells the client only about changes the run actually made', async () => {
    const h = await boot();
    await seedSource(h, 'src-a');
    const changes: unknown[] = [];
    const tools = buildMaterialLibraryTools({
      ownerId: ACCOUNT,
      onLibraryChanged: (change) => changes.push(change),
    });
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((tool) => tool.name === name)!.execute('call', args as never) as Promise<{
        details: Record<string, unknown>;
      }>;
    const folder = await run('create_material_folder', { name: 'Unit 1' });
    await run('create_material_folder', { name: 'unit 1' });
    await run('rename_material_folder', { folderId: folder.details.folderId, name: 'Unit 1' });
    await run('move_materials', { materialIds: ['src-a'], folderId: folder.details.folderId });
    await run('move_materials', { materialIds: ['src-a'], folderId: folder.details.folderId });
    await run('move_materials', { materialIds: ['missing'], folderId: null });
    await run('rename_material', { materialId: 'src-a', name: 'src-a.pdf' });
    await run('rename_material', { materialId: 'src-a', name: 'Lesson' });
    expect(changes).toEqual([
      { library: 'materials', change: 'folder_created', folderId: folder.details.folderId },
      {
        library: 'materials',
        change: 'materials_moved',
        materialIds: ['src-a'],
        folderId: folder.details.folderId,
      },
      { library: 'materials', change: 'material_renamed', materialId: 'src-a' },
    ]);
  });

  it('reports an extraction that settles after a wait timed out, without another wait', async () => {
    const h = await boot();
    await seedSource(h, 'src-a');
    await seedSession(h, 'ses-1');
    const changes: unknown[] = [];
    const watcher = startExtractionWatcher({
      intervalMs: 20,
      onSettled: (materialIds) =>
        changes.push({ library: 'materials', change: 'extraction_settled', materialIds }),
    });
    let clock = 0;
    const materialTools = buildMaterialTools({
      sessionId: 'ses-1',
      now: () => clock,
      waitForDelay: async (milliseconds) => {
        clock += milliseconds;
      },
      onLibraryChanged: (change) => changes.push(change),
      extractionWatcher: watcher,
    });
    const tool = (name: string) => materialTools.find((candidate) => candidate.name === name)!;
    try {
      await tool('extract_material').execute('call', {
        materialId: 'src-a',
        scope: 'library',
      } as never);
      // Started again: already pending, not started a second time, no second event.
      await tool('extract_material').execute('call', {
        materialId: 'src-a',
        scope: 'library',
      } as never);
      const waited = (await tool('wait_for_materials').execute('call', {
        materialIds: ['src-a'],
        scope: 'library',
        timeoutSec: 1,
      } as never)) as { details: { timedOut: boolean } };
      expect(waited.details.timedOut).toBe(true);
      expect(changes).toEqual([
        { library: 'materials', change: 'extraction_started', materialIds: ['src-a'] },
      ]);

      // The worker finishes later; the agent does not wait again.
      expect(await runNextOwnerExtraction(h.deps())).toBe(true);
      for (let attempt = 0; attempt < 200 && changes.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(changes).toEqual([
        { library: 'materials', change: 'extraction_started', materialIds: ['src-a'] },
        { library: 'materials', change: 'extraction_settled', materialIds: ['src-a'] },
      ]);

      // A later wait that sees it done reports nothing more.
      await tool('wait_for_materials').execute('call', {
        materialIds: ['src-a'],
        scope: 'library',
        timeoutSec: 1,
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(changes).toHaveLength(2);
    } finally {
      watcher.stop();
    }
  });

  it('reports a settlement a wait sees once, and nothing for a source the run never watched', async () => {
    const h = await boot();
    await seedSource(h, 'src-a');
    await seedSource(h, 'src-done');
    await h.pool.query(
      `UPDATE owner_material SET extraction = '{"status":"done"}'::jsonb WHERE id = 'src-done'`,
    );
    await seedSession(h, 'ses-1');
    const settled: string[][] = [];
    const watcher = startExtractionWatcher({
      intervalMs: 60_000,
      onSettled: (materialIds) => settled.push(materialIds),
    });
    const materialTools = buildMaterialTools({
      sessionId: 'ses-1',
      waitForDelay: async () => undefined,
      extractionWatcher: watcher,
    });
    const tool = (name: string) => materialTools.find((candidate) => candidate.name === name)!;
    try {
      await tool('extract_material').execute('call', {
        materialId: 'src-a',
        scope: 'library',
      } as never);
      await h.pool.query(
        `UPDATE owner_material SET extraction = '{"status":"failed"}'::jsonb,
                extraction_error = 'unreadable' WHERE id = 'src-a'`,
      );
      for (let round = 0; round < 2; round += 1) {
        await tool('wait_for_materials').execute('call', {
          materialIds: ['src-a', 'src-done'],
          scope: 'library',
          timeoutSec: 1,
        } as never);
      }
      expect(settled).toEqual([['src-a']]);
    } finally {
      watcher.stop();
    }
  });

  it('reports a settlement during a wait that first saw the source in progress', async () => {
    const h = await boot();
    await seedSource(h, 'src-a');
    await seedSession(h, 'ses-1');
    // Started by an earlier run: this run never extracted it, it only waits.
    await ensureOwnerMaterialExtraction(h.provider.withTransaction, ACCOUNT, 'src-a');
    const settled: string[][] = [];
    const watcher = startExtractionWatcher({
      intervalMs: 60_000,
      onSettled: (materialIds) => settled.push(materialIds),
    });
    const wait = buildMaterialTools({
      sessionId: 'ses-1',
      // The worker finishes while the wait is between two looks.
      waitForDelay: async () => {
        await runNextOwnerExtraction(h.deps());
      },
      extractionWatcher: watcher,
    }).find((candidate) => candidate.name === 'wait_for_materials')!;
    try {
      const waited = (await wait.execute('call', {
        materialIds: ['src-a'],
        scope: 'library',
        timeoutSec: 1,
      } as never)) as { details: { complete: boolean } };
      expect(waited.details.complete).toBe(true);
      expect(settled).toEqual([['src-a']]);
    } finally {
      watcher.stop();
    }
  });

  /** ses-1 holds a pre-link copy and links src-a (with img-a1); src-loose is not attached. */
  async function seedLinkedConversation(h: LibraryHarness): Promise<void> {
    await seedSession(h, 'ses-1');
    await seedSession(h, 'ses-other', OTHER);
    await seedSource(h, 'src-a');
    await seedSource(h, 'src-loose');
    await seedDerivative(h, 'img-a1', 'src-a');
    await seedCopy(h, 'ses-1', 'mat_copy', null);
    await attachOwnerMaterialsToSession(h.provider, {
      sessionId: 'ses-1',
      ownerId: ACCOUNT,
      materialIds: ['src-a'],
    });
  }

  it('lists a conversation’s linked materials after its own rows, on one cursor', async () => {
    await seedLinkedConversation(await boot());
    const list = async (query: string) => {
      const response = await sessionMaterialsRoute(
        request('GET', `/api/materials?sessionId=ses-1${query}`),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { materials: Array<Record<string, unknown>> }).materials;
    };

    const all = await list('');
    expect(all.map((m) => m.materialId)).toEqual(['mat_copy', 'src-a', 'img-a1']);
    expect(all[1]).toMatchObject({ kind: 'source', extraction: { status: 'idle' } });
    expect(all[2]).toMatchObject({ kind: 'image', derivedFrom: 'src-a' });
    // Pool pointers, object keys and digests stay on the server.
    for (const material of all) {
      for (const key of ['assetId', 'ossKey', 'sha256', 'ownerId', 'rawAssetId', 'textAssetId']) {
        expect(material).not.toHaveProperty(key);
      }
    }
    // One cursor pages across both kinds of row.
    const pages: unknown[] = [];
    let before = '';
    for (let page = 0; page < 4; page += 1) {
      const rows = await list(`&limit=1${before ? `&before=${before}` : ''}`);
      pages.push(rows.map((m) => m.materialId));
      if (rows.length === 0) break;
      before = String(rows[0]!.materialId);
    }
    expect(pages).toEqual([['mat_copy'], ['src-a'], ['img-a1'], []]);
    expect(await list('&limit=2&before=missing')).toEqual([]);
    expect(
      (await sessionMaterialsRoute(request('GET', '/api/materials?sessionId=ses-other'))).status,
    ).toBe(404);
  });

  it('reads one linked material of a conversation by its id', async () => {
    await seedLinkedConversation(await boot());
    const read = (id: string, sessionId = 'ses-1') =>
      sessionMaterialRoute(
        request('GET', `/api/materials/${id}?sessionId=${sessionId}`),
        params(id),
      );

    const linked = await read('src-a');
    expect(linked.status).toBe(200);
    const { material } = (await linked.json()) as { material: Record<string, unknown> };
    expect(material).toMatchObject({ materialId: 'src-a', kind: 'source' });
    for (const key of ['assetId', 'ossKey', 'sha256', 'ownerId']) {
      expect(material).not.toHaveProperty(key);
    }
    expect((await read('img-a1')).status).toBe(200);
    expect((await read('mat_copy')).status).toBe(200);
    // Unattached, or another owner's conversation: the same 404.
    expect((await read('src-loose')).status).toBe(404);
    expect((await read('src-a', 'ses-other')).status).toBe(404);
  });

  it('lists the owner’s library with the limits and usage uploads are held to', async () => {
    const h = await boot();
    await seedSource(h, 'src-a', { bytes: Buffer.from('12345') });
    await seedSource(h, 'src-b', { bytes: Buffer.from('123') });
    await seedDerivative(h, 'img-a1', 'src-a');
    await seedSource(h, 'src-foreign', { owner: OTHER });
    const made = await createFolderRoute(
      request('POST', '/api/materials/folders', { name: 'Unit 1' }),
    );
    const { folder } = (await made.json()) as { folder: { id: string } };
    await moveRoute(
      request('POST', '/api/materials/move', { materialIds: ['src-b'], folderId: folder.id }),
    );
    await ensureOwnerMaterialExtraction(h.provider.withTransaction, ACCOUNT, 'src-a');
    await h.pool.query(
      `UPDATE owner_material SET extraction = '{"status":"failed"}'::jsonb,
              extraction_error = 'the asset store has no room for this extraction' WHERE id = 'src-a'`,
    );
    vi.stubEnv('ASSET_QUOTA_BYTES', '0');

    const listed = await libraryRoute(request('GET', '/api/materials/library'));
    const body = (await listed.json()) as {
      materials: Array<Record<string, unknown>>;
      limits: Record<string, unknown>;
    };
    expect(body.materials.map((m) => m.materialId).sort()).toEqual(['img-a1', 'src-a', 'src-b']);
    expect(body.materials.find((m) => m.materialId === 'src-a')).toMatchObject({
      name: 'src-a.pdf',
      folderId: null,
      extraction: { status: 'failed', reason: 'the asset store has no room for this extraction' },
    });
    expect(JSON.stringify(body)).not.toMatch(/ossKey|assetId|sha256|objects\//);
    expect(body.limits).toMatchObject({
      usedCount: 2,
      usedBytes: 8,
      assetQuotaBytes: null,
      maxCount: expect.any(Number),
      maxTotalBytes: expect.any(Number),
      documentMaxBytes: expect.any(Number),
      mediaMaxBytes: expect.any(Number),
      assetUsedBytes: expect.any(Number),
    });

    const unfiled = await libraryRoute(request('GET', '/api/materials/library?folderId=unfiled'));
    expect(
      ((await unfiled.json()) as { materials: Array<{ materialId: string }> }).materials
        .map((m) => m.materialId)
        .sort(),
    ).toEqual(['img-a1', 'src-a']);
    const inFolder = await libraryRoute(
      request('GET', `/api/materials/library?folderId=${folder.id}`),
    );
    expect(
      ((await inFolder.json()) as { materials: Array<{ materialId: string }> }).materials.map(
        (m) => m.materialId,
      ),
    ).toEqual(['src-b']);

    vi.stubEnv('ASSET_QUOTA_BYTES', '5000');
    const quota = await libraryRoute(request('GET', '/api/materials/library'));
    expect(
      ((await quota.json()) as { limits: { assetQuotaBytes: number } }).limits.assetQuotaBytes,
    ).toBe(5000);
    expect((await libraryRoute(request('GET', '/api/materials/library?limit=0'))).status).toBe(400);
  });

  it('counts in the tool row only the sources that actually moved', async () => {
    const h = await boot();
    await seedSource(h, 'src-in');
    await seedSource(h, 'src-out');
    await seedDerivative(h, 'img-out', 'src-out');
    const tools = buildMaterialLibraryTools({ ownerId: ACCOUNT });
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((tool) => tool.name === name)!.execute('call', args as never) as Promise<{
        details: Record<string, unknown>;
      }>;
    const folder = await run('create_material_folder', { name: 'Unit 1' });
    await run('move_materials', { materialIds: ['src-in'], folderId: folder.details.folderId });

    const moved = await run('move_materials', {
      materialIds: ['src-in', 'src-out'],
      folderId: folder.details.folderId,
    });
    // One source moved (its derivative with it, not counted); one was there already.
    expect(moved.details).toMatchObject({ status: 'moved', movedCount: 1 });
    const row = presentTool(
      {
        key: 'k',
        kind: 'tool',
        text: '',
        toolCallId: 'c',
        toolName: 'move_materials',
        toolArgs: {},
        toolState: 'done',
        toolDetails: moved.details,
      } as ChatNode,
      [],
      createWorkbenchTranslator('en-US'),
    );
    expect(row.chips.map((chip) => chip.label)).toEqual(['1 materials']);
  });

  it('lists sources only, with folder names and what a conversation has attached', async () => {
    const h = await boot();
    await seedSession(h, 'ses-1');
    await seedSession(h, 'ses-other', OTHER);
    await seedSource(h, 'src-linked');
    await seedSource(h, 'src-loose');
    await seedDerivative(h, 'img-linked', 'src-linked');
    const made = await createFolderRoute(
      request('POST', '/api/materials/folders', { name: 'Unit 1' }),
    );
    const { folder } = (await made.json()) as { folder: { id: string } };
    await moveRoute(
      request('POST', '/api/materials/move', { materialIds: ['src-linked'], folderId: folder.id }),
    );
    await attachOwnerMaterialsToSession(h.provider, {
      sessionId: 'ses-1',
      ownerId: ACCOUNT,
      materialIds: ['src-linked'],
    });

    const listed = await libraryRoute(
      request('GET', '/api/materials/library?sources=1&sessionId=ses-1'),
    );
    const body = (await listed.json()) as { materials: Array<Record<string, unknown>> };
    expect(
      body.materials
        .map((m) => [m.materialId, m.attached, m.folderName ?? null])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['src-linked', true, 'Unit 1'],
      ['src-loose', false, null],
    ]);
    // Without a conversation, nothing says attached.
    const plain = await libraryRoute(request('GET', '/api/materials/library?sources=1'));
    expect(
      ((await plain.json()) as { materials: Array<Record<string, unknown>> }).materials.every(
        (m) => !('attached' in m),
      ),
    ).toBe(true);
    // Another owner's conversation is not one to ask about.
    expect(
      (await libraryRoute(request('GET', '/api/materials/library?sessionId=ses-other'))).status,
    ).toBe(404);
  });

  it('answers 404 without the configured runtime', async () => {
    await boot();
    mocks.runtimeConfigured = false;
    expect((await listFoldersRoute(request('GET', '/api/materials/folders'))).status).toBe(404);
    expect(
      (
        await moveRoute(
          request('POST', '/api/materials/move', { materialIds: ['x'], folderId: null }),
        )
      ).status,
    ).toBe(404);
    // Every route of the library, so no entry point outlives the gate.
    const answers = await Promise.all([
      createFolderRoute(request('POST', '/api/materials/folders', { name: 'X' })),
      renameFolderRoute(request('PATCH', '/api/materials/folders/f', { name: 'X' }), params('f')),
      deleteFolderRoute(request('DELETE', '/api/materials/folders/f'), params('f')),
      renameMaterialRoute(request('PATCH', '/api/materials/m', { name: 'X' }), params('m')),
      libraryRoute(request('GET', '/api/materials/library')),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404, 404]);
  });
});
