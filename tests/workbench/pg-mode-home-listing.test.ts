// @vitest-environment jsdom

/**
 * Home listing — the owner-scoped course list.
 *
 * The generic `GET /api/persistence/documents` listing is refused server-side
 * (`403 FORBIDDEN_DOCUMENTS`) by the capability model: reads are by-id and
 * listings are owner-only. The home/workspace library therefore lists through
 * the owner-scoped workbench surface (`GET /api/stages`, the same
 * anonymous-owner cookie the workbench uses) instead of the generic listing —
 * and must surface no persistence warning when that listing succeeds.
 */
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listDocuments: vi.fn(),
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
// `stage-storage` must load, but the listing never consults the document store.
vi.mock('@/lib/document-store', () => ({
  getDocumentStore: () => ({ listDocuments: mocks.listDocuments }),
}));
vi.mock('@/lib/device-storage/database', () => ({ db: {} }));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions: vi.fn(),
  loadChatSessions: vi.fn(),
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

describe('home listing', () => {
  beforeEach(() => {
    discovery = null;
    vi.stubGlobal('fetch', vi.fn());
    mocks.toastError.mockClear();
    mocks.listDocuments.mockClear();
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

    // Newest first.
    expect(stages).toEqual([
      expect.objectContaining({ id: 'stage-2', name: '二次函数', sceneCount: 0 }),
      expect.objectContaining({ id: 'stage-1', name: '光的折射', sceneCount: 12 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/stages');
    expect(init).toMatchObject({ credentials: 'include' });
    expect(String(url)).not.toContain('/api/persistence/documents');
    // The generic document listing is never consulted.
    expect(mocks.listDocuments).not.toHaveBeenCalled();
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
  });
});
