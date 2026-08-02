import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  audioGet: vi.fn(),
  audioBulkGet: vi.fn(),
  audioBulkDelete: vi.fn(),
  audioDelete: vi.fn(),
  generateAndStoreTTS: vi.fn(),
  settings: vi.fn(),
  poolRemove: vi.fn(),
  assetRefExists: vi.fn(),
  stageState: { stage: null, scenes: [] } as {
    stage: Record<string, unknown> | null;
    scenes: unknown[];
  },
  audioRows: new Map<string, { id: string; stageId?: string }>(),
  accessDocument: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    audioFiles: {
      get: mocks.audioGet,
      bulkGet: mocks.audioBulkGet,
      bulkDelete: mocks.audioBulkDelete,
      delete: mocks.audioDelete,
      where: () => ({ equals: () => ({ toArray: async () => [...mocks.audioRows.values()] }) }),
    },
    mediaFiles: {
      where: () => ({ equals: () => ({ toArray: async () => [] }) }),
      bulkDelete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/document-store', () => ({ accessDocument: mocks.accessDocument }));

vi.mock('@/lib/hooks/use-scene-generator', () => ({
  generateAndStoreTTS: mocks.generateAndStoreTTS,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settings },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  removeAsset: mocks.poolRemove,
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: () => mocks.stageState },
}));

import {
  discardSpeechAudio,
  regenerateSpeechAudio,
  removeSupersededSpeechAudio,
  resolveLegacySpeechAudioId,
  resolveSpeechAudioId,
} from '@/lib/audio/regenerate-speech-tts';
import { expectDocumentAssetOwnership } from '../media/assert-stage-asset-ownership';

