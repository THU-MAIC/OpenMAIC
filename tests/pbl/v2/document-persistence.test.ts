import { beforeEach, describe, expect, it, vi } from 'vitest';

const { synchronizePBLProjectRuntimeMock } = vi.hoisted(() => ({
  synchronizePBLProjectRuntimeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/pbl/v2/runtime/hydration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pbl/v2/runtime/hydration')>()),
  synchronizePBLProjectRuntime: (...args: unknown[]) => synchronizePBLProjectRuntimeMock(...args),
}));

import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import { stripToDesignTemplate } from '@/lib/pbl/v2/runtime/learner-state';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { makeScene, type Scene } from '@/lib/types/stage';
import { legacyPBLSceneFixture } from '@/tests/fixtures/pbl-v1-scene';

function makeProject(): PBLProjectV2 {
  return {
    uiPhase: 'completed',
    title: 'Runtime-backed project',
    description: 'Build something',
    proficiency: 'intermediate',
    language: 'en-US',
    tags: [],
    status: 'completed',
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'ms-1',
        title: 'Milestone 1',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 'mt-1',
            title: 'Task 1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [{ agentId: 'role-i', messages: [] }],
    engagementEvents: [],
    runtimeEvents: [
      {
        id: 'event-1',
        kind: 'status_changed',
        actorType: 'user',
        entityType: 'ui_phase',
        entityId: 'project',
        from: 'hero',
        to: 'workspace',
        ts: '2026-07-14T00:00:00.000Z',
      },
    ],
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}

function makePBLScene(project: PBLProjectV2): Scene {
  return makeScene(
    {
      id: 'scene-pbl',
      stageId: 'stage-1',
      title: 'PBL scene',
      order: 0,
    },
    {
      type: 'pbl',
      projectV2: project,
    },
  );
}

function makeSlideScene(): Scene {
  return makeScene(
    {
      id: 'scene-slide',
      stageId: 'stage-1',
      title: 'Slide scene',
      order: 1,
    },
    {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
  );
}

beforeEach(() => {
  synchronizePBLProjectRuntimeMock.mockClear();
});

describe('PBL document persistence cutover', () => {
  it('passes a damaged hybrid through unchanged without runtime synchronization', async () => {
    const damagedHybrid = structuredClone(legacyPBLSceneFixture) as Scene;
    if (damagedHybrid.content.type !== 'pbl') throw new Error('expected PBL scene');
    Reflect.set(damagedHybrid.content, 'projectV2', { title: 'broken' });

    const [persisted] = await preparePBLScenesForDocumentPersistence('stage-1', [damagedHybrid]);

    expect(persisted).toBe(damagedHybrid);
    expect(persisted).toEqual(damagedHybrid);
    expect(synchronizePBLProjectRuntimeMock).not.toHaveBeenCalled();
  });

  it('passes through a project with damaged learner-state containers untouched', async () => {
    const project = makeProject();
    Reflect.set(project, 'threads', {});
    const damagedScene = makePBLScene(project);

    const [persisted] = await preparePBLScenesForDocumentPersistence('stage-1', [damagedScene]);

    expect(persisted).toBe(damagedScene);
    expect(persisted).toEqual(damagedScene);
    expect(synchronizePBLProjectRuntimeMock).not.toHaveBeenCalled();
  });

  it('persists container-valid projects with malformed optional leaves without throwing', async () => {
    const project = makeProject();
    Reflect.set(project, 'gains', [42]);
    Reflect.set(project, 'proficiencyAssessment', {});

    const [persisted] = await preparePBLScenesForDocumentPersistence('stage-1', [
      makePBLScene(project),
    ]);

    expect(synchronizePBLProjectRuntimeMock).toHaveBeenCalledTimes(1);
    expect(persisted.content.type).toBe('pbl');
    if (persisted.content.type !== 'pbl') throw new Error('expected PBL scene');
    expect(persisted.content.projectV2?.gains).toEqual([42]);
    expect(persisted.content.projectV2?.proficiencyAssessment).toBeUndefined();
    expect(persisted.content.projectV2?.proficiency).toBe('intermediate');
  });

  it('passes through a project failing the shared container check untouched', async () => {
    // Single acceptance criterion across validator, resolver and persistence:
    // a payload the renderer will not treat as v2 is inert bytes here too, so
    // persistence must neither synchronize it nor rewrite it.
    const project = makeProject();
    project.threads[0]?.messages.push({
      id: 'message-1',
      roleType: 'user',
      content: 'Learner discussion',
      ts: '2026-07-14T00:01:00.000Z',
    });
    Reflect.set(project, 'gains', 'oops');
    const damagedScene = makePBLScene(project);

    const [persisted] = await preparePBLScenesForDocumentPersistence('stage-1', [damagedScene]);

    expect(persisted).toBe(damagedScene);
    expect(synchronizePBLProjectRuntimeMock).not.toHaveBeenCalled();
  });

  it('passes through a non-runnable v2 payload on a hybrid untouched', async () => {
    // The resolver treats a container-valid v2 payload with no usable task as
    // non-authoritative when legacy data can run; persistence must follow that
    // verdict and neither synchronize nor rewrite either arm of the hybrid.
    const project = makeProject();
    project.milestones.forEach((milestone) => {
      milestone.microtasks = [];
    });
    project.threads[0]?.messages.push({
      id: 'message-1',
      roleType: 'user',
      content: 'Learner discussion',
      ts: '2026-07-14T00:01:00.000Z',
    });
    const hybridScene = structuredClone(legacyPBLSceneFixture) as Scene;
    if (hybridScene.content.type !== 'pbl') throw new Error('expected PBL scene');
    hybridScene.content.projectV2 = project;

    const [persisted] = await preparePBLScenesForDocumentPersistence('stage-1', [hybridScene]);

    expect(persisted).toBe(hybridScene);
    expect(persisted).toEqual(hybridScene);
    expect(synchronizePBLProjectRuntimeMock).not.toHaveBeenCalled();
  });

  it('strips learner state when proficiencyAssessment is an explicit null', async () => {
    const project = makeProject();
    Reflect.set(project, 'proficiencyAssessment', null);

    const [persisted] = await preparePBLScenesForDocumentPersistence('stage-1', [
      makePBLScene(project),
    ]);

    expect(synchronizePBLProjectRuntimeMock).toHaveBeenCalledOnce();
    expect(persisted?.content.type).toBe('pbl');
    if (persisted?.content.type !== 'pbl') return;
    expect(persisted.content.projectV2).toEqual(stripToDesignTemplate(project));
  });

  it('durably synchronizes learner state before returning design-only scenes', async () => {
    const project = makeProject();
    const pblScene = makePBLScene(project);
    const slideScene = makeSlideScene();

    const persisted = await preparePBLScenesForDocumentPersistence('stage-1', [
      pblScene,
      slideScene,
    ]);

    expect(synchronizePBLProjectRuntimeMock).toHaveBeenCalledOnce();
    expect(synchronizePBLProjectRuntimeMock).toHaveBeenCalledWith({
      stageId: 'stage-1',
      sceneId: 'scene-pbl',
      project,
    });
    expect(persisted[0]).not.toBe(pblScene);
    expect(persisted[0]?.content).toMatchObject({
      type: 'pbl',
      projectV2: stripToDesignTemplate(project),
    });
    expect(persisted[0]?.content).not.toHaveProperty('projectConfig');
    expect(persisted[1]).toBe(slideScene);
    expect(pblScene.content.type === 'pbl' && pblScene.content.projectV2).toBe(project);
  });

  it('does not return stripped scenes when runtime synchronization fails', async () => {
    synchronizePBLProjectRuntimeMock.mockRejectedValueOnce(new Error('runtime unavailable'));

    await expect(
      preparePBLScenesForDocumentPersistence('stage-1', [makePBLScene(makeProject())]),
    ).rejects.toThrow('runtime unavailable');
  });

  it('strips hybrid v2 learner state while preserving the original legacy projectConfig', async () => {
    const project = makeProject();
    const projectConfig = structuredClone(
      legacyPBLSceneFixture.content.type === 'pbl'
        ? legacyPBLSceneFixture.content.projectConfig
        : undefined,
    );
    if (!projectConfig) throw new Error('expected legacy PBL projectConfig');
    const hybridScene = makePBLScene(project);
    if (hybridScene.content.type !== 'pbl') throw new Error('expected PBL scene');
    hybridScene.content.projectConfig = projectConfig;

    const [persisted] = await preparePBLScenesForDocumentPersistence('stage-1', [hybridScene]);

    expect(persisted?.content.type).toBe('pbl');
    if (persisted?.content.type !== 'pbl') return;
    expect(persisted.content.projectV2).toEqual(stripToDesignTemplate(project));
    expect(persisted.content.projectConfig).toEqual(projectConfig);
  });

  it('restores the authored proficiency instead of persisting the learner retier', async () => {
    const project = makeProject();
    project.proficiency = 'advanced';
    project.proficiencyAssessment = {
      tier: 'advanced',
      score: 0.8,
      confidence: 0.9,
      source: 'dynamic',
      signals: [],
      lastUpdatedAt: '2026-07-14T00:01:00.000Z',
      transitions: [
        {
          from: 'intermediate',
          to: 'advanced',
          ts: '2026-07-14T00:01:00.000Z',
          reason: 'crossed bucket boundary',
        },
      ],
      dynamicSignalsSinceRetier: 0,
      turnsSinceRetier: 0,
    };

    const [persisted] = await preparePBLScenesForDocumentPersistence('stage-1', [
      makePBLScene(project),
    ]);

    expect(persisted?.content.type).toBe('pbl');
    if (persisted?.content.type !== 'pbl') return;
    expect(persisted.content.projectV2?.proficiency).toBe('intermediate');
  });
});
