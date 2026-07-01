import { describe, expect, it } from 'vitest';

import { prepareWorkspaceLaunchProject } from '@/lib/pbl/v2/operations/workspace-launch';
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
