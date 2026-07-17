import { describe, expect, it } from 'vitest';

import {
  applyLearnerState,
  extractLearnerState,
  stripToDesignTemplate,
} from '@/lib/pbl/v2/runtime/learner-state';
import { emptyAssessment } from '@/lib/pbl/v2/operations/proficiency';
import type { PBLProjectV2, PBLRuntimeEvent } from '@/lib/pbl/v2/types';

type ProjectFieldBoundary = 'learner-state' | 'design-template' | 'transient';

const PROJECT_FIELD_BOUNDARY = {
  uiPhase: 'learner-state',
  status: 'learner-state',
  milestones: 'learner-state',
  submissions: 'learner-state',
  evaluations: 'learner-state',
  threads: 'learner-state',
  engagementEvents: 'learner-state',
  proficiencyAssessment: 'learner-state',
  pendingHandover: 'learner-state',
  pendingTaskCompletion: 'learner-state',
  runtimeResetEpoch: 'learner-state',
  title: 'design-template',
  description: 'design-template',
  learningObjective: 'design-template',
  gains: 'design-template',
  proficiency: 'design-template',
  language: 'design-template',
  languageDirective: 'design-template',
  tags: 'design-template',
  scenario: 'design-template',
  schemaVersion: 'design-template',
  roles: 'design-template',
  createdAt: 'design-template',
  updatedAt: 'design-template',
  runtimeEvents: 'transient',
  pendingOpenTaskPriorQuizResults: 'transient',
} as const satisfies Record<keyof PBLProjectV2, ProjectFieldBoundary>;

function makeProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'hero',
    title: 'Design-only title',
    description: 'Design-only description',
    learningObjective: 'Design-only learning objective',
    gains: ['Design-only gain'],
    proficiency: 'intermediate',
    proficiencyAssessment: emptyAssessment(),
    language: 'en-US',
    tags: ['design-only-tag'],
    status: 'active',
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'ms-1',
        title: 'Design-only milestone',
        status: 'active',
        order: 0,
        documents: [
          { id: 'doc-1', title: 'Design doc', content: 'Reference', docType: 'markdown' },
        ],
        briefing: 'Design briefing',
        completionCriteria: 'Design criteria',
        debrief: 'Design debrief',
        microtasks: [
          {
            id: 'mt-1',
            title: 'Design-only task',
            description: 'Design-only task description',
            status: 'todo',
            assignee: 'user',
            hints: ['Design-only hint'],
            order: 0,
            completionCriteria: 'Design-only completion criteria',
          },
        ],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [{ agentId: 'role-i', messages: [] }],
    engagementEvents: [],
    runtimeEvents: [],
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    ...overrides,
  };
}

function runtimeEvent(): PBLRuntimeEvent {
  return {
    id: 'rt-1',
    kind: 'message_created',
    actorType: 'user',
    messageId: 'msg-1',
    threadId: 'role-i',
    ts: '2026-05-29T00:00:01.000Z',
    microtaskId: 'mt-1',
    milestoneId: 'ms-1',
  };
}

