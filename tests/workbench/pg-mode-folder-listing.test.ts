// @vitest-environment jsdom

/**
 * PG-mode folder data flow — the create/list seam the workspace rail depends on.
 *
 * With server persistence on (`NEXT_PUBLIC_PERSISTENCE=1`) the workspace rail
 * creates folders through `POST /api/folders` (and renames/deletes through the
 * `/api/folders/:id` family), so the list the sidebar renders must read the
 * same owner-scoped server store. This suite pins that contract at the storage
 * boundary: a successful create is visible to the very next `listFolders`, and
 * a duplicate refusal surfaces as `FolderNameError` with the list unchanged —
 * the two halves of the acceptance finding (the new folder never appearing
 * until reload, while a second create reports a duplicate).
 *
 * The storage seams (IndexedDB document store, Dexie folder tables) are mocked
 * so the local fallback path is inert; the real PG-mode branches of
 * `listFolders` / `createFolder` / `renameFolder` / `deleteFolder` are what
 * runs. The final test mounts `useHomeDiscovery` the way `WorkspaceShell` does
 * and drives the rail's own create-then-reload sequence.
 */
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  listLegacyStages: vi.fn(),
  readLegacyStage: vi.fn(),
  folders: vi.fn(),
  stageFolders: vi.fn(),
  toastError: vi.fn(),
  mutateDocument: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: {
    getState: () => ({ revokeObjectUrls: vi.fn() }),
    setState: vi.fn(),
  },
}));
vi.mock('@/components/discovery/folder-dialogs', () => ({ NewFolderDialog: () => null }));
vi.mock('@/lib/import/use-import-classroom', () => ({
  useImportClassroom: () => ({
    importing: false,
    fileInputRef: { current: null },
    triggerFileSelect: vi.fn(),
    handleFileChange: vi.fn(),
  }),
}));
vi.mock('@/lib/document-store', () => ({
  getDocumentStore: () => ({ listDocuments: mocks.listDocuments }),
  getLegacyDocumentStore: () => ({
    listStages: mocks.listLegacyStages,
    read: mocks.readLegacyStage,
  }),
  mutateDocument: mocks.mutateDocument,
  accessDocument: vi.fn(),
  clearCurrentScene: vi.fn().mockResolvedValue(undefined),
  loadCurrentScene: vi.fn().mockResolvedValue(null),
  saveCurrentScene: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/utils/database', () => ({
  db: {
    folders: { toArray: mocks.folders },
    stageFolders: { toArray: mocks.stageFolders },
  },
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions: vi.fn(),
  loadChatSessions: vi.fn(),
  deleteChatSessions: vi.fn(),
}));
vi.mock('@/lib/playback/cursor', () => ({ clearCursor: vi.fn() }));
vi.mock('@/lib/quiz/persistence', () => ({ clearAllForScene: vi.fn() }));
vi.mock('@/lib/runtime/store', () => ({ beginStageRuntimeDeletionSafely: vi.fn() }));
vi.mock('@/lib/pbl/v2/runtime/drain', () => ({ clearStageDrainWatermarks: vi.fn() }));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageExclusiveLockUntilSettled: vi.fn(),
  withRuntimeStorageSharedLock: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: vi.fn(async (_id: string, scenes: unknown[]) => scenes),
}));

import { useHomeDiscovery, type HomeDiscovery } from '@/lib/hooks/use-home-discovery';

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

