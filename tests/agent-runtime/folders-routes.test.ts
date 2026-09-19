import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { createFakeDocumentStore } from './_fake-document-store';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  fakeStore: null as ReturnType<typeof createFakeDocumentStore> | null,
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => mocks.fakeStore!.store,
}));

import { GET, POST } from '@/app/api/folders/route';
import { DELETE, PATCH } from '@/app/api/folders/[id]/route';
import { POST as postMembers } from '@/app/api/folders/members/route';

function routeRequest(
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest {
  // `NextRequest` already exposes `nextUrl`, which DELETE /api/folders/[id]
  // reads for its `mode` query parameter.
  return new NextRequest(url, init);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.fakeStore = createFakeDocumentStore();
});

describe('GET /api/folders', () => {
  it('gates on the configured runtime', async () => {
    mocks.runtimeConfigured = false;
    const response = await GET(routeRequest('http://localhost/api/folders'));
    expect(response.status).toBe(404);
  });

  it('lists the caller’s folders with their owner key', async () => {
    await mocks.fakeStore!.store.createFolder('folder-a', 'Math');
    const response = await GET(routeRequest('http://localhost/api/folders'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      folders: [
        expect.objectContaining({ id: 'folder-a', name: 'Math', order: 0, userKey: 'owner-1' }),
      ],
    });
  });
});

describe('POST /api/folders', () => {
  async function post(body: unknown) {
    return POST(
      routeRequest('http://localhost/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('creates a folder and returns it (trimmed)', async () => {
    const response = await post({ name: '  数学  ' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      folder: { name: '数学', userKey: 'owner-1' },
    });
    await expect(mocks.fakeStore!.store.listFolders()).resolves.toEqual([
      expect.objectContaining({ name: '数学' }),
    ]);
  });

  it('rejects an empty name (whitespace only)', async () => {
    const response = await post({ name: '   ' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FOLDER_NAME_EMPTY' },
    });
  });

  it('rejects a name over the display-width cap', async () => {
    const wide = '课'.repeat(21); // 21 × 2 = 42 > 40
    const response = await post({ name: wide });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FOLDER_NAME_TOO_LONG' },
    });
  });

  it('rejects a duplicate name, case-insensitively', async () => {
    await mocks.fakeStore!.store.createFolder('folder-a', 'Math');
    const response = await post({ name: 'MATH' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FOLDER_NAME_DUPLICATE' },
    });
  });

  it('rejects when the folder count limit is reached', async () => {
    for (let i = 0; i < 50; i += 1) {
      await mocks.fakeStore!.store.createFolder(`folder-${i}`, `folder-${i}`);
    }
    const response = await post({ name: 'new' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FOLDER_COUNT_LIMIT' },
    });
  });
});

describe('PATCH /api/folders/[id]', () => {
  it('renames a folder and returns it', async () => {
    await mocks.fakeStore!.store.createFolder('folder-a', 'Math');
    const response = await PATCH(
      routeRequest('http://localhost/api/folders/folder-a', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '物理' }),
      }),
      params('folder-a'),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ folder: { name: '物理' } });
  });

  it('returns 404 when the folder does not exist or is not owned', async () => {
    const response = await PATCH(
      routeRequest('http://localhost/api/folders/missing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '物理' }),
      }),
      params('missing'),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FOLDER_NOT_FOUND' },
    });
  });

  it('rejects a duplicate name while excluding the folder itself', async () => {
    await mocks.fakeStore!.store.createFolder('folder-a', 'Math');
    await mocks.fakeStore!.store.createFolder('folder-b', 'Physics');
    const self = await PATCH(
      routeRequest('http://localhost/api/folders/folder-a', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Math' }),
      }),
      params('folder-a'),
    );
    expect(self.status).toBe(200);
    const clash = await PATCH(
      routeRequest('http://localhost/api/folders/folder-a', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'physics' }),
      }),
      params('folder-a'),
    );
    expect(clash.status).toBe(409);
  });
});

describe('DELETE /api/folders/[id]', () => {
  it("defaults to 'ungroup' and returns no removed members", async () => {
    await mocks.fakeStore!.store.createFolder('folder-a', 'Math');
    const response = await DELETE(
      routeRequest('http://localhost/api/folders/folder-a', { method: 'DELETE' }),
      params('folder-a'),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, removedStageIds: [] });
  });

  it('passes mode=remove through and returns the captured member ids', async () => {
    await mocks.fakeStore!.store.createFolder('folder-a', 'Math');
    await mocks.fakeStore!.store.saveDocument({
      stage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 2 },
      scenes: [],
      outline: {
        outlines: [],
        requirement: 'Course',
        generationComplete: false,
        createdAt: 1,
        updatedAt: 2,
      },
    } as never);
    await mocks.fakeStore!.store.setStageFolder('stage-1', 'folder-a');
    const response = await DELETE(
      routeRequest('http://localhost/api/folders/folder-a?mode=remove', { method: 'DELETE' }),
      params('folder-a'),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, removedStageIds: ['stage-1'] });
  });

  it('returns 404 when the folder does not exist or is not owned', async () => {
    const response = await DELETE(
      routeRequest('http://localhost/api/folders/missing', { method: 'DELETE' }),
      params('missing'),
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /api/folders/members', () => {
  async function post(body: unknown) {
    return postMembers(
      routeRequest('http://localhost/api/folders/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('files a course into a folder', async () => {
    await mocks.fakeStore!.store.createFolder('folder-a', 'Math');
    const response = await post({ stageId: 'stage-1', folderId: 'folder-a' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('un-files a course when folderId is null (idempotent)', async () => {
    await mocks.fakeStore!.store.createFolder('folder-a', 'Math');
    await post({ stageId: 'stage-1', folderId: 'folder-a' });
    const unfiled = await post({ stageId: 'stage-1', folderId: null });
    expect(unfiled.status).toBe(200);
    const again = await post({ stageId: 'stage-1', folderId: null });
    expect(again.status).toBe(200);
  });

  it('returns 404 when the folder is not found', async () => {
    const response = await post({ stageId: 'stage-1', folderId: 'missing' });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FOLDER_NOT_FOUND' },
    });
  });

  it('rejects a missing stageId', async () => {
    const response = await post({ folderId: null });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'MISSING_STAGE_ID' },
    });
  });
});
