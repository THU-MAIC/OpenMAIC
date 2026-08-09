import {
  validateScene,
  type PBLContent as ContractPBLContent,
  type WidgetConfigBase,
} from '@openmaic/dsl';
import type { DocumentStore } from '@openmaic/storage';
import { describe, expect, test, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
  canonicalizeLegacyOutline,
  canonicalizeLegacyScene,
  canonicalizeLegacyStage,
} from '@/lib/document-store/canonicalize';
import { getDocumentStore } from '@/lib/document-store/store';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { upgradeLegacyPBLConfigToProjectV2, type PBLProjectConfig } from '@/lib/pbl/legacy/read';
import type { SceneOutline } from '@/lib/types/generation';
import type { AppScene, InteractiveContent, PBLContent } from '@/lib/types/stage';
import type { SimulationConfig } from '@/lib/types/widgets';
import type { SceneRecord, StageOutlinesRecord, StageRecord } from '@/lib/utils/database';
import { legacyPBLSceneFixture } from '@/tests/fixtures/pbl-v1-scene';

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
  test('round-trips a document containing a v1-native PBL scene', async () => {
    const document: AppDocument = {
      stage: canonicalizeLegacyStage(stageRecord).stage,
      scenes: [{ ...legacyPBLSceneFixture, stageId: stageRecord.id }],
    };
    const store = getDocumentStore({
      indexedDB: new IDBFactory(),
      dbName: 'app-document-legacy-pbl-roundtrip',
    });

    await store.saveDocument(document);

    expect((await store.loadDocument(stageRecord.id))?.scenes).toEqual(document.scenes);
  });

  test('round-trips a stored hybrid with inert damaged projectV2 bytes', async () => {
    const damagedHybrid = structuredClone(legacyPBLSceneFixture) as AppScene;
    if (damagedHybrid.content.type !== 'pbl') throw new Error('expected PBL scene');
    Reflect.set(damagedHybrid.content, 'projectV2', { title: 'broken' });
    const document: AppDocument = {
      stage: canonicalizeLegacyStage(stageRecord).stage,
      scenes: [{ ...damagedHybrid, stageId: stageRecord.id }],
    };
    const store = getDocumentStore({
      indexedDB: new IDBFactory(),
      dbName: 'app-document-damaged-hybrid-roundtrip',
    });

    expect(validateAppScene(document.scenes[0])).toEqual({ valid: true });
    await store.saveDocument(document);

    expect((await store.loadDocument(stageRecord.id))?.scenes).toEqual(document.scenes);
  });

  test('omits nested undefined PBL state before calling the configured store', async () => {
    const saveDocument = vi.fn(async (_document: AppDocument) => undefined);
    const store = getDocumentStore({
      store: { saveDocument } as unknown as DocumentStore,
    });
    const document = {
      stage: canonicalizeLegacyStage(stageRecord).stage,
      scenes: [
        {
          ...pblScene(),
          content: {
            ...pblScene().content,
            projectV2: {
              roles: [],
              milestones: [
                {
                  microtasks: [{ id: 'mt-1', internalAssessment: undefined }],
                },
              ],
              submissions: [],
              evaluations: [],
              threads: [],
              engagementEvents: [],
            },
          },
        },
      ],
    } as unknown as AppDocument;

    await store.saveDocument(document);

    const persisted = saveDocument.mock.calls[0]![0] as AppDocument;
    expect(
      (
        persisted.scenes[0]!.content as unknown as {
          projectV2: { milestones: Array<{ microtasks: Array<Record<string, unknown>> }> };
        }
      ).projectV2.milestones[0]!.microtasks[0],
    ).not.toHaveProperty('internalAssessment');
    expect(
      (
        document.scenes[0]!.content as unknown as {
          projectV2: { milestones: Array<{ microtasks: Array<Record<string, unknown>> }> };
        }
      ).projectV2.milestones[0]!.microtasks[0],
    ).toHaveProperty('internalAssessment', undefined);
  });

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

  test('rejects projectV2 without the renderer-required containers', () => {
    const scene = {
      ...pblScene(),
      content: { type: 'pbl', projectV2: { title: 'V2 project' } },
    } as unknown as AppScene;

    expect(validateAppScene(scene)).toEqual({
      valid: false,
      errors: [
        {
          path: '/content/projectV2',
          message: '`projectV2` must contain milestones, roles and threads arrays',
        },
      ],
    });
  });

  test('accepts damaged projectV2 as inert bytes on a stored hybrid', () => {
    const scene = structuredClone(legacyPBLSceneFixture) as AppScene;
    if (scene.content.type !== 'pbl') throw new Error('expected PBL scene');
    Reflect.set(scene.content, 'projectV2', { title: 'broken' });

    expect(validateAppScene(scene)).toEqual({ valid: true });
  });

  test('an empty projectConfig stub does not disable projectV2 validation', () => {
    const scene = {
      ...pblScene(),
      content: { type: 'pbl', projectConfig: {}, projectV2: { title: 'broken' } },
    } as unknown as AppScene;

    const result = validateAppScene(scene);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        path: '/content/projectV2',
        message: '`projectV2` must contain milestones, roles and threads arrays',
      });
    }
  });

  test('accepts a complete v2 project', () => {
    const content = structuredClone(legacyPBLSceneFixture.content);
    if (content.type !== 'pbl' || !content.projectConfig) {
      throw new Error('expected legacy PBL projectConfig fixture');
    }
    const scene = {
      ...pblScene(),
      content: {
        type: 'pbl',
        projectV2: upgradeLegacyPBLConfigToProjectV2(content.projectConfig),
      },
    } as AppScene;

    expect(validateAppScene(scene)).toEqual({ valid: true });
  });

  test('accepts PBL content with only a legacy projectConfig', () => {
    expect(validateAppScene(legacyPBLSceneFixture)).toEqual({ valid: true });
  });

  test('keeps a historical projectConfig-only scene inside the write-validator matrix', () => {
    const historicalScene = structuredClone(legacyPBLSceneFixture);
    expect(historicalScene.content).not.toHaveProperty('projectV2');
    expect(validateAppScene(historicalScene)).toEqual({ valid: true });
  });

  test('accepts PBL content with an empty legacy projectConfig object', () => {
    expect(
      validateAppScene({
        ...pblScene(),
        content: { type: 'pbl', projectConfig: {} },
      }),
    ).toEqual({ valid: true });
  });

  test('accepts a null projectV2 as if absent', () => {
    expect(
      validateAppScene({
        ...pblScene(),
        content: { type: 'pbl', projectV2: null },
      }),
    ).toEqual({ valid: true });
  });

  test('rejects an array projectV2', () => {
    const result = validateAppScene({
      ...pblScene(),
      content: { type: 'pbl', projectV2: [] },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        path: '/content/projectV2',
        message: '`projectV2` must contain milestones, roles and threads arrays',
      });
    }
  });

  test('rejects an array projectConfig', () => {
    const result = validateAppScene({
      ...pblScene(),
      content: { type: 'pbl', projectConfig: [] },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual({
        path: '/content/projectConfig',
        message: '`projectConfig` must be an object',
      });
    }
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

  test('accepts generated interactive HTML with an empty URL', () => {
    expect(
      validateAppScene({
        ...interactiveScene(),
        content: { type: 'interactive', html: '<!doctype html><main>Widget</main>', url: '' },
      }),
    ).toEqual({ valid: true });
  });

  test('accepts stored interactive widget config without a type', () => {
    const scene = {
      ...interactiveScene(),
      content: {
        type: 'interactive',
        html: '<!doctype html><main>Diagram</main>',
        widgetType: 'diagram',
        widgetConfig: { nodes: [], edges: [], revealOrder: [] },
      },
    } as unknown as AppScene;

    expect(validateAppScene(scene)).toEqual({ valid: true });
    expect(validateScene(scene).valid).toBe(false);
  });

  test('rejects a primitive widget config that would crash hydration', () => {
    const scene = {
      ...interactiveScene(),
      content: {
        type: 'interactive',
        html: '<!doctype html><main>Broken</main>',
        widgetType: 'diagram',
        widgetConfig: 'diagram',
      },
    } as unknown as AppScene;

    const result = validateAppScene(scene);
    expect(result.valid).toBe(false);
    expect(
      result.valid === false && result.errors.some((e) => e.path === '/content/widgetConfig'),
    ).toBe(true);
  });

  test('accepts an unknown widget type at the app write boundary', () => {
    const scene = {
      ...interactiveScene(),
      content: {
        type: 'interactive',
        html: '<!doctype html><main>Future widget</main>',
        widgetType: 'future-kind',
      },
    } as unknown as AppScene;

    expect(validateAppScene(scene)).toEqual({ valid: true });
    expect(validateScene(scene).valid).toBe(false);
  });

  test('keeps canonical app interactive content compatible with the contract validator', () => {
    const content: InteractiveContent = {
      type: 'interactive',
      html: '<!doctype html><main>Simulation</main>',
    };
    const scene: AppScene = {
      id: 'interactive-contract-1',
      stageId: 'stage-1',
      title: 'Contract interactive',
      order: 4,
      type: 'interactive',
      content,
    };

    expect(validateScene(JSON.parse(JSON.stringify(scene)))).toEqual({ valid: true });
  });

  test('rejects stages carrying currentSceneId with a clear path', () => {
    const result = validateAppStage(stageRecord);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContainEqual(expect.objectContaining({ path: '/currentSceneId' }));
    }
  });
});

type Assert<T extends true> = T;

test('typed legacy PBL config remains assignable to app PBLContent', () => {
  type LegacyPBLContent = { type: 'pbl'; projectConfig: PBLProjectConfig };
  const assignable: Assert<LegacyPBLContent extends PBLContent ? true : false> = true;
  expect(assignable).toBe(true);
});

test('app PBLContent remains assignable to the contract PBLContent', () => {
  const assignable: Assert<PBLContent extends ContractPBLContent ? true : false> = true;
  expect(assignable).toBe(true);
});

test('SimulationConfig satisfies the contract widget config base', () => {
  const assignable: Assert<SimulationConfig extends WidgetConfigBase ? true : false> = true;
  expect(assignable).toBe(true);
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