/** One stub per URL/method; anything else fails the test loudly. */
function stubFolderRoutes(
  handlers: ReadonlyArray<{
    readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    readonly url: string;
    readonly respond: FetchHandler;
  }>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE';
    const match = handlers.find((handler) => handler.method === method && handler.url === url);
    if (!match) throw new Error(`unexpected fetch: ${method} ${url}`);
    return match.respond(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const OWNER_STAGES = [
  { id: 'stage-1', name: '光的折射', sceneCount: 12, createdAt: 1, updatedAt: 2 },
];

const OWNER_FOLDERS = [
  { id: 'folder-1', name: 'Math', order: 0, createdAt: 1, updatedAt: 2, userKey: 'owner' },
];

const NEW_FOLDER = {
  id: 'folder-9',
  name: 'References',
  order: 1,
  createdAt: 100,
  updatedAt: 100,
  userKey: 'owner',
};

let root: Root | null = null;
let discovery: HomeDiscovery | null = null;

function Harness({ onDiscovery }: { onDiscovery: (value: HomeDiscovery) => void }) {
  const value = useHomeDiscovery({ mode: 'discover-only' });
  useEffect(() => onDiscovery(value), [onDiscovery, value]);
  return null;
}

describe('PG-mode folder listing and creation', () => {
  beforeEach(() => {
    discovery = null;
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubGlobal('fetch', vi.fn());
    mocks.listDocuments.mockClear();
    mocks.listLegacyStages.mockClear();
    mocks.folders.mockClear();
    mocks.stageFolders.mockResolvedValue([]);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('lists the owner folders through /api/folders and never consults Dexie', async () => {
    const fetchMock = stubFolderRoutes([
      {
        method: 'GET',
        url: '/api/folders',
        respond: () => jsonResponse(200, { folders: OWNER_FOLDERS }),
      },
    ]);

    const { listFolders } = await import('@/lib/utils/stage-storage');
    const folders = await listFolders();

    expect(folders).toEqual([
      { id: 'folder-1', name: 'Math', order: 0, createdAt: 1, updatedAt: 2 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/api/folders', expect.objectContaining({}));
    expect(mocks.folders).not.toHaveBeenCalled();
  });

  it('makes a created folder visible to the very next listFolders', async () => {
    stubFolderRoutes([
      {
        method: 'POST',
        url: '/api/folders',
        respond: () => jsonResponse(200, { folder: NEW_FOLDER }),
      },
      {
        method: 'GET',
        url: '/api/folders',
        respond: () => jsonResponse(200, { folders: [...OWNER_FOLDERS, NEW_FOLDER] }),
      },
    ]);

    const { createFolder, listFolders } = await import('@/lib/utils/stage-storage');
    const created = await createFolder('References');

    expect(created).toEqual({
      id: 'folder-9',
      name: 'References',
      order: 1,
      createdAt: 100,
      updatedAt: 100,
    });

    const folders = await listFolders();
    expect(folders.map((folder) => folder.id)).toContain('folder-9');
    expect(folders.find((folder) => folder.id === 'folder-9')?.name).toBe('References');
  });

  it('surfaces a duplicate create as FolderNameError and leaves the list unchanged', async () => {
    stubFolderRoutes([
      {
        method: 'POST',
        url: '/api/folders',
        respond: () =>
          jsonResponse(409, {
            error: { code: 'FOLDER_NAME_DUPLICATE', message: 'already exists' },
          }),
      },
      {
        method: 'GET',
        url: '/api/folders',
        respond: () => jsonResponse(200, { folders: OWNER_FOLDERS }),
      },
    ]);

    const { createFolder, listFolders, FolderNameError } =
      await import('@/lib/utils/stage-storage');
    await expect(createFolder('Math')).rejects.toBeInstanceOf(FolderNameError);
    await expect(createFolder('Math')).rejects.toMatchObject({ kind: 'duplicate' });

    const folders = await listFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ id: 'folder-1', name: 'Math' });
  });

  it('renames and deletes through the owner-scoped route family', async () => {
    const fetchMock = stubFolderRoutes([
      {
        method: 'PATCH',
        url: '/api/folders/folder%2Fone',
        respond: () => jsonResponse(200, { folder: { ...OWNER_FOLDERS[0], name: 'Reading' } }),
      },
      {
        method: 'DELETE',
        url: '/api/folders/folder%2Fone?mode=ungroup',
        respond: () => jsonResponse(200, { ok: true }),
      },
    ]);

    const { renameFolder, deleteFolder } = await import('@/lib/utils/stage-storage');
    await renameFolder('folder/one', 'Reading');
    await deleteFolder('folder/one', 'ungroup');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/folders/folder%2Fone',
      expect.objectContaining({ method: 'PATCH' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/folders/folder%2Fone?mode=ungroup',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('keeps the device-local Dexie listing when server persistence is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '');
    mocks.folders.mockResolvedValue([
      { id: 'local-1', name: 'Local', order: 0, createdAt: 1, updatedAt: 2 },
    ]);

    const { listFolders } = await import('@/lib/utils/stage-storage');
    const folders = await listFolders();

    expect(folders).toEqual([expect.objectContaining({ id: 'local-1', name: 'Local' })]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows a folder created through the rail adapter in the mounted list after reload', async () => {
    // The server-side list converges only after the create lands: the first
    // GET (mount) does not know the folder, the GET after the POST does.
    let created = false;
    stubFolderRoutes([
      {
        method: 'GET',
        url: '/api/stages',
        respond: () => jsonResponse(200, { stages: OWNER_STAGES }),
      },
      {
        method: 'GET',
        url: '/api/folders',
        respond: () =>
          jsonResponse(200, { folders: created ? [...OWNER_FOLDERS, NEW_FOLDER] : OWNER_FOLDERS }),
      },
      {
        method: 'POST',
        url: '/api/folders',
        respond: () => {
          created = true;
          return jsonResponse(200, { folder: NEW_FOLDER });
        },
      },
    ]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        createElement(Harness, {
          onDiscovery: (value) => {
            discovery = value;
          },
        }),
      ),
    );

    // The rail renders its course tree from `useHomeDiscovery`'s folders; the
    // initial list arrives from the server, not Dexie.
    expect(discovery?.folders.map((folder) => folder.id)).toEqual(['folder-1']);

    // The workspace rail's create handler: POST /api/folders, then reload the
    // authoritative list. The list state the sidebar renders must now hold the
    // new folder — the exact acceptance flow.
    const { workspaceFolderAdapter } =
      await import('@/components/workbench/workspace/workspace-folder-seam');
    await act(async () => {
      await workspaceFolderAdapter.create('References');
      await discovery?.reload();
    });

    expect(discovery?.folders.map((folder) => folder.id)).toEqual(['folder-1', 'folder-9']);
  });
});
