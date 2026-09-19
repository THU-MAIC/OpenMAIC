// @vitest-environment jsdom
// Keep the .test.ts suffix: the repository's Vitest include intentionally
// discovers TypeScript tests with this extension.

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listStages: vi.fn(),
  listFolders: vi.fn<() => Promise<unknown[]>>(async () => []),
  deleteStageData: vi.fn(async () => undefined),
  setStageFolder: vi.fn(async () => undefined),
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
vi.mock('@/lib/utils/stage-storage', () => ({
  listStages: mocks.listStages,
  listFolders: mocks.listFolders,
  deleteStageData: mocks.deleteStageData,
  setStageFolder: mocks.setStageFolder,
  renameStage: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  FolderNameError: class FolderNameError extends Error {},
}));
vi.mock('@/lib/utils/folder-name-validation', () => ({
  displayNameWidth: (value: string) => value.length,
  FOLDER_NAME_MAX_WIDTH: 30,
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

import { useHomeDiscovery, type HomeDiscovery } from '@/lib/hooks/use-home-discovery';

let root: Root | null = null;
let discovery: HomeDiscovery | null = null;

function Harness({ onDiscovery }: { onDiscovery: (value: HomeDiscovery) => void }) {
  const value = useHomeDiscovery({ mode: 'discover-only' });
  useEffect(() => onDiscovery(value), [onDiscovery, value]);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const course = { id: 'stage-1', name: 'Generated course', updatedAt: 1 };

beforeEach(() => {
  discovery = null;
  mocks.listStages.mockReset().mockResolvedValue([course]);
  mocks.listFolders.mockClear();
  mocks.deleteStageData.mockClear();
  mocks.setStageFolder.mockClear();
  mocks.toastError.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mountDiscovery() {
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
}

describe('home discovery authoritative reloads', () => {
  it('keeps a usable tree visible when a background reload fails', async () => {
    await mountDiscovery();
    mocks.listStages.mockRejectedValueOnce(new Error('transient'));

    await act(async () => discovery?.reload());

    expect(discovery?.state).toBe('ready');
    expect(discovery?.classrooms).toEqual([course]);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('does not let an in-flight pre-delete snapshot resurrect a deleted course', async () => {
    await mountDiscovery();
    const stale = deferred<(typeof course)[]>();
    mocks.listStages.mockReturnValueOnce(stale.promise).mockResolvedValueOnce([]);

    let backgroundReload!: Promise<void>;
    let deletion!: Promise<boolean>;
    act(() => {
      backgroundReload = discovery!.reload();
      deletion = discovery!.deleteCourse(course.id);
    });
    stale.resolve([course]);
    await act(async () => Promise.all([backgroundReload, deletion]));

    expect(mocks.listStages).toHaveBeenCalledTimes(3);
    expect(discovery?.classrooms).toEqual([]);
  });

  it('does not let a stale folder reload hide a newer folder snapshot', async () => {
    await mountDiscovery();
    const stale = deferred<Array<{ id: string; name: string }>>();
    const latest = [{ id: 'folder-new', name: 'New folder' }];
    mocks.listFolders.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(latest);

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = discovery!.reload();
      second = discovery!.reload();
    });
    stale.resolve([]);
    await act(async () => Promise.all([first, second]));

    expect(mocks.listFolders).toHaveBeenCalledTimes(3);
    expect(discovery?.folders).toEqual(latest);
  });
});
