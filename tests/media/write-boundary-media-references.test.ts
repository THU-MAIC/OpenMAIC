/**
 * Every route into durable storage carries content captured at some earlier
 * moment: a queued autosave's snapshot, an editor-history entry replayed by an
 * undo, the departing save a course switch flushes. Any of them can still hold
 * a generation placeholder this session has already allocated for, and writing
 * it would undo a successful write-back with no corrective flush left to
 * follow. The pass that catches this lives at the write boundary, so these
 * tests drive the boundary — the real `saveStageData` / `saveStageDataIncremental`
 * — rather than each producer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutateDocument: vi.fn(),
  serverBacked: vi.fn(),
  saveCurrentScene: vi.fn(),
  saveStageChats: vi.fn(),
}));

vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));

vi.mock('@/lib/document-store', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/document-store')>('@/lib/document-store');
  return { ...actual, mutateDocument: mocks.mutateDocument };
});

import {
  clearPendingMediaAllocations,
  recordMediaAllocation,
} from '@/lib/media/pending-media-allocations';
import { saveStageData, saveStageDataIncremental } from '@/lib/utils/stage-storage';
import type { Scene, Stage } from '@/lib/types/stage';

const stageId = 'boundary-stage';
const placeholder = 'gen_img_boundary';

function sceneWithImage(src: string): Scene {
  return {
    id: 'scene-1',
    stageId,
    title: 'Scene',
    order: 1,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: 'slide-1',
        elements: [{ type: 'image', id: 'image-1', left: 0, top: 0, width: 10, height: 10, src }],
      },
    },
  } as unknown as Scene;
}

function imageSrcOf(scene: Scene): string {
  return (scene as unknown as { content: { canvas: { elements: Array<{ src: string }> } } }).content
    .canvas.elements[0].src;
}

interface Written {
  scenes: Scene[];
  stage?: Stage;
}

function captureWrites(): Written {
  const written: Written = { scenes: [] };
  mocks.mutateDocument.mockImplementation(
    async (
      _stageId: string,
      work: (
        document: unknown,
        store: {
          saveDocument: (doc: { scenes: Scene[]; stage: Stage }) => Promise<void>;
          putScene: (id: string, scene: Scene) => Promise<void>;
          putStage: (id: string, stage: Stage) => Promise<void>;
        },
      ) => Promise<void>,
    ) =>
      work(
        { stage: { id: stageId }, scenes: [], outline: undefined },
        {
          saveDocument: async (doc) => {
            written.scenes = doc.scenes;
            written.stage = doc.stage;
          },
          putScene: async (_id, scene) => {
            written.scenes.push(scene);
          },
          putStage: async (_id, stage) => {
            written.stage = stage;
          },
        },
      ),
  );
  return written;
}

function snapshot(scenes: Scene[]) {
  return {
    stage: { id: stageId, name: 'Course', createdAt: 0, updatedAt: 0 } as unknown as Stage,
    scenes,
    currentSceneId: 'scene-1',
    chats: [],
    chatSnapshot: { sessions: [], restoreMarker: undefined },
  } as never;
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  } as Storage;
}

describe('the persistence write boundary rewrites stale placeholders', () => {
  beforeEach(() => {
    // The aggregate save writes the device-local current-scene key on its way
    // out; the boundary pass runs long before that.
    vi.stubGlobal('localStorage', memoryStorage());
    clearPendingMediaAllocations();
    mocks.serverBacked.mockReset().mockReturnValue(true);
    mocks.mutateDocument.mockReset();
    recordMediaAllocation({ stageId, placeholderRef: placeholder, assetId: 'ast_boundary' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites a queued snapshot captured before the write-back landed', async () => {
    const written = captureWrites();

    // The aggregate save path: the snapshot predates the rewrite entirely.
    await saveStageData(stageId, snapshot([sceneWithImage(placeholder)]), 0);

    expect(imageSrcOf(written.scenes[0])).toBe('ast_boundary');
  });

  it('rewrites an editor-history commit that carries the placeholder back', async () => {
    const written = captureWrites();

    // The incremental path a scene edit takes: whatever content the history
    // replayed, the placeholder cannot reach the document.
    await saveStageDataIncremental(
      stageId,
      [{ kind: 'scene', sceneId: 'scene-1' }],
      snapshot([sceneWithImage(placeholder)]),
      0,
    );

    expect(imageSrcOf(written.scenes[0])).toBe('ast_boundary');
  });

  it('never mutates the snapshot it was handed', async () => {
    captureWrites();
    const scene = sceneWithImage(placeholder);

    await saveStageData(stageId, snapshot([scene]), 0);

    // The store's own object is never mutated on the way to storage.
    expect(imageSrcOf(scene)).toBe(placeholder);
  });

  it('writes an unrelated placeholder through untouched', async () => {
    const written = captureWrites();

    await saveStageData(stageId, snapshot([sceneWithImage('gen_img_other')]), 0);

    expect(imageSrcOf(written.scenes[0])).toBe('gen_img_other');
  });

  it("does not apply one course's allocations to another", async () => {
    const written = captureWrites();

    await saveStageData('another-stage', snapshot([sceneWithImage(placeholder)]), 0);

    expect(imageSrcOf(written.scenes[0])).toBe(placeholder);
  });

  it('is inert in browser-only mode', async () => {
    mocks.serverBacked.mockReturnValue(false);
    const written = captureWrites();

    await saveStageData(stageId, snapshot([sceneWithImage(placeholder)]), 0);

    expect(imageSrcOf(written.scenes[0])).toBe(placeholder);
  });
});
