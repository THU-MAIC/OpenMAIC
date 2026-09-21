/**
 * Narration a full store refused is kept, so nobody pays for it twice.
 *
 * This is the defect #1467 names. The media pass has kept the bytes a full
 * store refused since it learned to: they are already paid for, the document
 * still carries the placeholder, and a later Retry re-attempts the upload
 * rather than the generation. Fresh TTS synthesis did the opposite — it dropped
 * the freshly synthesized clip before the local cache write — so every later
 * attempt called the provider again for audio this browser had already bought.
 *
 * The fix gives the TTS path the same contract through the shared commit
 * primitive, and this suite is the proof of it end to end: the refused clip is
 * kept under its derived key, the action is stamped with that key, and the next
 * load's narration adoption converts it with exactly one pool write and no
 * provider call at all.
 *
 * Both halves are loaded for real, because the claim is about what one leaves
 * for the other. The pool is doubled at the store rather than at `putAsset`, so
 * the real seam runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentModelConfig: vi.fn(),
  settingsState: vi.fn(),
  audioGet: vi.fn(),
  audioPut: vi.fn(),
  audioDelete: vi.fn(),
  mediaPut: vi.fn(),
  mediaGet: vi.fn(),
  mediaDelete: vi.fn(),
  poolPut: vi.fn(),
  mutateDocument: vi.fn(),
  saveStageData: vi.fn(),
  saveStageDataIncremental: vi.fn(),
  isTTSProviderEnabled: vi.fn(),
  pickNarratorAgent: vi.fn(),
  resolveAgentVoiceOptions: vi.fn(),
  listAgents: vi.fn(),
  toastWarning: vi.fn(),
  serverBacked: vi.fn(),
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: mocks.getCurrentModelConfig,
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settingsState },
}));
vi.mock('@/lib/document-store', () => ({ mutateDocument: mocks.mutateDocument }));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: mocks.saveStageData,
  saveStageDataIncremental: mocks.saveStageDataIncremental,
}));
vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    audioFiles: { get: mocks.audioGet, put: mocks.audioPut, delete: mocks.audioDelete },
    mediaFiles: {
      put: mocks.mediaPut,
      get: mocks.mediaGet,
      delete: mocks.mediaDelete,
      where: () => ({ equals: () => ({ toArray: async () => [] }) }),
    },
  },
}));
vi.mock('@/lib/media/asset-pool-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/asset-pool-config')>();
  return {
    ...actual,
    resolveConfiguredAssetPoolStore: () =>
      ({ put: mocks.poolPut }) as unknown as import('@/lib/media/asset-pool-config').AssetPoolStore,
  };
});
vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));
vi.mock('@/lib/audio/provider-enablement', () => ({
  isTTSProviderEnabled: mocks.isTTSProviderEnabled,
}));
vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: mocks.pickNarratorAgent,
  resolveAgentVoiceOptions: mocks.resolveAgentVoiceOptions,
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ listAgents: mocks.listAgents }) },
}));
vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning } }));

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

import { adoptCachedNarration } from '@/lib/audio/adopt-cached-narration';
import { generateAndStoreTTS, generateTTSForScene } from '@/lib/hooks/use-scene-generator';
import {
  noteStageGenerationOwnership,
  resetGenerationPermissionsForTests,
} from '@/lib/classroom/generation-permission';
import { useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

const stageId = 'refused-narration-stage';
/** What `generateTTSForScene` builds for scene order 1, action `speech-1`. */
const derivedRef = 'tts_s1_speech-1';

/** What the store answers when it has no room for these bytes. */
function quotaRefusal(): Error {
  return Object.assign(new Error('asset quota exceeded for this principal'), {
    status: 507,
    code: 'ASSET_QUOTA_EXCEEDED',
  });
}

function ttsResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ success: true, base64: btoa('narration-bytes'), format: 'wav' }),
  };
}

function sceneWithOneLine(): Scene {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene',
    order: 1,
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
    actions: [{ id: 'speech-1', type: 'speech', text: 'Welcome' }],
  } as unknown as Scene;
}

/** Two lines, so "this clip" and "the one next to it" are distinguishable. */
function sceneWithTwoLines(): Scene {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene',
    order: 1,
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
    actions: [
      { id: 'speech-1', type: 'speech', text: 'Welcome' },
      { id: 'speech-2', type: 'speech', text: 'And then' },
    ],
  } as unknown as Scene;
}

function audioIdOf(scene: Scene, index = 0): string | undefined {
  return (scene as unknown as { actions: Array<{ audioId?: string }> }).actions[index]?.audioId;
}

