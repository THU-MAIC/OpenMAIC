import { describe, expect, test } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
  canonicalizeLegacyOutline,
  canonicalizeLegacyScene,
  canonicalizeLegacyStage,
} from '@/lib/document-store/canonicalize';
import { getDocumentStore } from '@/lib/document-store/store';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';
import type { SceneRecord, StageOutlinesRecord, StageRecord } from '@/lib/utils/database';

const stageRecord: StageRecord = {
  id: 'stage-1',
  name: 'Complete stage',
  description: 'Every legacy field',
  createdAt: 100,
  updatedAt: 200,
  languageDirective: 'Use English',
  style: 'academic',
  currentSceneId: 'scene-1',
  agentIds: ['teacher'],
  videoManifest: { media: { type: 'video', prompt: 'A demo', aspectRatio: '16:9' } },
  interactiveMode: true,
  taskEngineMode: true,
  generatedAgentConfigs: [
    {
      id: 'teacher',
      name: 'Teacher',
      role: 'teacher',
      persona: 'Clear',
      avatar: 'avatar.png',
      color: '#fff',
      priority: 1,
    },
  ],
};

function slideScene(overrides: Record<string, unknown> = {}): AppScene {
  return {
    id: 'slide-1',
    stageId: 'stage-1',
    title: 'Slide',
    order: 0,
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'canvas-1', elements: [] } },
    ...overrides,
  } as unknown as AppScene;
}

function quizScene(): AppScene {
  return {
    id: 'quiz-1',
    stageId: 'stage-1',
    title: 'Quiz',
    order: 1,
    type: 'quiz',
    content: { type: 'quiz', questions: [] },
  } as AppScene;
}

function interactiveScene(): AppScene {
  return {
    id: 'interactive-1',
    stageId: 'stage-1',
    title: 'Interactive',
    order: 2,
    type: 'interactive',
    content: { type: 'interactive', url: 'https://example.test/widget' },
  } as AppScene;
}

function pblScene(): AppScene {
  return {
    id: 'pbl-1',
    stageId: 'stage-1',
    title: 'PBL',
    order: 3,
    type: 'pbl',
    content: {
      type: 'pbl',
      projectConfig: {
        projectInfo: { title: 'Project', description: 'Build it' },
        agents: [],
        issueboard: { agent_ids: [], issues: [], current_issue_id: null },
        chat: { messages: [] },
      },
    },
  } as AppScene;
}

describe('app document persistence seam', () => {
  test('round-trips every StageRecord field after separating playback position', async () => {
    const canonical = canonicalizeLegacyStage(stageRecord);
    const document: AppDocument = {
      stage: canonical.stage,
      scenes: [slideScene()],
    };
    const store = getDocumentStore({
      indexedDB: new IDBFactory(),
      dbName: 'app-document-stage-roundtrip',
    });

    await store.saveDocument(document);
    const loaded = await store.loadDocument(stageRecord.id);

    expect(loaded!.stage).toEqual(canonical.stage);
    expect({ ...loaded!.stage, currentSceneId: canonical.currentSceneId }).toEqual(stageRecord);
  });

  test('round-trips the outline envelope including generationComplete', async () => {
    const outline: SceneOutline = {
      id: 'outline-1',
      type: 'slide',
      title: 'Outline',
      description: 'Intent',
      keyPoints: ['Point'],
      order: 0,
    };
    const legacy: StageOutlinesRecord = {
      stageId: 'stage-1',
      outlines: [outline],
      generationComplete: true,
      createdAt: 10,
      updatedAt: 20,
    };
    const canonical = canonicalizeLegacyOutline(legacy);
    const store = getDocumentStore({
      indexedDB: new IDBFactory(),
      dbName: 'app-document-outline-roundtrip',
    });
    await store.saveDocument({
      stage: canonicalizeLegacyStage(stageRecord).stage,
      scenes: [slideScene()],
      outline: canonical,
    });

    expect((await store.loadDocument('stage-1'))!.outline).toEqual(canonical);
  });
});

describe('app document validators', () => {
  test.each([
    ['slide', slideScene()],
    ['quiz', quizScene()],
    ['interactive', interactiveScene()],
    ['pbl', pblScene()],
  ])('accepts a valid %s scene', (_kind, scene) => {
    expect(validateAppScene(scene)).toEqual({ valid: true });
  });

  test('rejects content/type mismatches with a clear path', () => {
    const result = validateAppScene({
      ...interactiveScene(),
      content: { type: 'pbl', projectConfig: {} },
    });
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors).toContainEqual(expect.objectContaining({ path: '/content/type' }));
  });

  test('rejects stages carrying currentSceneId with a clear path', () => {
    const result = validateAppStage(stageRecord);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual(expect.objectContaining({ path: '/currentSceneId' }));
    }
  });
});

describe('legacy scene canonicalization', () => {
  test('rebinds type, renames whiteboard, and preserves app and unknown fields', () => {
    const legacy = {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'quiz',
      title: 'Legacy',
      order: 0,
      content: { type: 'slide', canvas: { id: 'canvas', elements: [] } },
      actions: [],
      whiteboard: [{ id: 'whiteboard-1', elements: [] }],
      multiAgent: { enabled: true, agentIds: ['teacher'] },
      outlineId: 'outline-1',
      createdAt: 1,
      updatedAt: 2,
      appExtension: { retained: true },
    } as unknown as SceneRecord & Record<string, unknown>;

    const canonical = canonicalizeLegacyScene(legacy);

    expect(canonical.type).toBe('slide');
    expect(canonical.whiteboards).toEqual(legacy.whiteboard);
    expect(canonical.outlineId).toBe('outline-1');
    expect(canonical).toMatchObject({
      multiAgent: legacy.multiAgent,
      createdAt: 1,
      updatedAt: 2,
      appExtension: { retained: true },
    });
    expect(canonical).not.toHaveProperty('whiteboard');
  });

  test('keeps canonical whiteboards when both aliases are present', () => {
    const canonicalWhiteboards = [{ id: 'canonical', elements: [] }];
    const scene = canonicalizeLegacyScene({
      ...slideScene(),
      whiteboard: [{ id: 'legacy', elements: [] }],
      whiteboards: canonicalWhiteboards,
    });
    expect(scene.whiteboards).toEqual(canonicalWhiteboards);
  });
});
