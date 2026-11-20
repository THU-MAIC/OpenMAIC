import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setModelSettingsViewForTests } from '../helpers/model-settings-view';

const mocks = vi.hoisted(() => ({
  audioGet: vi.fn(),
  audioBulkGet: vi.fn(),
  generateAndStoreTTS: vi.fn(),
  poolRemove: vi.fn(),
  stageState: { stage: null, scenes: [] } as {
    stage: Record<string, unknown> | null;
    scenes: unknown[];
  },
  audioRows: new Map<string, { id: string; stageId?: string }>(),
  accessDocument: vi.fn(),
  presence: vi.fn(),
  mayGenerate: vi.fn(),
}));

vi.mock('@/lib/classroom/generation-permission', () => ({
  mayGenerateForStage: mocks.mayGenerate,
}));

vi.mock('@/lib/device-storage/database', () => ({
  db: {
    audioFiles: {
      get: mocks.audioGet,
      bulkGet: mocks.audioBulkGet,
    },
  },
}));

vi.mock('@/lib/document-store', () => ({ accessDocument: mocks.accessDocument }));

vi.mock('@/lib/audio/narration-tts', () => ({
  generateAndStoreTTS: mocks.generateAndStoreTTS,
}));

vi.mock('@/lib/media/asset-pool', () => ({
  removeAsset: mocks.poolRemove,
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: () => mocks.stageState },
}));

import {
  audioExists,
  audioExistsBulk,
  regenerateSpeechAudio,
  resolveLegacySpeechAudioId,
  resolveSpeechAudioId,
} from '@/lib/audio/regenerate-speech-tts';

