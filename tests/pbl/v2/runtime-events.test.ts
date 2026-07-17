import { describe, expect, it } from 'vitest';

import { applyInstructorEvent } from '@/components/scene-renderers/pbl/v2/apply-instructor-event';
import { applyAdvanceProjectPatch } from '@/lib/pbl/v2/operations/advance-patch';
import { trackSubmissionScore } from '@/lib/pbl/v2/operations/dynamic-signals';
import { emptyAssessment } from '@/lib/pbl/v2/operations/proficiency';
import {
  advanceMicrotask,
  continueAfterHandover,
  startMicrotask,
} from '@/lib/pbl/v2/operations/progress';
import { applyQuizSignalsToProject } from '@/lib/pbl/v2/operations/quiz-snapshot';
import { appendRuntimeEvent } from '@/lib/pbl/v2/operations/runtime-events';
import { addSubmission } from '@/lib/pbl/v2/operations/submission';
import {
  appendTaskCompletionReadyMessage,
  clearPendingTaskCompletion,
  setPendingTaskCompletion,
} from '@/lib/pbl/v2/operations/task-completion';
import { prepareWorkspaceLaunchProject } from '@/lib/pbl/v2/operations/workspace-launch';
import type { PBLProjectV2, PBLRuntimeEvent, PriorQuizResult } from '@/lib/pbl/v2/types';

function makeProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'Runtime events project',
    description: 'Build something',
    proficiency: 'intermediate',
    proficiencyAssessment: emptyAssessment(),
    language: 'en-US',
    tags: [],
    status: 'active',
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'ms-1',
        title: 'Milestone 1',
        status: 'active',
        order: 0,
        documents: [],
        microtasks: [
          {
            id: 'mt-1',
            title: 'Task 1',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 0,
          },
          {
            id: 'mt-2',
            title: 'Task 2',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 1,
          },
        ],
      },
      {
        id: 'ms-2',
        title: 'Milestone 2',
        status: 'locked',
        order: 1,
        documents: [],
        microtasks: [
          {
            id: 'mt-3',
            title: 'Task 3',
            status: 'todo',
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
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    ...overrides,
  };
}

function onlyRuntimeEvents<K extends PBLRuntimeEvent['kind']>(
  project: PBLProjectV2,
  kind: K,
): Extract<PBLRuntimeEvent, { kind: K }>[] {
  return (project.runtimeEvents ?? []).filter(
    (event): event is Extract<PBLRuntimeEvent, { kind: K }> => event.kind === kind,
  );
}

function expectStamped(event: PBLRuntimeEvent | undefined): asserts event is PBLRuntimeEvent {
  expect(event).toBeDefined();
  expect(event?.id).toEqual(expect.any(String));
  expect(event?.id.length).toBeGreaterThan(0);
  expect(event?.ts).toEqual(expect.any(String));
  expect(Number.isNaN(Date.parse(event?.ts ?? ''))).toBe(false);
}

function runtimeMessage(id: string): PBLRuntimeEvent {
  return {
    id,
    kind: 'message_created',
    actorType: 'user',
    messageId: `msg-${id}`,
    threadId: 'role-i',
    ts: `2026-05-29T00:00:${id.padStart(2, '0')}.000Z`,
  };
}

describe('appendRuntimeEvent', () => {
  it('initializes the runtime ledger and deduplicates by id', () => {
    const project = makeProject({ runtimeEvents: undefined });
    const event = runtimeMessage('01');

    appendRuntimeEvent(project, event);
    appendRuntimeEvent(project, { ...event });

    expect(project.runtimeEvents).toEqual([event]);
  });

  it('caps the runtime ledger at 500 events and evicts oldest first', () => {
    const project = makeProject({ runtimeEvents: [] });

    for (let i = 0; i < 501; i++) {
      appendRuntimeEvent(project, runtimeMessage(String(i)));
    }

    expect(project.runtimeEvents).toHaveLength(500);
    expect(project.runtimeEvents?.[0].id).toBe('1');
    expect(project.runtimeEvents?.at(-1)?.id).toBe('500');
  });
});

describe('runtime event emission from PBL mutations', () => {
  it('records message_created for an applied message patch', () => {
    const project = makeProject();
    const next = applyInstructorEvent(
      {
        type: 'project_patch',
        patch: {
          kind: 'message',
          message: {
            id: 'msg-1',
            agentId: 'role-i',
            roleType: 'instructor',
            content: 'Welcome',
            ts: '2026-05-29T00:00:01.000Z',
            microtaskId: 'mt-1',
          },
        },
      },
      project,
      () => {},
    );

    const event = onlyRuntimeEvents(next, 'message_created')[0];
    expectStamped(event);
    expect(event).toMatchObject({
      kind: 'message_created',
      actorType: 'agent',
      actorRoleId: 'role-i',
      messageId: 'msg-1',
      threadId: 'role-i',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
    });
  });

  it('records message_created for the task-completion ready prompt', () => {
    const project = makeProject();

    const message = appendTaskCompletionReadyMessage(project, 'mt-1');

    const event = onlyRuntimeEvents(project, 'message_created')[0];
    expectStamped(event);
    expect(event).toMatchObject({
      kind: 'message_created',
      actorType: 'agent',
      actorRoleId: 'role-i',
      messageId: message?.id,
      threadId: 'role-i',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
    });
  });

  it('records submission_created when a learner submission is added', () => {
    const project = makeProject();

    const submission = addSubmission(project, {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      kind: 'text',
      content: 'answer',
    });

    const event = onlyRuntimeEvents(project, 'submission_created')[0];
    expectStamped(event);
    expect(event).toMatchObject({
      kind: 'submission_created',
      actorType: 'user',
      submissionId: submission.id,
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
    });
  });

  it('records evaluation_created when an evaluation patch is applied', () => {
    const project = makeProject();
    const next = applyInstructorEvent(
      {
        type: 'project_patch',
        patch: {
          kind: 'evaluation',
          evaluation: {
            id: 'eval-1',
            kind: 'task',
            microtaskId: 'mt-1',
            milestoneId: 'ms-1',
            feedback: 'Good',
            strengths: [],
            improvements: [],
            score: 90,
            createdAt: '2026-05-29T00:00:01.000Z',
          },
        },
      },
      project,
      () => {},
    );

    const event = onlyRuntimeEvents(next, 'evaluation_created')[0];
    expectStamped(event);
    expect(event).toMatchObject({
      kind: 'evaluation_created',
      actorType: 'system',
      evaluationId: 'eval-1',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
    });
  });

  it('records status_changed for microtask status flips', () => {
    const project = makeProject();

    startMicrotask(project, 'mt-1');

    const event = onlyRuntimeEvents(project, 'status_changed')[0];
    expectStamped(event);
    expect(event).toMatchObject({
      kind: 'status_changed',
      actorType: 'system',
      entityType: 'microtask',
      entityId: 'mt-1',
      from: 'todo',
      to: 'in_progress',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
    });
  });

  it('records one status_changed event per semantic status change in an advance patch', () => {
    const project = makeProject();

    applyAdvanceProjectPatch(project, {
      kind: 'advance',
      microtaskId: 'mt-1',
      nextMicrotaskId: 'mt-2',
      milestoneCompleted: false,
      projectCompleted: false,
      shouldEvaluateTask: false,
      shouldEvaluateMilestone: false,
      shouldEvaluateFinal: false,
    });

    const events = onlyRuntimeEvents(project, 'status_changed');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      entityType: 'microtask',
      entityId: 'mt-1',
      from: 'todo',
      to: 'completed',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
    });
    expect(events[1]).toMatchObject({
      entityType: 'microtask',
      entityId: 'mt-2',
      from: 'todo',
      to: 'in_progress',
      microtaskId: 'mt-2',
      milestoneId: 'ms-1',
    });
  });

  it('records handover_staged and handover_consumed around a milestone handover', () => {
    const project = makeProject();
    project.milestones[0].microtasks = [
      {
        id: 'mt-1',
        title: 'Task 1',
        status: 'in_progress',
        assignee: 'user',
        hints: [],
        order: 0,
      },
    ];

    const result = advanceMicrotask(project, 'mt-1', 'done', {
      problems: '',
      resolution: '',
      performance: '',
    });
    expect(result.ok).toBe(true);
    continueAfterHandover(project);

    const staged = onlyRuntimeEvents(project, 'handover_staged')[0];
    const consumed = onlyRuntimeEvents(project, 'handover_consumed')[0];
    expectStamped(staged);
    expectStamped(consumed);
    expect(staged).toMatchObject({
      kind: 'handover_staged',
      actorType: 'system',
      completedMilestoneId: 'ms-1',
      nextMilestoneId: 'ms-2',
      nextMicrotaskId: 'mt-3',
      milestoneId: 'ms-1',
      microtaskId: 'mt-1',
    });
    expect(consumed).toMatchObject({
      kind: 'handover_consumed',
      actorType: 'system',
      completedMilestoneId: 'ms-1',
      nextMilestoneId: 'ms-2',
      activatedMicrotaskId: 'mt-3',
      milestoneId: 'ms-2',
      microtaskId: 'mt-3',
    });
  });

  it('records task_completion_staged and task_completion_cleared events', () => {
    const project = makeProject();

    setPendingTaskCompletion(project, {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      reason: 'passed evaluation',
    });
    clearPendingTaskCompletion(project, 'mt-1');

    const staged = onlyRuntimeEvents(project, 'task_completion_staged')[0];
    const cleared = onlyRuntimeEvents(project, 'task_completion_cleared')[0];
    expectStamped(staged);
    expectStamped(cleared);
    expect(staged).toMatchObject({
      kind: 'task_completion_staged',
      actorType: 'system',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      reason: 'passed evaluation',
    });
    expect(cleared).toMatchObject({
      kind: 'task_completion_cleared',
      actorType: 'system',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
    });
  });

  it('records proficiency_updated after dynamic and quiz signal folds', () => {
    const project = makeProject();
    const quizResults: PriorQuizResult[] = [
      {
        sceneId: 'quiz-1',
        sceneTitle: 'Pre-check',
        totalQuestions: 2,
        correctCount: 2,
        incorrectCount: 0,
        unscoredCount: 0,
        accuracy: 1,
      },
    ];

    trackSubmissionScore(project, 90);
    applyQuizSignalsToProject(project, quizResults);

    const events = onlyRuntimeEvents(project, 'proficiency_updated');
    expect(events).toHaveLength(2);
    for (const event of events) {
      expectStamped(event);
      expect(event).toMatchObject({
        kind: 'proficiency_updated',
        actorType: 'system',
        tier: project.proficiencyAssessment?.tier,
        score: expect.any(Number),
        confidence: expect.any(Number),
      });
    }
  });

  it('records uiPhase status_changed when entering the workspace', () => {
    const project = makeProject({ uiPhase: 'hero', runtimeEvents: undefined });

    const next = prepareWorkspaceLaunchProject(project, []);

    expect(project.runtimeEvents).toBeUndefined();
    const event = onlyRuntimeEvents(next, 'status_changed')[0];
    expectStamped(event);
    expect(event).toMatchObject({
      kind: 'status_changed',
      actorType: 'user',
      entityType: 'ui_phase',
      entityId: 'project',
      from: 'hero',
      to: 'workspace',
    });
  });
});