/** The local audio table, modelled so one step can read what the last wrote. */
function modelAudioTable(): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  mocks.audioPut.mockImplementation(async (row: Record<string, unknown>) => {
    rows.set(row.id as string, row);
  });
  mocks.audioGet.mockImplementation(async (id: string) => rows.get(id));
  mocks.audioDelete.mockImplementation(async (id: string) => {
    rows.delete(id);
  });
  return rows;
}

/** Run the narration funnel against a document holding the same reference. */
function serveDocument(scenes: Scene[]): Mock {
  const putScene = vi.fn().mockResolvedValue(undefined);
  mocks.mutateDocument.mockImplementation(
    async (_stageId: string, work: (document: unknown, store: unknown) => Promise<void>) => {
      await work({ scenes, stage: { id: stageId } }, { putScene, putStage: vi.fn() });
    },
  );
  return putScene;
}

describe('narration refused for want of room', () => {
  beforeEach(() => {
    resetGenerationPermissionsForTests();
    mockFetch.mockReset();
    mocks.poolPut.mockReset();
    mocks.audioGet.mockReset().mockResolvedValue(undefined);
    mocks.audioPut.mockReset().mockResolvedValue(undefined);
    mocks.audioDelete.mockReset().mockResolvedValue(undefined);
    mocks.mutateDocument.mockReset();
    mocks.saveStageData.mockReset().mockResolvedValue(undefined);
    mocks.saveStageDataIncremental.mockReset().mockResolvedValue(undefined);
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaGet.mockReset().mockResolvedValue(undefined);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    mocks.serverBacked.mockReset().mockReturnValue(true);
    mocks.getCurrentModelConfig.mockReturnValue({});
    mocks.settingsState.mockReturnValue({
      imageProviderId: '',
      imageProvidersConfig: {},
      imageGenerationEnabled: false,
      videoProviderId: '',
      videoProvidersConfig: {},
      videoGenerationEnabled: false,
      ttsProviderId: 'server-tts',
      ttsProvidersConfig: { 'server-tts': { apiKey: 'tts-key', modelId: 'tts-model' } },
      ttsVoice: 'narrator',
      ttsSpeed: 1,
    });
    mocks.isTTSProviderEnabled.mockReturnValue(true);
    mocks.pickNarratorAgent.mockReturnValue(undefined);
    mocks.resolveAgentVoiceOptions.mockResolvedValue({});
    mocks.listAgents.mockReturnValue([]);
    mocks.toastWarning.mockReset();
    noteStageGenerationOwnership(stageId, 'owner');
    useStageStore.setState({ stage: { id: stageId, name: 'Course' } as never, scenes: [] });
  });

  afterEach(() => {
    useStageStore.setState({ stage: null, scenes: [] });
    resetGenerationPermissionsForTests();
  });

  // The whole point, in one run: the provider is paid once, ever.
  it('keeps the billed clip and lets the next load upload it with no provider call', async () => {
    const rows = modelAudioTable();
    mocks.poolPut.mockRejectedValueOnce(quotaRefusal());
    mockFetch.mockResolvedValueOnce(ttsResponse());

    const scene = sceneWithOneLine();
    await expect(generateTTSForScene(scene)).resolves.toMatchObject({
      success: true,
      failedCount: 0,
    });

    // Refused, and kept: the bytes sit under the derived key, and the action
    // carries that key, exactly as a refused image leaves its placeholder in
    // the slide.
    expect(mocks.poolPut).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(audioIdOf(scene)).toBe(derivedRef);
    await expect((rows.get(derivedRef)?.blob as Blob).text()).resolves.toBe('narration-bytes');
    expect(rows.get(derivedRef)).toMatchObject({ stageId, format: 'wav', text: 'Welcome' });

    // The next load. The ceiling has moved, so the store takes it now.
    mocks.poolPut.mockResolvedValue('ast_narration_allocated');
    const documentScenes = [scene];
    const putScene = serveDocument(documentScenes);
    useStageStore.setState({ scenes: [scene] as never });

    await expect(adoptCachedNarration(stageId)).resolves.toEqual({ adopted: 1, unbacked: 0 });

    // One pool write for the retry, and not one more provider call.
    expect(mocks.poolPut).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [uploaded] = mocks.poolPut.mock.calls[1] as [Blob];
    await expect(uploaded.text()).resolves.toBe('narration-bytes');
    expect(putScene).toHaveBeenCalledTimes(1);
    expect(audioIdOf(documentScenes[0])).toBe('ast_narration_allocated');
    expect(audioIdOf(useStageStore.getState().scenes[0] as Scene)).toBe('ast_narration_allocated');
  });

  // A refusal is not a synthesis failure. Counting it as one would pause the
  // whole deck at its first slide over one clip's storage.
  it('does not fail the scene, and does not re-synthesize within the same run', async () => {
    modelAudioTable();
    mocks.poolPut.mockRejectedValue(quotaRefusal());
    mockFetch.mockResolvedValue(ttsResponse());

    const scene = sceneWithOneLine();
    await expect(generateTTSForScene(scene)).resolves.toEqual({ success: true, failedCount: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // A sibling line failing is not a reason to throw away bytes that are
  // already paid for. The scene-level rollback reclaims what it minted for this
  // scene; a retained refusal was never minted, and unstamping it would strand
  // the only copy of that clip where nothing will ever look for it again.
  it('keeps a retained refusal when the line next to it fails', async () => {
    const rows = modelAudioTable();
    mocks.poolPut.mockRejectedValue(quotaRefusal());
    mockFetch.mockResolvedValueOnce(ttsResponse()).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'unavailable',
      json: async () => ({ error: 'provider down' }),
    });

    const scene = sceneWithTwoLines();
    await expect(generateTTSForScene(scene)).resolves.toMatchObject({
      success: false,
      failedCount: 1,
    });

    // The refused line keeps both halves of the contract: its bytes and the
    // key adoption reads them back by.
    expect(audioIdOf(scene, 0)).toBe(derivedRef);
    expect(rows.has(derivedRef)).toBe(true);
    expect(mocks.audioDelete).not.toHaveBeenCalledWith(derivedRef);
    // The line that failed has nothing to keep.
    expect(audioIdOf(scene, 1)).toBeUndefined();
  });

  // A clip the pool did take is an allocation this scene minted and nothing
  // else holds, so the rollback still reclaims its local copy.
  it('still rolls back a clip the pool accepted when a sibling fails', async () => {
    modelAudioTable();
    mocks.poolPut.mockResolvedValue('ast_narration_allocated');
    mockFetch.mockResolvedValueOnce(ttsResponse()).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'unavailable',
      json: async () => ({ error: 'provider down' }),
    });

    const scene = sceneWithTwoLines();
    await expect(generateTTSForScene(scene)).resolves.toMatchObject({
      success: false,
      failedCount: 1,
    });

    expect(mocks.audioDelete).toHaveBeenCalledWith('ast_narration_allocated');
    expect(audioIdOf(scene, 0)).toBeUndefined();
  });

  // `refused-retained` is a statement about what is on disk. If the local table
  // refused the row too, a stamp would name bytes nothing can read back, for
  // the rest of the course's life.
  it('leaves the line unvoiced when the refused bytes cannot be kept locally', async () => {
    mocks.audioPut.mockRejectedValue(new Error('local quota exceeded'));
    mocks.poolPut.mockRejectedValue(quotaRefusal());
    mockFetch.mockResolvedValueOnce(ttsResponse());

    const scene = sceneWithOneLine();
    await expect(generateTTSForScene(scene)).resolves.toMatchObject({
      success: true,
      failedCount: 0,
    });

    expect(audioIdOf(scene)).toBeUndefined();
    expect(mocks.audioPut).toHaveBeenCalledTimes(1);
  });

  // A refusal for room says the bytes do not fit. Everything else -- a dropped
  // connection, a 500 -- says nothing about a later attempt, so nothing is left
  // under a key a later load would read as adoptable narration; the line stays
  // unvoiced and retryable instead.
  it('keeps nothing when the pool fails for a reason that is not room', async () => {
    modelAudioTable();
    mocks.poolPut.mockRejectedValue(new Error('asset store unavailable'));
    mockFetch.mockResolvedValueOnce(ttsResponse());

    await expect(generateAndStoreTTS('tts_s2_action_1', 'Hello class')).resolves.toBeNull();
    expect(mocks.audioPut).not.toHaveBeenCalled();
  });

  // Browser-only mode has no pool to refuse anything: document and audio share
  // one lifetime, and the derived key is a complete address.
  it('leaves browser-only narration exactly as it was', async () => {
    const rows = modelAudioTable();
    mocks.serverBacked.mockReturnValue(false);
    mockFetch.mockResolvedValueOnce(ttsResponse());

    const scene = sceneWithOneLine();
    await expect(generateTTSForScene(scene)).resolves.toEqual({ success: true, failedCount: 0 });

    expect(mocks.poolPut).not.toHaveBeenCalled();
    expect(audioIdOf(scene)).toBe(derivedRef);
    expect(rows.get(derivedRef)).toBeDefined();
  });
});