describe('allocated speech audio identities', () => {
  beforeEach(() => {
    mocks.mayGenerate.mockReset().mockReturnValue(true);
    mocks.audioGet.mockReset();
    mocks.generateAndStoreTTS.mockReset();
    mocks.poolRemove.mockReset().mockResolvedValue(undefined);
    mocks.stageState = { stage: null, scenes: [] };
    mocks.audioRows.clear();
    mocks.audioBulkGet.mockClear();
    mocks.audioBulkGet.mockImplementation(async (ids: string[]) =>
      ids.map((id) => mocks.audioRows.get(id)),
    );
    mocks.accessDocument.mockReset().mockImplementation(async () => ({
      document: mocks.stageState.stage
        ? { stage: mocks.stageState.stage, scenes: mocks.stageState.scenes }
        : null,
      readOnlyLegacy: false,
    }));
    // The workspace's tts slot resolves to a server provider.
    setModelSettingsViewForTests({ tts: { registryId: 'managed-tts' } });
    vi.stubGlobal(
      'fetch',
      mocks.presence.mockReset().mockResolvedValue(Response.json({ ids: [] })),
    );
  });

  it('treats a missing action audioId as no current audio', () => {
    expect(resolveSpeechAudioId(3, { id: 'speech-1' })).toBeUndefined();
    expect(mocks.audioGet).not.toHaveBeenCalled();
  });

  it('finds server-only narration in a fresh browser even when its cache is unavailable', async () => {
    mocks.audioBulkGet.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    mocks.presence.mockResolvedValueOnce(Response.json({ ids: ['ast_course_line'] }));
    await expect(audioExists('ast_course_line')).resolves.toBe(true);
    expect(mocks.presence.mock.calls[0][0]).toBe(
      '/api/persistence/audio-presence?id=ast_course_line',
    );
  });

  it('checks each uncached pool id once and preserves cached and legacy narration', async () => {
    mocks.audioRows.set('legacy-line', { id: 'legacy-line' });
    mocks.presence.mockResolvedValueOnce(Response.json({ ids: ['ast_remote'] }));
    expect(
      await audioExistsBulk([
        'ast_remote',
        'legacy-line',
        'ast_missing',
        'tts_unvoiced',
        'ast_remote',
      ]),
    ).toEqual(new Set(['ast_remote', 'legacy-line']));
    expect(mocks.presence).toHaveBeenCalledTimes(1);
    expect(mocks.presence.mock.calls[0][0]).toBe(
      '/api/persistence/audio-presence?id=ast_remote&id=ast_missing',
    );
  });

  it('coalesces per-row lookups and duplicates into bounded batches on a fresh page', async () => {
    const ids = Array.from({ length: 70 }, (_, i) => 'ast_' + i);
    mocks.presence.mockImplementation(async (url: string) =>
      Response.json({
        ids: new URL(url, 'http://localhost').searchParams
          .getAll('id')
          .filter((id) => id !== 'ast_1'),
      }),
    );
    const result = await Promise.all([...ids, ids[0]].map(audioExists));
    expect(result.filter(Boolean)).toHaveLength(70);
    expect(result[1]).toBe(false);
    expect(mocks.presence).toHaveBeenCalledTimes(2);
    expect(mocks.audioBulkGet).toHaveBeenCalledTimes(1);
  });

  it('serves the deterministic key only when a cached row exists', async () => {
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

  // Regenerating narration calls the TTS provider and allocates a fresh pool
  // asset, so it is one of the ways generation starts and answers to the same
  // permission. The surfaces withhold the control; this is the precondition.
  it('refuses regeneration for a viewer who may not start generation', async () => {
    mocks.stageState = { stage: { id: 'stage-1' }, scenes: [] };
    mocks.mayGenerate.mockReturnValue(false);

    await expect(
      regenerateSpeechAudio(3, { id: 'speech-1', text: 'New narration' }, 'English'),
    ).resolves.toBeNull();
    expect(mocks.generateAndStoreTTS).not.toHaveBeenCalled();
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
    );
  });

  it('always forks to a fresh allocation, even for a clip only this line holds', async () => {
    // No browser can prove that no other document holds an id, so the old
    // bytes are never replaced in place: they keep serving any other holder.
    mocks.stageState = { stage: { id: 'stage-1' }, scenes: [] };
    mocks.generateAndStoreTTS.mockResolvedValueOnce('ast_fresh_audio');

    await expect(
      regenerateSpeechAudio(
        3,
        { id: 'speech-1', text: 'New narration', audioId: 'ast_only_here_audio' },
        'English',
      ),
    ).resolves.toBe('ast_fresh_audio');

    expect(mocks.generateAndStoreTTS).toHaveBeenCalledWith(
      'tts_request_s3_speech-1',
      'New narration',
      'English',
      undefined,
      undefined,
      'stage-1',
    );
    expect(mocks.presence).not.toHaveBeenCalled();
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
    );
    expect(mocks.poolRemove).not.toHaveBeenCalled();
  });

  it('sends the course subject, falling back to the course name for older courses', async () => {
    const speech = (id: string, text: string) => ({ id, type: 'speech', text });
    mocks.stageState = {
      stage: { id: 'stage-1', name: '拼音入门', subject: '语文' },
      scenes: [
        { id: 'scene-3', order: 3, actions: [speech('prior', '上一句'), speech('speech-1', '新')] },
      ],
    };
    await regenerateSpeechAudio(3, { id: 'speech-1', text: '新' }, 'Chinese');
    expect(mocks.generateAndStoreTTS).toHaveBeenLastCalledWith(
      'tts_request_s3_speech-1',
      '新',
      'Chinese',
      undefined,
      { previousTexts: ['上一句'], subject: '语文' },
      'stage-1',
    );

    mocks.stageState = { stage: { id: 'stage-1', name: 'Phonics Basics' }, scenes: [] };
    await regenerateSpeechAudio(3, { id: 'speech-1', text: 'New' }, 'English');
    expect(mocks.generateAndStoreTTS).toHaveBeenLastCalledWith(
      'tts_request_s3_speech-1',
      'New',
      'English',
      undefined,
      { subject: 'Phonics Basics' },
      'stage-1',
    );
  });
});
