/**
 * The production step wiring of a run: which model slot a scene's content
 * resolves through (an unknown type reaches the content step's own refusal),
 * and the media type narration clips are stored with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  synthesizeNarration: vi.fn(),
  storeGeneratedAsset: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/server/generation/steps/narration', () => ({
  synthesizeNarration: mocks.synthesizeNarration,
}));
vi.mock('@/lib/server/store-generated-asset', () => ({
  storeGeneratedAsset: mocks.storeGeneratedAsset,
}));

import { StepRefusal } from '@/lib/server/generation/steps/context';
import { defaultRunStepServices } from '@/lib/server/generation/run/services';
import type { MediaConnection } from '@/lib/server/model-config/media';
import type { SceneOutline } from '@/lib/types/generation';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('run step services', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', '');
    mocks.resolveModel.mockReset().mockResolvedValue({
      model: { id: 'test-model' },
      modelInfo: {},
      modelString: 'test:model',
      serverManaged: true,
    });
  });

  const outline = (type: string): SceneOutline =>
    ({ id: 'o1', type, title: 'Scene', description: '', keyPoints: [], order: 1 }) as never;

  it("resolves a known type's content through its own slot", async () => {
    await expect(
      defaultRunStepServices.sceneContent('user:a', { outline: outline('slide') }, { log }),
    ).rejects.toBeDefined();
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      stage: 'scene-content:slide',
      workspaceId: 'user:a',
    });
  });

  it('resolves an unknown type through course.content and reaches the content refusal', async () => {
    const result = defaultRunStepServices.sceneContent(
      'user:a',
      { outline: outline('video') },
      { log },
    );
    await expect(result).rejects.toBeInstanceOf(StepRefusal);
    await expect(result).rejects.toMatchObject({ reason: 'generation-failed' });
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      stage: 'scene-content',
      workspaceId: 'user:a',
    });
  });

  it.each([
    ['mp3', 'audio/mpeg'],
    ['wav', 'audio/wav'],
    ['ogg', 'audio/ogg'],
    ['opus', 'audio/ogg'],
    ['aac', 'audio/aac'],
    ['flac', 'audio/flac'],
    ['webm', 'audio/webm'],
  ])('stores a %s clip as %s', async (format, mimeType) => {
    mocks.synthesizeNarration.mockResolvedValue({ audio: new Uint8Array([1]), format });
    mocks.storeGeneratedAsset.mockReset().mockResolvedValue({ status: 'stored', assetId: 'ast_1' });
    const id = await defaultRunStepServices.narrateClip(
      'user:a',
      {
        target: {
          connection: { providerId: 'openai-tts' } as MediaConnection,
          providerId: 'openai-tts',
        },
        stageId: 'stage-1',
        text: 'Hello',
        audioId: 'tts_s1_a',
        voice: 'alloy',
        speed: 1,
        fence: async () => undefined,
      },
      { log },
    );
    expect(id).toBe('ast_1');
    expect(mocks.storeGeneratedAsset).toHaveBeenCalledWith(expect.objectContaining({ mimeType }));
  });

  it('refuses audio in a format it cannot serve', async () => {
    mocks.synthesizeNarration.mockResolvedValue({ audio: new Uint8Array([1]), format: 'pcm' });
    await expect(
      defaultRunStepServices.narrateClip(
        'user:a',
        {
          target: { connection: { providerId: 'x' } as MediaConnection, providerId: 'x' as never },
          stageId: 'stage-1',
          text: 'Hello',
          audioId: 'tts_s1_a',
          voice: 'v',
          speed: 1,
          fence: async () => undefined,
        },
        { log },
      ),
    ).rejects.toThrow(/unknown format: pcm/);
  });
});
