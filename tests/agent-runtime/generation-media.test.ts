import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionMaterial } from '@openmaic/storage';

const mocks = vi.hoisted(() => ({
  persist: vi.fn(async () => 'https://openmaic.test/api/classroom-media/stage-a/media/image.png'),
}));

vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));

import { buildMaterialMediaTool } from '@/lib/server/agent-runtime/material-media';
import { buildScenePreviewTools } from '@/lib/server/agent-runtime/scene-preview';
import type { CourseStore } from '@/lib/server/agent-runtime/course-tools';

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

describe('generation media tools', () => {
  it('copies session-scoped media bytes into classroom media', async () => {
    const readRawBytes = vi.fn(async () => ({
      bytes: Buffer.from([1, 2, 3]),
      mime: 'image/png',
    }));
    const material = {
      id: 'mat_image',
      sessionId: 'session-a',
      kind: 'image',
      title: 'Image',
      sourceUrl: null,
      textAssetId: null,
      rawAssetId: 'ast_session_media',
      textChars: 0,
      derivedFrom: null,
      extraction: { status: 'done', attempts: 0 },
      createdAt: new Date(0).toISOString(),
    } satisfies AgentSessionMaterial;
    const tool = buildMaterialMediaTool({
      sessionId: 'session-a',
      getMaterial: vi.fn(async (sessionId) => (sessionId === 'session-a' ? material : null)),
      readRawBytes,
    });
    const response = await tool.execute('promote', {
      materialId: material.id,
      stageId: 'stage-a',
    } as never);
    expect(readRawBytes).toHaveBeenCalledWith('session-a', 'ast_session_media');
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: 'stage-a', mime: 'image/png' }),
    );
    expect(response.details).toMatchObject({
      src: 'https://openmaic.test/api/classroom-media/stage-a/media/image.png',
      mimeType: 'image/png',
    });
  });

  it('renders only a page visible through the bound course store', async () => {
    const fetchPreview = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71])));
    const ownedStore = {
      loadDocument: vi.fn(async () => ({
        stage: { id: 'stage-a', name: 'Stage A' },
        scenes: [
          {
            id: 'scene-a',
            stageId: 'stage-a',
            order: 1,
            title: 'A',
            type: 'slide',
            content: { type: 'slide' },
            actions: [],
          },
        ],
      })),
    } as unknown as CourseStore;
    const [owned] = buildScenePreviewTools({
      store: ownedStore,
      stageAccess: async () => ({ kind: 'owned' as const }),
      ownerId: 'user:u1',
      renderService: { url: 'http://render.test' },
      fetchPreview: fetchPreview as typeof fetch,
    });
    const rendered = await owned!.execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);
    expect(rendered.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });

    const foreignStore = { loadDocument: vi.fn(async () => null) } as unknown as CourseStore;
    const [foreign] = buildScenePreviewTools({
      store: foreignStore,
      stageAccess: async () => ({ kind: 'foreign' as const }),
      ownerId: 'user:u1',
      renderService: { url: 'http://render.test' },
      fetchPreview: fetchPreview as typeof fetch,
    });
    const refused = await foreign!.execute('foreign', {
      stageId: 'stage-b',
      sceneId: 'scene-a',
    } as never);
    expect(refused).toMatchObject({ isError: true });
    expect(textOf(refused)).toContain('course not found or not owned');
    // The owner probe refuses BEFORE the store is touched: the foreign call
    // added no render request beyond the successful owned call above.
    expect(fetchPreview).toHaveBeenCalledTimes(1);
  });

  it('omits preview when the render service is not configured', () => {
    expect(
      buildScenePreviewTools({
        store: {} as CourseStore,
        stageAccess: async () => ({ kind: 'owned' as const }),
        ownerId: 'user:u1',
        renderService: { error: 'not_configured' },
      }),
    ).toEqual([]);
  });
});
