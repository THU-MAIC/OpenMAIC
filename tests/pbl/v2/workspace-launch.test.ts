import { describe, expect, it, vi } from 'vitest';

import {
  invalidatePendingWorkspaceLaunch,
  isCurrentWorkspaceLaunch,
  prepareCurrentWorkspaceLaunchProject,
  prepareWorkspaceLaunchProject,
} from '@/lib/pbl/v2/operations/workspace-launch';
import type { PBLProjectV2, PriorQuizResult } from '@/lib/pbl/v2/types';

function mkProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'hero',
    title: 'Project',
    description: 'Build something',
    proficiency: 'beginner',
    language: 'zh-CN',
    tags: [],
    status: 'active',
    roles: [],
    milestones: [],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    ...overrides,
  };
}

const quizResult: PriorQuizResult = {
  sceneId: 'quiz-1',
  sceneTitle: 'Pre-check',
  totalQuestions: 2,
  correctCount: 1,
  incorrectCount: 1,
  unscoredCount: 0,
  accuracy: 0.5,
};

describe('prepareWorkspaceLaunchProject', () => {
  it('invalidates a pending launch and clears its busy state on scene change', () => {
    const epoch = { current: 4 };
    const resetLaunching = vi.fn();

    invalidatePendingWorkspaceLaunch(epoch, resetLaunching);

    expect(epoch.current).toBe(5);
    expect(resetLaunching).toHaveBeenCalledWith(false);
  });

  it('rejects a launch when the scene changed before passive effects run', () => {
    expect(isCurrentWorkspaceLaunch(5, { current: 5 }, 'pbl-old', { current: 'pbl-new' })).toBe(
      false,
    );
  });

  it('rejects a superseded launch even when the scene is unchanged', () => {
    expect(isCurrentWorkspaceLaunch(4, { current: 5 }, 'pbl', { current: 'pbl' })).toBe(false);
  });

  it('accepts only the current launch for the current scene', () => {
    expect(isCurrentWorkspaceLaunch(5, { current: 5 }, 'pbl', { current: 'pbl' })).toBe(true);
  });

  it('applies an async launch to the latest project snapshot', () => {
    const project = { current: mkProject({ description: 'Initial', language: 'zh-CN' }) };
    project.current = { ...project.current, description: 'Updated', language: 'en-US' };

    expect(prepareCurrentWorkspaceLaunchProject(project, [quizResult])).toMatchObject({
      uiPhase: 'workspace',
      description: 'Updated',
      language: 'en-US',
      pendingOpenTaskPriorQuizResults: [quizResult],
    });
  });

  it('enters workspace immediately and carries prior quiz results for the greeting', () => {
    const project = mkProject();
    const next = prepareWorkspaceLaunchProject(project, [quizResult]);

    expect(next.uiPhase).toBe('workspace');
    expect(next.pendingOpenTaskPriorQuizResults).toEqual([quizResult]);
    expect(project.uiPhase).toBe('hero');
    expect(project.pendingOpenTaskPriorQuizResults).toBeUndefined();
  });

  it('clears stale launch quiz payload when there is no snapshot to send', () => {
    const project = mkProject({ pendingOpenTaskPriorQuizResults: [quizResult] });
    const next = prepareWorkspaceLaunchProject(project, []);

    expect(next.uiPhase).toBe('workspace');
    expect(next.pendingOpenTaskPriorQuizResults).toBeUndefined();
  });
});
