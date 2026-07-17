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
import { projectV2ToLegacyProjectConfig } from '@/lib/pbl/v2/compat';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { makeScene, type Scene } from '@/lib/types/stage';

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
      projectConfig: projectV2ToLegacyProjectConfig(project) as PBLProjectConfig,
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
      projectConfig: projectV2ToLegacyProjectConfig(stripToDesignTemplate(project)),
      projectV2: stripToDesignTemplate(project),
    });
    expect(
      persisted[0]?.content.type === 'pbl' && persisted[0].content.projectConfig.selectedRole,
    ).toBeNull();
    expect(persisted[1]).toBe(slideScene);
    expect(pblScene.content.type === 'pbl' && pblScene.content.projectV2).toBe(project);
  });

  it('does not return stripped scenes when runtime synchronization fails', async () => {
    synchronizePBLProjectRuntimeMock.mockRejectedValueOnce(new Error('runtime unavailable'));

    await expect(
      preparePBLScenesForDocumentPersistence('stage-1', [makePBLScene(makeProject())]),
    ).rejects.toThrow('runtime unavailable');
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
