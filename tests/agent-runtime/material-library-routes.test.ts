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
  invalidCredential: false,
}));

vi.mock('@/lib/config/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config/feature-flags')>()),
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/identity/resolve', async () => {
  const actual = (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    () => mocks.ownerId,
  );
  return {
    resolveRequestOwner: (req: NextRequest) =>
      mocks.invalidCredential ? Promise.resolve({ ok: false }) : actual.resolveRequestOwner(req),
  };
});

import {
  DELETE as deleteMaterialRoute,
  GET as sessionMaterialRoute,
  PATCH as renameMaterialRoute,
} from '@/app/api/materials/[id]/route';
import { POST as extractionRoute } from '@/app/api/materials/[id]/extraction/route';
import { GET as originalRoute } from '@/app/api/materials/[id]/original/route';
import { GET as sessionMaterialsRoute, POST as uploadRoute } from '@/app/api/materials/route';
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
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import * as libraryView from '@/lib/server/materials/library-view';
import * as materialLibrary from '@/lib/persistence/material-library';
import { registerOwnerMaterial } from '@/lib/persistence/owner-materials';
import { claimOwner } from '@/lib/persistence/owner-claims';
import { attachOwnerMaterialsToSession } from '@/lib/persistence/session-material-links';
import { ensureOwnerMaterialExtraction } from '@/lib/persistence/owner-material-extraction';
import { buildMaterialTools } from '@/lib/server/agent-runtime/material-tools';
import { startExtractionWatcher } from '@/lib/server/agent-runtime/extraction-watcher';
import { runNextOwnerExtraction } from '@/lib/server/material-extraction/owner-extraction';
import { buildMaterialLibraryTools } from '@/lib/server/agent-runtime/material-library-tools';
import { contentDisposition } from '@/lib/server/materials/original-response';
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
  seedPoolSource,
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
    mocks.invalidCredential = false;
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

    const tools = buildMaterialLibraryTools({ ownerId: ANON, sessionId: 'ses-run' });
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

  it.each(['same id', 'absent', 'other session', 'different id'] as const)(
    'reports legacy session copies only for this conversation and same id: %s',
    async (copy) => {
      const h = await boot();
      await seedSource(h, 'shadow-source');
      await seedSession(h, 'ses-run');
      await seedSession(h, 'ses-other');
      if (copy !== 'absent') {
        await seedCopy(
          h,
          copy === 'other session' ? 'ses-other' : 'ses-run',
          copy === 'different id' ? 'different-copy' : 'shadow-source',
          'shadow-source',
        );
      }
      const before = await h.pool.query(
        'SELECT * FROM agent_session_materials ORDER BY session_id, id',
      );
      const tools = buildMaterialLibraryTools({ ownerId: ACCOUNT, sessionId: 'ses-run' });
      const run = (name: string, args: Record<string, unknown>) =>
        tools.find((tool) => tool.name === name)!.execute('call', args as never);
      const folder = await createFolderRoute(
        request('POST', '/api/materials/folders', { name: 'Copy target' }),
      );
      const { folder: target } = (await folder.json()) as { folder: { id: string } };
      const expectedResults = [
        { status: 'renamed', materialId: 'shadow-source', name: 'Library name' },
        { status: 'moved', materialIds: ['shadow-source'], folderId: target.id, movedCount: 1 },
      ];
      const actual = [
        await run('rename_material', { materialId: 'shadow-source', name: 'Library name' }),
        await run('move_materials', { materialIds: ['shadow-source'], folderId: target.id }),
      ];
      actual.forEach((value, index) => {
        const details = expectedResults[index]!;
        const text = JSON.stringify(details, null, 2);
        expect(value).toEqual({
          details: copy === 'same id' ? { ...details, sessionCopyIds: ['shadow-source'] } : details,
          content: [
            {
              type: 'text',
              text:
                copy === 'same id'
                  ? `${text}\nThis conversation reads its own earlier copy of shadow-source; the copy keeps its previous name and folder.`
                  : text,
            },
          ],
        });
      });
      expect(
        (
          await h.pool.query('SELECT display_name, folder_id FROM owner_material WHERE id = $1', [
            'shadow-source',
          ])
        ).rows[0],
      ).toMatchObject({
        display_name: 'Library name',
        folder_id: target.id,
      });
      expect(
        (await h.pool.query('SELECT * FROM agent_session_materials ORDER BY session_id, id')).rows,
      ).toEqual(before.rows);
    },
  );

  it.each(['rename_material', 'move_materials'] as const)(
    'keeps committed %s successful when the session-copy notice query fails',
    async (name) => {
      const h = await boot();
      await seedSource(h, 'notice-failure');
      await seedSession(h, 'ses-run');
      await seedCopy(h, 'ses-run', 'notice-failure', 'notice-failure');
      const folder = await createFolderRoute(
        request('POST', '/api/materials/folders', { name: 'Failure target' }),
      );
      const { folder: target } = (await folder.json()) as { folder: { id: string } };
      const tools = buildMaterialLibraryTools({ ownerId: ACCOUNT, sessionId: 'ses-run' });
      const originalQuery = h.pool.query.bind(h.pool);
      const query = vi.spyOn(h.pool, 'query').mockImplementation(async (sql, params) => {
        if (sql.startsWith('SELECT id FROM agent_session_materials WHERE session_id')) {
          throw new Error('notice query unavailable');
        }
        return originalQuery(sql, params);
      });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const args =
          name === 'rename_material'
            ? { materialId: 'notice-failure', name: 'Committed' }
            : { materialIds: ['notice-failure'], folderId: target.id };
        const expected =
          name === 'rename_material'
            ? { status: 'renamed', materialId: 'notice-failure', name: 'Committed' }
            : {
                status: 'moved',
                materialIds: ['notice-failure'],
                folderId: target.id,
                movedCount: 1,
              };
        const value = await tools
          .find((tool) => tool.name === name)!
          .execute('call', args as never);
        expect(value).toEqual({
          details: expected,
          content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
        });
        expect(warning).toHaveBeenCalledWith(
          '[MaterialLibraryTools] Session-copy notice unavailable',
        );
        expect(
          (
            await originalQuery(
              'SELECT display_name, folder_id FROM owner_material WHERE id = $1',
              ['notice-failure'],
            )
          ).rows[0],
        ).toMatchObject(
          name === 'rename_material' ? { display_name: 'Committed' } : { folder_id: target.id },
        );
        expect(
          (
            await originalQuery<{ title: string }>(
              'SELECT title FROM agent_session_materials WHERE id = $1',
              ['notice-failure'],
            )
          ).rows,
        ).toEqual([{ title: 'copy.pdf' }]);
      } finally {
        query.mockRestore();
        warning.mockRestore();
      }
    },
  );

  it('tells the client only about changes the run actually made', async () => {
    const h = await boot();
    await seedSource(h, 'src-a');
    const changes: unknown[] = [];
    const tools = buildMaterialLibraryTools({
      sessionId: 'ses-run',
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

  it('returns only whitelisted extraction codes on all owner HTTP projections', async () => {
    const h = await boot();
    await seedLinkedConversation(h);
    for (const [status, code, expected] of [
      ['failed', 'storage_full', { status: 'failed', reasonCode: 'storage_full' }],
      ['failed', 'future_code', { status: 'failed' }],
      ['failed', undefined, { status: 'failed' }],
      ['pending', 'storage_full', { status: 'pending' }],
    ] as const) {
      await h.pool.query(
        `UPDATE owner_material SET extraction = $1::jsonb, extraction_error = 'PRIVATE_UPSTREAM_BODY' WHERE id = 'src-a'`,
        [JSON.stringify({ status, reasonCode: code, reason: 'PRIVATE_UPSTREAM_BODY' })],
      );
      const library = await libraryRoute(request('GET', '/api/materials/library'));
      const session = await sessionMaterialsRoute(request('GET', '/api/materials?sessionId=ses-1'));
      const detail = await sessionMaterialRoute(
        request('GET', '/api/materials/src-a?sessionId=ses-1'),
        params('src-a'),
      );
      for (const response of [library, session, detail]) {
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(JSON.stringify(body)).not.toContain('PRIVATE_UPSTREAM_BODY');
        const material =
          body.material ??
          body.materials.find((item: { materialId: string }) => item.materialId === 'src-a');
        expect(material.extraction).toEqual(expected);
      }
    }
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
    // Upload reservations count even before they appear in the ready listing.
    await registerOwnerMaterial(
      h.pool as never,
      {
        id: 'uploading',
        ownerId: ACCOUNT,
        kind: 'source',
        bytes: 11,
        originalName: 'uploading.pdf',
        mime: 'application/pdf',
        ossKey: 'pending-upload',
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
    // Pool usage counts logical entries, including pending allocations, rather
    // than source bytes or deduplicated physical blobs.
    const put = (owner: string, text: string) =>
      h.provider.assetStore.put({ key: `owner:${owner}` }, new Blob([text]), {
        contentType: 'text/plain',
      });
    await put(ACCOUNT, '1234567');
    const course = await put(ACCOUNT, '1234567');
    await h.pool.query('UPDATE asset_entries SET committed_at = now() WHERE id = $1', [course]);
    const released = await put(ACCOUNT, 'released-bytes');
    await h.pool.query('UPDATE asset_entries SET unreferenced_at = now() WHERE id = $1', [
      released,
    ]);
    await put(OTHER, 'foreign-bytes');
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
      extraction: { status: 'failed' },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /ossKey|assetId|sha256|objects\/|the asset store has no room/,
    );
    expect(body.limits).toMatchObject({
      usedCount: 3,
      usedBytes: 19,
      assetQuotaBytes: null,
      maxCount: expect.any(Number),
      maxTotalBytes: expect.any(Number),
      documentMaxBytes: expect.any(Number),
      mediaMaxBytes: expect.any(Number),
      assetUsedBytes: 14,
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

  it('skips usage only for exact limits=0 and queries folder names without counts', async () => {
    const h = await boot();
    await seedSource(h, 'lookup-source');
    const made = await createFolderRoute(
      request('POST', '/api/materials/folders', { name: 'Lookup' }),
    );
    const { folder } = (await made.json()) as { folder: { id: string } };
    await moveRoute(
      request('POST', '/api/materials/move', {
        materialIds: ['lookup-source'],
        folderId: folder.id,
      }),
    );
    const limits = vi.spyOn(libraryView, 'libraryLimits');
    const usage = vi.spyOn(materialLibrary, 'ownerLibraryUsage');
    const queries = vi.spyOn(h.pool, 'query');
    try {
      const normal = await libraryRoute(request('GET', '/api/materials/library'));
      const normalBody = await normal.json();
      expect(normalBody).toHaveProperty('limits');
      expect(normalBody.materials).toMatchObject([{ folderName: 'Lookup' }]);
      expect(limits).toHaveBeenCalledTimes(1);
      expect(usage).toHaveBeenCalledTimes(1);
      for (const value of ['0', '1', '00', '', 'false', '%200']) {
        limits.mockClear();
        usage.mockClear();
        queries.mockClear();
        const response = await libraryRoute(
          request('GET', `/api/materials/library?limits=${value}`),
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        if (value === '0') {
          const { limits: _limits, ...withoutLimits } = normalBody;
          expect(body).toEqual(withoutLimits);
          expect(limits.mock.calls.length).toBe(0);
          expect(usage.mock.calls.length).toBe(0);
        } else {
          expect(body).toEqual(normalBody);
          expect(limits).toHaveBeenCalledTimes(1);
          expect(usage).toHaveBeenCalledTimes(1);
        }
        const folderQueries = queries.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => /FROM material_folders\b/i.test(sql));
        expect(folderQueries).toHaveLength(1);
        expect(folderQueries[0]).not.toMatch(/COUNT|owner_material/i);
        expect(folderQueries[0]).toMatch(/SELECT id, name FROM material_folders/i);
      }
    } finally {
      limits.mockRestore();
      usage.mockRestore();
      queries.mockRestore();
    }
  });

  it('counts in the tool row only the sources that actually moved', async () => {
    const h = await boot();
    await seedSource(h, 'src-in');
    await seedSource(h, 'src-out');
    await seedDerivative(h, 'img-out', 'src-out');
    const tools = buildMaterialLibraryTools({ ownerId: ACCOUNT, sessionId: 'ses-run' });
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
      deleteMaterialRoute(request('DELETE', '/api/materials/m'), params('m')),
      libraryRoute(request('GET', '/api/materials/library')),
      originalRoute(request('GET', '/api/materials/m/original'), params('m')),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
  });
  it('deletes only a ready source for the request owner, with an empty 204', async () => {
    const h = await boot();
    await seedSource(h, 'delete-source');
    await seedSession(h, 'ses-1');
    await attachOwnerMaterialsToSession(h.provider, {
      sessionId: 'ses-1',
      ownerId: ACCOUNT,
      materialIds: ['delete-source'],
    });
    await seedDerivative(h, 'delete-image', 'delete-source');
    await seedSource(h, 'delete-foreign', { owner: OTHER });
    const remove = (id: string) =>
      deleteMaterialRoute(request('DELETE', `/api/materials/${id}`), params(id));
    const derivative = await remove('delete-image');
    expect(derivative.status).toBe(409);
    expect(await derivative.json()).toMatchObject({ reason: 'derivative' });
    for (const id of ['missing', 'delete-foreign']) expect((await remove(id)).status).toBe(404);
    const response = await remove('delete-source');
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect((await remove('delete-source')).status).toBe(404);
    expect(
      (
        await sessionMaterialRoute(
          request('GET', '/api/materials/delete-source?sessionId=ses-1'),
          params('delete-source'),
        )
      ).status,
    ).toBe(404);
  });

  it('refuses source deletion by a retired request owner', async () => {
    const h = await boot();
    await seedSource(h, 'delete-retired', { owner: ANON });
    await claimOwner(ANON, ACCOUNT, { provider: h.provider });
    mocks.ownerId = ANON;
    const response = await deleteMaterialRoute(
      request('DELETE', '/api/materials/delete-retired'),
      params('delete-retired'),
    );
    expect(response.status).toBe(403);
    expect(
      (
        await h.pool.query('SELECT deleted_at FROM owner_material WHERE id = $1', [
          'delete-retired',
        ])
      ).rows,
    ).toEqual([{ deleted_at: null }]);
  });
  it('keeps the successful DELETE response when legacy byte deletion fails', async () => {
    const h = await boot();
    await seedSource(h, 'delete-legacy-failed');
    setMaterialByteStoreForTests({
      put: async () => undefined,
      get: async () => Buffer.from('old'),
      delete: async () => {
        throw new Error('legacy store unavailable');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await deleteMaterialRoute(
        request('DELETE', '/api/materials/delete-legacy-failed'),
        params('delete-legacy-failed'),
      );
      expect(response.status).toBe(204);
      expect(warn).toHaveBeenCalled();
      expect(
        (
          await h.pool.query('SELECT oss_key, deleted_at FROM owner_material WHERE id = $1', [
            'delete-legacy-failed',
          ])
        ).rows[0],
      ).toMatchObject({ oss_key: 'objects/delete-legacy-failed', deleted_at: expect.anything() });
    } finally {
      warn.mockRestore();
    }
  });

  it('R8 starts parsing an upload: 201 pending, listed pending, then the scanner takes it to done', async () => {
    const h = await boot();
    const bytes = Buffer.from('%PDF-r8 upload');
    const response = await uploadRoute(
      new NextRequest('http://localhost/api/materials', {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', 'x-material-filename': 'r8.pdf' },
        body: bytes as BodyInit,
      }),
    );
    expect(response.status).toBe(201);
    const uploaded = (await response.json()) as {
      materialId: string;
      extraction: { status: string };
    };
    expect(uploaded.extraction).toEqual({ status: 'pending' });
    const id = uploaded.materialId;
    const listedStatus = async () => {
      const listed = (await (
        await libraryRoute(request('GET', '/api/materials/library'))
      ).json()) as {
        materials: Array<{ materialId: string; extraction: { status: string } }>;
      };
      return listed.materials.find((material) => material.materialId === id)?.extraction.status;
    };
    expect(await listedStatus()).toBe('pending');
    // Parse finds it already started.
    const parse = await extractionRoute(
      request('POST', `/api/materials/${id}/extraction`),
      params(id),
    );
    expect(await parse.json()).toEqual({ status: 'pending', queued: false });
    // No Parse click: the scanner claims it.
    h.sources.set(id, bytes);
    expect(await runNextOwnerExtraction(h.deps())).toBe(true);
    expect(await listedStatus()).toBe('done');
    expect(await runNextOwnerExtraction(h.deps())).toBe(false);
  });

  it('R6 queues idle/failed sources and leaves pending/running/done rows byte-for-byte unchanged', async () => {
    const h = await boot();
    for (const status of ['idle', 'failed', 'pending', 'running', 'done']) {
      await seedSource(h, `r6-${status}`);
      await h.pool.query(
        `UPDATE owner_material SET extraction = $2::jsonb, extraction_error = 'private', extraction_claims = 2 WHERE id = $1`,
        [`r6-${status}`, JSON.stringify({ status, reasonCode: 'storage_full' })],
      );
      const before = (
        await h.pool.query('SELECT * FROM owner_material WHERE id = $1', [`r6-${status}`])
      ).rows[0];
      const result = await extractionRoute(
        request('POST', `/api/materials/r6-${status}/extraction`),
        params(`r6-${status}`),
      );
      expect(result.status).toBe(200);
      const queued = status === 'idle' || status === 'failed';
      expect(await result.json()).toEqual({ status: queued ? 'pending' : status, queued });
      const after = (
        await h.pool.query('SELECT * FROM owner_material WHERE id = $1', [`r6-${status}`])
      ).rows[0];
      if (queued) {
        expect(after).toMatchObject({
          extraction: { status: 'pending' },
          extraction_error: null,
          extraction_claims: 0,
        });
        expect((after as { extraction: unknown }).extraction).toEqual({ status: 'pending' });
      } else expect(after).toEqual(before);
      const again = await extractionRoute(
        request('POST', `/api/materials/r6-${status}/extraction`),
        params(`r6-${status}`),
      );
      expect(await again.json()).toEqual({ status: queued ? 'pending' : status, queued: false });
    }
  });

  it('R6 isolates owners and refuses absent, derivative, uploading and deleted sources uniformly', async () => {
    const h = await boot();
    await seedSource(h, 'r6-owned');
    await seedSource(h, 'r6-foreign', { owner: OTHER });
    await seedSource(h, 'r6-deleted');
    await h.pool.query("UPDATE owner_material SET deleted_at = 1 WHERE id = 'r6-deleted'");
    await seedDerivative(h, 'r6-image', 'r6-owned');
    await registerOwnerMaterial(
      h.pool as never,
      { id: 'r6-uploading', ownerId: ACCOUNT, kind: 'source', bytes: 1, ossKey: 'pending' },
      { maxCount: 100, maxTotalBytes: 1000000 },
    );
    for (const id of ['missing', 'r6-foreign', 'r6-deleted', 'r6-image', 'r6-uploading']) {
      const response = await extractionRoute(
        request('POST', `/api/materials/${id}/extraction`),
        params(id),
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
    }
    mocks.ownerId = OTHER;
    expect(
      (
        await extractionRoute(
          request('POST', '/api/materials/r6-owned/extraction'),
          params('r6-owned'),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await extractionRoute(
          request('POST', '/api/materials/r6-foreign/extraction'),
          params('r6-foreign'),
        )
      ).status,
    ).toBe(200);
  });

  it('R6 gates extraction like adjacent routes and fences retired request owners', async () => {
    const h = await boot();
    await seedSource(h, 'r6-gated');
    mocks.invalidCredential = true;
    expect(
      (
        await extractionRoute(
          request('POST', '/api/materials/r6-gated/extraction'),
          params('r6-gated'),
        )
      ).status,
    ).toBe(401);
    mocks.invalidCredential = false;
    mocks.runtimeConfigured = false;
    const response = await extractionRoute(
      request('POST', '/api/materials/r6-gated/extraction'),
      params('r6-gated'),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    mocks.runtimeConfigured = true;
    expect(
      (
        await extractionRoute(
          request('POST', '/api/materials/r6-gated/extraction'),
          params('r6-gated'),
        )
      ).status,
    ).toBe(200);
    await seedSource(h, 'r6-anon', { owner: ANON });
    await claimOwner(ANON, ACCOUNT, { provider: h.provider });
    mocks.ownerId = ANON;
    expect(
      (
        await extractionRoute(
          request('POST', '/api/materials/r6-anon/extraction'),
          params('r6-anon'),
        )
      ).status,
    ).toBe(403);
  });

  it.each([
    ['upload.txt', 'Renamed.txt', 'Renamed.txt'],
    ['upload.txt', 'Renamed', 'Renamed.txt'],
    ['upload.PDF', 'Renamed.pdf', 'Renamed.pdf'],
    ['upload.txt', '中文 讲义', '中文 讲义.txt'],
    ['upload.txt', 'Lesson notes.txt', 'Lesson notes.txt'],
    ['README', 'Updated notes', 'Updated notes'],
  ])(
    'R6 serves renamed original %s as %s, preserving its extension',
    async (original, display, expected) => {
      const h = await boot();
      const bytes = Buffer.from('source contents');
      await seedPoolSource(h, 'r6-file', bytes, 'text/plain');
      await h.pool.query('UPDATE owner_material SET original_name = $1 WHERE id = $2', [
        original,
        'r6-file',
      ]);
      const renamed = await renameMaterialRoute(
        request('PATCH', '/api/materials/r6-file', { name: display }),
        params('r6-file'),
      );
      expect(renamed.status).toBe(200);
      const response = await originalRoute(
        request('GET', '/api/materials/r6-file/original'),
        params('r6-file'),
      );
      expect(response.headers.get('content-disposition')).toBe(
        contentDisposition('attachment', expected, 'r6-file'),
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      expect(
        (
          await h.pool.query<{ original_name: string }>(
            'SELECT original_name FROM owner_material WHERE id = $1',
            ['r6-file'],
          )
        ).rows[0].original_name,
      ).toBe(original);
    },
  );

  it('R8.5 labels each original with the decision its response is served by', async () => {
    const h = await boot();
    const cases: Array<[string, string | null, boolean]> = [
      ['r85-png', 'image/png', true],
      ['r85-mp3', 'audio/mpeg', true],
      ['r85-mp4', 'video/mp4', true],
      ['r85-pdf', 'application/pdf', false],
      ['r85-txt', 'text/plain', false],
      ['r85-svg', 'image/svg+xml', false],
      ['r85-unknown', 'application/x-unknown', false],
      ['r85-none', null, false],
    ];
    for (const [id, mime] of cases) {
      await seedPoolSource(h, id, Buffer.from(id), mime ?? 'application/octet-stream');
      if (mime === null) {
        await h.pool.query('UPDATE owner_material SET mime = NULL WHERE id = $1', [id]);
      }
    }
    const listed = (await (
      await libraryRoute(request('GET', '/api/materials/library'))
    ).json()) as {
      materials: Array<{ materialId: string; opensInline?: boolean }>;
    };
    for (const [id, mime, inline] of cases) {
      const view = listed.materials.find((material) => material.materialId === id)!;
      const response = await originalRoute(
        request('GET', `/api/materials/${id}/original`),
        params(id),
      );
      const disposition = response.headers.get('content-disposition') ?? '';
      // The label's field and the response come from the one decision.
      expect(view.opensInline, String(mime)).toBe(disposition.startsWith('inline;'));
      expect(view.opensInline, String(mime)).toBe(inline);
    }
  });

  it('serves a source’s original to its owner, inline only for media the pool serves inline', async () => {
    const h = await boot();
    const video = Buffer.from('fake-mp4');
    await seedPoolSource(h, 'src-pool', video, 'video/mp4');
    // From before the pool: read from the byte store, checked against its digest.
    await seedSource(h, 'src-old', { bytes: Buffer.from('%PDF-old') });
    await h.pool.query('UPDATE owner_material SET original_name = $2 WHERE id = $1', [
      'src-old',
      '教案 "第1课"\r\n.pdf',
    ]);
    const open = (id: string) =>
      originalRoute(request('GET', `/api/materials/${id}/original`), params(id));

    const pooled = await open('src-pool');
    expect(pooled.status).toBe(200);
    expect(Buffer.from(await pooled.arrayBuffer())).toEqual(video);
    expect(pooled.headers.get('content-type')).toBe('video/mp4');
    expect(pooled.headers.get('content-length')).toBe(String(video.byteLength));
    expect(pooled.headers.get('content-disposition')).toMatch(/^inline; /);
    expect(pooled.headers.get('x-content-type-options')).toBe('nosniff');
    expect(pooled.headers.get('cache-control')).toBe('private, no-store');

    // A PDF is never inline: it downloads under its uploaded name, CR/LF dropped.
    const old = await open('src-old');
    expect(old.status).toBe(200);
    expect(Buffer.from(await old.arrayBuffer())).toEqual(Buffer.from('%PDF-old'));
    expect(old.headers.get('content-type')).toBe('application/octet-stream');
    expect(old.headers.get('content-disposition')).toBe(
      `attachment; filename="__ __1__.pdf"; filename*=UTF-8''${encodeURIComponent('教案 "第1课".pdf')}`,
    );

    // An anonymous owner reads its own; the account does not reach it.
    await seedSource(h, 'src-anon', { owner: ANON });
    expect((await open('src-anon')).status).toBe(404);
    mocks.ownerId = ANON;
    expect((await open('src-anon')).status).toBe(200);
  });

  it('answers the plain 404 for another owner’s, a deleted, a derived, an uploading or a missing material', async () => {
    const h = await boot();
    await seedSource(h, 'src-theirs', { owner: OTHER });
    await seedSource(h, 'src-mine');
    await seedDerivative(h, 'img-1', 'src-mine');
    await seedSource(h, 'src-gone');
    await h.pool.query('UPDATE owner_material SET deleted_at = 1 WHERE id = $1', ['src-gone']);
    // An upload reservation that has not finished is not readable yet.
    await registerOwnerMaterial(
      h.pool as never,
      {
        id: 'src-uploading',
        ownerId: ACCOUNT,
        kind: 'source',
        bytes: 3,
        originalName: 'uploading.pdf',
        mime: 'application/pdf',
        ossKey: 'pending-upload',
      },
      { maxCount: 100, maxTotalBytes: 1_000_000 },
    );
    for (const id of ['src-theirs', 'img-1', 'src-gone', 'src-uploading', 'src-missing']) {
      const answer = await originalRoute(
        request('GET', `/api/materials/${id}/original`),
        params(id),
      );
      expect(answer.status, id).toBe(404);
      expect(await answer.text(), id).toBe('Not found');
    }
  });

  it('answers 503 unavailable, without storage details, when no trusted bytes can be read', async () => {
    const h = await boot();
    await seedSource(h, 'src-bad', { bytes: Buffer.from('%PDF-bad') });
    // The stored object no longer matches the digest recorded at upload.
    h.sources.set('src-bad', Buffer.from('tampered'));
    const answer = await originalRoute(
      request('GET', '/api/materials/src-bad/original'),
      params('src-bad'),
    );
    expect(answer.status).toBe(503);
    const body = await answer.text();
    expect(JSON.parse(body)).toMatchObject({ success: false, reason: 'unavailable' });
    expect(body).not.toContain('objects/');
  });

  it('names the file safely whatever the uploaded name holds', () => {
    expect(contentDisposition('attachment', '../a\\b/c.txt', 'mat-1')).toBe(
      `attachment; filename=".._a_b_c.txt"; filename*=UTF-8''.._a_b_c.txt`,
    );
    expect(contentDisposition('inline', ' \r\n ', 'mat-1')).toBe(
      `inline; filename="mat-1"; filename*=UTF-8''mat-1`,
    );
    expect(contentDisposition('attachment', "it's (1)*.png", 'mat-1')).toBe(
      `attachment; filename="it's (1)*.png"; filename*=UTF-8''it%27s%20%281%29%2A.png`,
    );
  });
});