describe('allocated speech audio identities', () => {
  beforeEach(() => {
    mocks.audioGet.mockReset();
    mocks.audioBulkDelete.mockReset().mockResolvedValue(undefined);
    mocks.audioDelete.mockReset().mockResolvedValue(undefined);
    mocks.generateAndStoreTTS.mockReset();
    mocks.poolRemove.mockReset().mockResolvedValue(undefined);
    mocks.assetRefExists.mockReset().mockResolvedValue(false);
    mocks.stageState = { stage: null, scenes: [] };
    mocks.audioRows.clear();
    mocks.audioBulkGet.mockImplementation(async (ids: string[]) =>
      ids.map((id) => mocks.audioRows.get(id)),
    );
    mocks.audioBulkDelete.mockImplementation(async (ids: string[]) => {
      for (const id of ids) mocks.audioRows.delete(id);
    });
    mocks.audioDelete.mockImplementation(async (id: string) => {
      mocks.audioRows.delete(id);
    });
    mocks.accessDocument.mockReset().mockImplementation(async () => ({
      document: mocks.stageState.stage
        ? { stage: mocks.stageState.stage, scenes: mocks.stageState.scenes }
        : null,
      readOnlyLegacy: false,
    }));
    mocks.settings.mockReturnValue({ ttsEnabled: true, ttsProviderId: 'managed-tts' });
  });

  it('treats a missing action audioId as no current audio', () => {
    expect(resolveSpeechAudioId(3, { id: 'speech-1' })).toBeUndefined();
    expect(mocks.audioGet).not.toHaveBeenCalled();
  });

  it('serves the deterministic key only when a legacy Dexie row exists', async () => {
    mocks.audioGet.mockResolvedValueOnce({ id: 'tts_s3_speech-1' });
    await expect(resolveLegacySpeechAudioId(3, { id: 'speech-1' })).resolves.toBe(
      'tts_s3_speech-1',
    );

    mocks.audioGet.mockResolvedValueOnce(undefined);
    await expect(resolveLegacySpeechAudioId(3, { id: 'speech-2' })).resolves.toBeUndefined();
  });

  it('returns the freshly allocated id from regeneration', async () => {
    mocks.generateAndStoreTTS.mockResolvedValueOnce('ast_fresh_audio');

    await expect(
      regenerateSpeechAudio(3, { id: 'speech-1', text: 'New narration' }, 'English'),
    ).resolves.toBe('ast_fresh_audio');
    expect(mocks.generateAndStoreTTS).toHaveBeenCalledWith(
      'tts_request_s3_speech-1',
      'New narration',
      'English',
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('allocates fresh speech audio before the old id is superseded', async () => {
    mocks.generateAndStoreTTS.mockResolvedValueOnce('ast_fresh_audio');

    await expect(
      regenerateSpeechAudio(
        3,
        { id: 'speech-1', text: 'Updated narration', audioId: 'ast_existing_audio' },
        'English',
      ),
    ).resolves.toBe('ast_fresh_audio');

    expect(mocks.generateAndStoreTTS).toHaveBeenCalledWith(
      'tts_request_s3_speech-1',
      'Updated narration',
      'English',
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(mocks.poolRemove).not.toHaveBeenCalled();
    expect(mocks.audioDelete).not.toHaveBeenCalled();
  });

  it('reclaims a superseded pool ref after the new id is committed', async () => {
    const poolEntries = new Set(['ast_old_audio', 'ast_new_audio']);
    const compatibilityRows = new Set(['ast_old_audio', 'ast_new_audio']);
    mocks.audioRows.set('ast_old_audio', { id: 'ast_old_audio', stageId: 'stage-1' });
    mocks.audioRows.set('ast_new_audio', { id: 'ast_new_audio', stageId: 'stage-1' });
    mocks.stageState = {
      stage: { id: 'stage-1', name: 'Stage', createdAt: 1, updatedAt: 1 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          type: 'slide',
          title: 'Scene',
          order: 1,
          content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
          actions: [{ id: 'speech-1', type: 'speech', text: 'New', audioId: 'ast_new_audio' }],
        },
      ],
    };
    mocks.poolRemove.mockImplementation(async (ref: string) => {
      poolEntries.delete(ref);
    });
    mocks.audioDelete.mockImplementation(async (ref: string) => {
      compatibilityRows.delete(ref);
    });
    mocks.audioBulkDelete.mockImplementation(async (refs: string[]) => {
      for (const ref of refs) {
        compatibilityRows.delete(ref);
        mocks.audioRows.delete(ref);
      }
    });

    await removeSupersededSpeechAudio('ast_old_audio', 'ast_new_audio');

    expect(poolEntries).toEqual(new Set(['ast_new_audio']));
    expect(compatibilityRows).toEqual(new Set(['ast_new_audio']));
    await expectDocumentAssetOwnership({
      document: {
        stage: mocks.stageState.stage,
        scenes: mocks.stageState.scenes,
      } as unknown as Parameters<typeof expectDocumentAssetOwnership>[0]['document'],
      mediaRowIds: new Set(),
      audioRowIds: compatibilityRows,
      poolHas: async (ref) => poolEntries.has(ref),
    });
  });

  it('deletes a superseded legacy row even when the pool has no matching entry', async () => {
    mocks.audioRows.set('tts_s3_speech-1', { id: 'tts_s3_speech-1', stageId: 'stage-1' });
    mocks.stageState = {
      stage: { id: 'stage-1', name: 'Stage', createdAt: 1, updatedAt: 1 },
      scenes: [],
    };

    await removeSupersededSpeechAudio('tts_s3_speech-1', 'ast_new_audio');

    expect(mocks.poolRemove).toHaveBeenCalledExactlyOnceWith('tts_s3_speech-1');
    expect(mocks.audioBulkDelete).toHaveBeenCalledExactlyOnceWith(['tts_s3_speech-1']);
  });

  it('discards both the allocated pool entry and compatibility rows', async () => {
    const poolEntries = new Set(['ast_audio']);
    mocks.audioRows.set('tts_s3_speech-1', { id: 'tts_s3_speech-1', stageId: 'stage-1' });
    mocks.audioRows.set('ast_audio', { id: 'ast_audio', stageId: 'stage-1' });
    mocks.stageState = {
      stage: { id: 'stage-1', name: 'Stage', createdAt: 1, updatedAt: 1 },
      scenes: [],
    };
    mocks.poolRemove.mockImplementation(async (ref: string) => {
      poolEntries.delete(ref);
    });

    await discardSpeechAudio(3, { id: 'speech-1', audioId: 'ast_audio' });

    expect(poolEntries.size).toBe(0);
    expect(mocks.audioBulkDelete).toHaveBeenCalledExactlyOnceWith(['tts_s3_speech-1', 'ast_audio']);
    await expectDocumentAssetOwnership({
      document: {
        stage: mocks.stageState.stage,
        scenes: mocks.stageState.scenes,
      } as unknown as Parameters<typeof expectDocumentAssetOwnership>[0]['document'],
      mediaRowIds: new Set(),
      audioRowIds: new Set(mocks.audioRows.keys()),
      poolHas: async (ref) => poolEntries.has(ref),
    });
  });

  it('does not discard a regenerated asset while the live document still references it', async () => {
    mocks.stageState = {
      stage: { id: 'stage-1', name: 'Stage', createdAt: 1, updatedAt: 1 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          type: 'slide',
          title: 'Scene',
          order: 3,
          content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
          actions: [{ id: 'speech-1', type: 'speech', text: 'Narration', audioId: 'ast_audio' }],
        },
      ],
    };
    mocks.audioRows.set('tts_s3_speech-1', { id: 'tts_s3_speech-1', stageId: 'stage-1' });
    mocks.audioRows.set('ast_audio', { id: 'ast_audio', stageId: 'stage-1' });

    await discardSpeechAudio(3, { id: 'speech-1', audioId: 'ast_audio' });

    expect(mocks.poolRemove).not.toHaveBeenCalledWith('ast_audio');
    expect(mocks.audioBulkDelete).toHaveBeenCalledExactlyOnceWith(['tts_s3_speech-1']);
  });
});