describe('PBL learner state split', () => {
  it('round-trips learner-owned fields over a stripped design template', () => {
    const project = makeProject({
      uiPhase: 'completed',
      status: 'completed',
      runtimeResetEpoch: 2,
      pendingOpenTaskPriorQuizResults: [
        {
          sceneId: 'quiz-1',
          sceneTitle: 'Prior quiz',
          totalQuestions: 1,
          correctCount: 1,
          incorrectCount: 0,
          unscoredCount: 0,
          accuracy: 1,
        },
      ],
      runtimeEvents: [runtimeEvent()],
    });
    project.milestones[0]!.status = 'completed';
    project.milestones[0]!.internalAssessment = { performance: 'stage complete' };
    project.milestones[0]!.microtasks[0]!.status = 'completed';
    project.milestones[0]!.microtasks[0]!.completionReason = 'learner finished';
    project.milestones[0]!.microtasks[0]!.internalAssessment = {
      problems: 'none',
      resolution: 'clear',
      performance: 'strong',
    };
    project.milestones[0]!.microtasks[0]!.engagement = {
      learnerTurnCount: 3,
      errorCount: 0,
      repeatErrorCount: 0,
      errorSignatures: [],
      conceptsUnlocked: ['loop-invariant'],
      struggles: [],
      questionsRaised: 1,
    };
    project.submissions.push({
      id: 'sub-1',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      kind: 'text',
      content: 'Learner answer',
      createdAt: '2026-05-29T00:01:00.000Z',
    });
    project.evaluations.push({
      id: 'eval-1',
      kind: 'task',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      feedback: 'Good work',
      strengths: ['Clear'],
      improvements: ['Tighter proof'],
      score: 92,
      createdAt: '2026-05-29T00:02:00.000Z',
    });
    project.threads[0]!.messages.push({
      id: 'msg-1',
      roleType: 'user',
      content: 'Here is my answer',
      ts: '2026-05-29T00:00:01.000Z',
      microtaskId: 'mt-1',
    });
    project.engagementEvents.push({
      id: 'eng-1',
      kind: 'learner_turn',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      ts: '2026-05-29T00:00:01.000Z',
      payload: { chars: 17 },
    });
    project.pendingHandover = {
      completedMilestoneId: 'ms-1',
      completedMilestoneTitle: 'Design-only milestone',
      nextMilestoneId: 'ms-2',
      nextMilestoneTitle: 'Next milestone',
      consumed: false,
    };
    project.pendingTaskCompletion = {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      reason: 'ready',
      createdAt: '2026-05-29T00:03:00.000Z',
      assessment: { performance: 'ready' },
    };

    const state = extractLearnerState(project);
    const template = stripToDesignTemplate(project);
    const restored = applyLearnerState(template, state);

    expect(extractLearnerState(restored)).toEqual(state);
    expect(restored.title).toBe('Design-only title');
    expect(restored.milestones[0]!.title).toBe('Design-only milestone');
    expect(restored.milestones[0]!.microtasks[0]!.title).toBe('Design-only task');
    expect(restored.runtimeEvents).toBeUndefined();
    expect(restored.pendingOpenTaskPriorQuizResults).toBeUndefined();
    expect(template.proficiencyAssessment).toBeUndefined();
  });

  it('does not leak design-time fields into PBLLearnerState', () => {
    const state = extractLearnerState(makeProject());

    expect(state).not.toHaveProperty('title');
    expect(state).not.toHaveProperty('description');
    expect(state).not.toHaveProperty('roles');
    expect(state).not.toHaveProperty('runtimeEvents');
    expect(state.milestones[0]).not.toHaveProperty('title');
    expect(state.milestones[0]?.microtasks[0]).not.toHaveProperty('title');
    expect(state.milestones[0]?.microtasks[0]).not.toHaveProperty('hints');
  });

  it('classifies every top-level PBLProjectV2 field into the runtime boundary', () => {
    const project = makeProject({
      learningObjective: 'Understand the runtime boundary',
      gains: ['Runtime confidence'],
      languageDirective: 'English only',
      scenario: {
        setting: 'Stakeholder interview',
        characters: [{ id: 'char-1', name: 'Dana', persona: 'Project stakeholder' }],
      },
      schemaVersion: 1,
      runtimeResetEpoch: 1,
      pendingOpenTaskPriorQuizResults: [
        {
          sceneId: 'quiz-1',
          sceneTitle: 'Prior quiz',
          totalQuestions: 1,
          correctCount: 1,
          incorrectCount: 0,
          unscoredCount: 0,
          accuracy: 1,
        },
      ],
      runtimeEvents: [runtimeEvent()],
    });
    project.pendingHandover = {
      completedMilestoneId: 'ms-1',
      completedMilestoneTitle: 'Design-only milestone',
      nextMilestoneId: 'ms-2',
      nextMilestoneTitle: 'Next milestone',
      consumed: false,
    };
    project.pendingTaskCompletion = {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      reason: 'ready',
      createdAt: '2026-05-29T00:03:00.000Z',
    };

    expect(Object.keys(PROJECT_FIELD_BOUNDARY).sort()).toEqual(Object.keys(project).sort());
  });
});
