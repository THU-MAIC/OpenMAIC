import JSZip from 'jszip';
import type { ChangeEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolPut: vi.fn(),
  mediaPut: vi.fn(),
  audioPut: vi.fn(),
  mediaDelete: vi.fn(),
  audioDelete: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const documents = new Map<string, unknown>();

// Exercise the asynchronous import callback without mounting its file-input UI.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (callback: unknown) => callback,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({
  toast: { loading: () => 'import-toast', error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock('@/lib/media/asset-pool', () => ({ putAsset: mocks.poolPut }));
vi.mock('@/lib/document-store', () => ({
  canonicalizeLegacyScene: (scene: unknown) => scene,
  mutateDocument: (_id: string, work: (document: null, store: unknown) => unknown) =>
    work(null, {
      saveDocument: mocks.save,
      loadDocument: mocks.load,
      deleteDocument: mocks.remove,
    }),
}));
vi.mock('@/lib/device-storage/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    audioFiles: {
      put: mocks.audioPut,
      where: () => ({ equals: () => ({ delete: mocks.audioDelete }) }),
    },
    mediaFiles: {
      put: mocks.mediaPut,
      where: () => ({ equals: () => ({ delete: mocks.mediaDelete }) }),
    },
  },
}));

import { useImportClassroom as createImportHarness } from '@/lib/import/use-import-classroom';

async function importArchive(onSuccess = vi.fn()) {
  const zip = new JSZip();
  zip.file('audio/narration.mp3', 'audio');
  zip.file('media/image.png', 'image');
  zip.file(
    'manifest.json',
    JSON.stringify({
      formatVersion: 1,
      stage: { name: 'Import test' },
      agents: [],
      scenes: [
        {
          title: 'Test',
          content: {
            type: 'slide',
            canvas: { id: 'slide', elements: [{ id: 'image', type: 'image', src: 'image' }] },
          },
          actions: [
            { id: 'speech', type: 'speech', text: 'Test', audioRef: 'audio/narration.mp3' },
          ],
        },
      ],
      mediaIndex: {
        'audio/narration.mp3': { type: 'audio', format: 'mp3' },
        'media/image.png': { type: 'image', mimeType: 'image/png' },
      },
    }),
  );
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const input = { files: [bytes], value: 'selected' };
  await createImportHarness(onSuccess).handleFileChange({
    target: input,
  } as unknown as ChangeEvent<HTMLInputElement>);
  expect(input.value).toBe('');
}

describe('server-backed import commit boundary', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    documents.clear();
    mocks.save.mockImplementation(async (document) => {
      documents.set(document.stage.id, document);
    });
    mocks.load.mockImplementation(async (stageId) => documents.get(stageId) ?? null);
    mocks.remove.mockImplementation(async (stageId) => {
      documents.delete(stageId);
    });
    mocks.poolPut.mockResolvedValueOnce('ast_audio').mockResolvedValueOnce('ast_image');
  });

  it('commits only pool-backed references after every upload', async () => {
    const onSuccess = vi.fn();
    await importArchive(onSuccess);
    expect(mocks.save).toHaveBeenCalledOnce();
    const document = mocks.save.mock.calls[0][0];
    expect(document.scenes[0].actions[0].audioId).toBe('ast_audio');
    expect(document.scenes[0].content.canvas.elements[0].src).toBe('ast_image');
    expect(mocks.poolPut.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.save.mock.invocationCallOrder[0],
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith(document.stage.id);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('does not publish a document when a later upload fails', async () => {
    mocks.poolPut
      .mockReset()
      .mockResolvedValueOnce('ast_audio')
      .mockRejectedValueOnce(new Error('offline'));
    const onSuccess = vi.fn();
    await importArchive(onSuccess);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.audioDelete).toHaveBeenCalledOnce();
    expect(mocks.mediaDelete).toHaveBeenCalledOnce();
    expect(mocks.toastError).toHaveBeenCalledOnce();
  });

  it('reports server quota exhaustion as storage full rather than an invalid archive', async () => {
    mocks.poolPut
      .mockReset()
      .mockRejectedValue(Object.assign(new Error('quota'), { code: 'ASSET_QUOTA_EXCEEDED' }));
    await importArchive();
    expect(mocks.toastError).toHaveBeenCalledWith('settings.mediaStorageFull', {
      id: 'import-toast',
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('commits durable media even if the local cache is full', async () => {
    mocks.audioPut.mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    mocks.mediaPut.mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    await importArchive();
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.toastSuccess).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('reports failure when read-back confirms the document was not committed', async () => {
    mocks.save.mockRejectedValue(new Error('document unavailable'));
    const onSuccess = vi.fn();
    await importArchive(onSuccess);
    const document = mocks.save.mock.calls[0][0];
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(document.stage.id);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.audioDelete).toHaveBeenCalledOnce();
    expect(mocks.mediaDelete).toHaveBeenCalledOnce();
  });

  it('reports failure without deleting when the rejected write cannot be verified', async () => {
    mocks.save.mockRejectedValue(new Error('document unavailable'));
    mocks.load.mockRejectedValue(new Error('read unavailable'));
    const onSuccess = vi.fn();

    await importArchive(onSuccess);

    const document = mocks.save.mock.calls[0][0];
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(document.stage.id);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.audioDelete).toHaveBeenCalledOnce();
    expect(mocks.mediaDelete).toHaveBeenCalledOnce();
  });

  it('treats a document found after a rejected write as committed', async () => {
    mocks.save.mockImplementation(async (document) => {
      documents.set(document.stage.id, document);
      throw new Error('response lost');
    });
    const onSuccess = vi.fn();

    await importArchive(onSuccess);

    const document = mocks.save.mock.calls[0][0];
    expect(documents.get(document.stage.id)).toBe(document);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(document.stage.id);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.audioDelete).not.toHaveBeenCalled();
    expect(mocks.mediaDelete).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith(document.stage.id);
    expect(mocks.toastSuccess).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
