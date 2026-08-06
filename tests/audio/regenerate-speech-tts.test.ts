import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  audioGet: vi.fn(),
  audioBulkGet: vi.fn(),
  generateAndStoreTTS: vi.fn(),
  settings: vi.fn(),
  poolRemove: vi.fn(),
  stageState: { stage: null, scenes: [] } as {
    stage: Record<string, unknown> | null;
    scenes: unknown[];
  },
  audioRows: new Map<string, { id: string; stageId?: string }>(),
  accessDocument: vi.fn(),
  assetRefExists: vi.fn(),
  proveExclusiveAssetOwnership: vi.fn(),
}));

vi.mock('@/lib/media/use-asset-url', () => ({ assetRefExists: mocks.assetRefExists }));

vi.mock('@/lib/media/collect-stage-asset-refs', () => ({
  proveExclusiveAssetOwnership: mocks.proveExclusiveAssetOwnership,
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    audioFiles: {
      get: mocks.audioGet,
      bulkGet: mocks.audioBulkGet,
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
  regenerateSpeechAudio,
  resolveLegacySpeechAudioId,
  resolveSpeechAudioId,
} from '@/lib/audio/regenerate-speech-tts';

describe('allocated speech audio identities', () => {
  beforeEach(() => {
    mocks.audioGet.mockReset();
    mocks.generateAndStoreTTS.mockReset();
    mocks.poolRemove.mockReset().mockResolvedValue(undefined);
    mocks.stageState = { stage: null, scenes: [] };
    mocks.audioRows.clear();
    mocks.audioBulkGet.mockImplementation(async (ids: string[]) =>
      ids.map((id) => mocks.audioRows.get(id)),
    );
    mocks.accessDocument.mockReset().mockImplementation(async () => ({
      document: mocks.stageState.stage
        ? { stage: mocks.stageState.stage, scenes: mocks.stageState.scenes }
        : null,
      readOnlyLegacy: false,
    }));
    mocks.settings.mockReturnValue({ ttsEnabled: true, ttsProviderId: 'managed-tts' });
    mocks.assetRefExists.mockReset().mockResolvedValue(false);
    mocks.proveExclusiveAssetOwnership.mockReset().mockResolvedValue({ exclusive: false });
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

  it('does not revive invalidated narration from a legacy derived-id row', async () => {
    await expect(
      resolveLegacySpeechAudioId(3, { id: 'speech-1', audioInvalidated: true }),
    ).resolves.toBeUndefined();
    expect(mocks.audioGet).not.toHaveBeenCalled();
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

  it('replaces bytes under an exclusively owned allocated id', async () => {
    // Same rule as a media retry: an exclusively owned clip keeps its identity,
    // so references stay valid and no orphan entry or row is left behind.
    mocks.stageState = { stage: { id: 'stage-1' }, scenes: [] };
    mocks.assetRefExists.mockResolvedValue(true);
    mocks.proveExclusiveAssetOwnership.mockResolvedValue({ exclusive: true });
    mocks.generateAndStoreTTS.mockResolvedValueOnce('ast_owned_audio');

    await expect(
      regenerateSpeechAudio(
        3,
        { id: 'speech-1', text: 'New narration', audioId: 'ast_owned_audio' },
        'English',
      ),
    ).resolves.toBe('ast_owned_audio');

    expect(mocks.proveExclusiveAssetOwnership).toHaveBeenCalledWith('ast_owned_audio', 'stage-1');
    expect(mocks.generateAndStoreTTS).toHaveBeenCalledWith(
      'tts_request_s3_speech-1',
      'New narration',
      'English',
      undefined,
      undefined,
      'ast_owned_audio',
      'stage-1',
    );
  });

  it('allocates a fresh id when the clip is shared or ownership is unproven', async () => {
    mocks.stageState = { stage: { id: 'stage-1' }, scenes: [] };
    mocks.assetRefExists.mockResolvedValue(true);
    mocks.proveExclusiveAssetOwnership.mockResolvedValue({ exclusive: false });
    mocks.generateAndStoreTTS.mockResolvedValueOnce('ast_fresh_audio');

    await expect(
      regenerateSpeechAudio(
        3,
        { id: 'speech-1', text: 'New narration', audioId: 'ast_shared_audio' },
        'English',
      ),
    ).resolves.toBe('ast_fresh_audio');

    // The shared clip must keep its bytes for the other holders.
    expect(mocks.generateAndStoreTTS.mock.calls[0][5]).toBeUndefined();
  });

  it('allocates fresh audio for a legacy id with no pool entry', async () => {
    mocks.stageState = { stage: { id: 'stage-1' }, scenes: [] };
    mocks.assetRefExists.mockResolvedValue(false);
    mocks.generateAndStoreTTS.mockResolvedValueOnce('ast_fresh_audio');

    await expect(
      regenerateSpeechAudio(
        3,
        { id: 'speech-1', text: 'New narration', audioId: 'tts_s3_speech-1' },
        'English',
      ),
    ).resolves.toBe('ast_fresh_audio');

    expect(mocks.proveExclusiveAssetOwnership).not.toHaveBeenCalled();
    expect(mocks.generateAndStoreTTS.mock.calls[0][5]).toBeUndefined();
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
  });
});
