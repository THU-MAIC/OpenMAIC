// @vitest-environment jsdom

/**
 * PG mode home listing — the owner-scoped course list.
 *
 * With server persistence on (`NEXT_PUBLIC_PERSISTENCE=1`) the generic
 * `GET /api/persistence/documents` listing is refused server-side
 * (`403 FORBIDDEN_DOCUMENTS`) by the capability model: reads are by-id and
 * listings are owner-only. The home/workspace library must therefore list
 * through the owner-scoped workbench surface (`GET /api/stages`, the same
 * anonymous-owner cookie the workbench uses) instead of the generic listing —
 * and must surface no persistence warning when that listing succeeds.
 *
 * The storage seams (IndexedDB document store, Dexie) are mocked so the local
 * fallback path is inert; the real `listStages` PG-mode branch is what runs.
 */
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  listLegacyStages: vi.fn(),
  readLegacyStage: vi.fn(),
  folders: vi.fn(),
  toastError: vi.fn(),
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
// The device-local storage seams: `stage-storage` must load, but the PG-mode
// branch never consults the document store or the legacy listing.
vi.mock('@/lib/document-store', () => ({
  getDocumentStore: () => ({ listDocuments: mocks.listDocuments }),
  getLegacyDocumentStore: () => ({
    listStages: mocks.listLegacyStages,
    read: mocks.readLegacyStage,
  }),
}));
vi.mock('@/lib/utils/database', () => ({
  db: {
    stageFolders: { toArray: () => Promise.resolve([]) },
    folders: { toArray: mocks.folders },
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

import { useHomeDiscovery, type HomeDiscovery } from '@/lib/hooks/use-home-discovery';

let root: Root | null = null;
let discovery: HomeDiscovery | null = null;

function Harness({ onDiscovery }: { onDiscovery: (value: HomeDiscovery) => void }) {
  const value = useHomeDiscovery({ mode: 'discover-only' });
  useEffect(() => onDiscovery(value), [onDiscovery, value]);
  return null;
}

const OWNER_STAGES = [
  { id: 'stage-1', name: '光的折射', sceneCount: 12, createdAt: 1, updatedAt: 2 },
  { id: 'stage-2', name: '二次函数', sceneCount: 0, createdAt: 3, updatedAt: 4 },
];

function stagesResponse() {
  return new Response(JSON.stringify({ stages: OWNER_STAGES }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function foldersResponse() {
  return new Response(JSON.stringify({ folders: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Route the mounted hook's owner-scoped listings: stages + folders. */
function ownerListingsFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/stages') return stagesResponse();
    if (url === '/api/folders') return foldersResponse();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('PG-mode home listing', () => {
  beforeEach(() => {
    discovery = null;
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubGlobal('fetch', vi.fn());
    mocks.toastError.mockClear();
    mocks.folders.mockResolvedValue([]);
    mocks.listDocuments.mockClear();
    mocks.listLegacyStages.mockClear();
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('lists the owner’s stages through /api/stages and never asks for the generic listing', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(stagesResponse());

    const { listStages } = await import('@/lib/utils/stage-storage');
    const stages = await listStages();

    // The list mirrors the local path's newest-first order.
    expect(stages).toEqual([
      expect.objectContaining({ id: 'stage-2', name: '二次函数', sceneCount: 0 }),
      expect.objectContaining({ id: 'stage-1', name: '光的折射', sceneCount: 12 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/stages');
    expect(init).toMatchObject({ credentials: 'include' });
    expect(String(url)).not.toContain('/api/persistence/documents');
    // The local document seams are not consulted in PG mode.
    expect(mocks.listDocuments).not.toHaveBeenCalled();
    expect(mocks.listLegacyStages).not.toHaveBeenCalled();
  });

  it('mounts the home library on the owner listing with no persistence warning', async () => {
    const fetchMock = ownerListingsFetch();

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

    expect(discovery?.state).toBe('ready');
    expect(discovery?.classrooms).toEqual([
      expect.objectContaining({ id: 'stage-2', name: '二次函数' }),
      expect.objectContaining({ id: 'stage-1', name: '光的折射' }),
    ]);
    // The owner listing succeeded — no "Persistence is unavailable" toast.
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/api/stages', expect.objectContaining({}));
  });

  it('propagates a refused owner listing so the caller can surface the warning', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('forbidden', { status: 403 }));

    const { listStages } = await import('@/lib/utils/stage-storage');
    await expect(listStages()).rejects.toThrow(/403/);
    expect(mocks.listDocuments).not.toHaveBeenCalled();
    expect(mocks.listLegacyStages).not.toHaveBeenCalled();
  });

  it('keeps the local IndexedDB listing when server persistence is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '');
    mocks.listDocuments.mockResolvedValue([
      { id: 'local-1', name: 'Local course', sceneCount: 1, createdAt: 1, updatedAt: 2 },
    ]);
    mocks.listLegacyStages.mockResolvedValue([]);

    const { listStages } = await import('@/lib/utils/stage-storage');
    const stages = await listStages();

    expect(stages).toEqual([expect.objectContaining({ id: 'local-1', name: 'Local course' })]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
