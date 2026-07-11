import { describe, expect, it } from 'vitest';

import {
  applyAdvanceProjectPatch,
  buildAdvanceProjectPatch,
} from '@/lib/pbl/v2/operations/advance-patch';
import { advanceMicrotask, startMicrotask } from '@/lib/pbl/v2/operations/progress';
import { recordEvent } from '@/lib/pbl/v2/operations/engagement';
import { appendRuntimeEvent, MAX_RUNTIME_EVENTS } from '@/lib/pbl/v2/operations/runtime-events';
import type { PBLProjectV2, PBLRuntimeEvent } from '@/lib/pbl/v2/types';

function makeProject(): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'Project',
    description: 'Build something',
    proficiency: 'beginner',
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
    ],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
  };
}

function statusChangedEvents(
  project: PBLProjectV2,
): Extract<PBLRuntimeEvent, { kind: 'status_changed' }>[] {
  return (project.runtimeEvents ?? []).filter(
    (event): event is Extract<PBLRuntimeEvent, { kind: 'status_changed' }> =>
      event.kind === 'status_changed',
  );
}

function runtimeMessage(id: string): PBLRuntimeEvent {
  return {
    id,
    kind: 'message_created',
    actorType: 'user',
    messageId: `msg-${id}`,
    threadId: 'role-i',
    ts: `2026-05-29T00:00:${id.slice(-2).padStart(2, '0')}.000Z`,
  };
}

describe('PBL v2 advance checkpoint — scenario milestone-eval suppression', () => {
  it('keeps shouldEvaluateMilestone for ordinary projects', () => {
    const p = makeProject();
    const patch = buildAdvanceProjectPatch(p, {
      microtaskId: 'mt-1',
      milestoneCompleted: true,
      projectCompleted: false,
      shouldEvaluateTask: false,
    });
    expect(patch.shouldEvaluateMilestone).toBe(true);
  });

  it('suppresses the milestone-eval card for scenario projects (no per-stage card)', () => {
    const p = makeProject();
    p.scenario = {
      setting: 's',
      characters: [{ id: 'c1', name: '林夏', persona: 'p' }],
    };
    const patch = buildAdvanceProjectPatch(p, {
      microtaskId: 'mt-1',
      milestoneCompleted: true,
      projectCompleted: true,
      shouldEvaluateTask: false,
    });
    expect(patch.shouldEvaluateMilestone).toBe(false);
    // the final eval still fires (drives the completion report + CTA)
    expect(patch.shouldEvaluateFinal).toBe(true);
  });
});

describe('PBL v2 advance checkpoint transport', () => {
  it('builds and applies a checkpoint that preserves completion evidence for evaluator prompts', () => {
    const serverProject = makeProject();
    startMicrotask(serverProject, 'mt-1');
    recordEvent(serverProject, 'learner_turn', { microtaskId: 'mt-1', milestoneId: 'ms-1' });
    recordEvent(serverProject, 'observation_error', {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      payload: { signature: 'off_by_one' },
    });
    recordEvent(serverProject, 'observation_concept_unlocked', {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      payload: { signature: 'bounds_check' },
    });

    const result = advanceMicrotask(serverProject, 'mt-1', 'learner fixed the loop bound', {
      problems: 'off by one',
      resolution: 'adjusted index condition',
      performance: 'recovered quickly',
    });
    if (!result.ok) throw new Error('expected advance to succeed');

    const patch = buildAdvanceProjectPatch(serverProject, {
      microtaskId: 'mt-1',
      nextMicrotaskId: result.nextMicrotaskId,
      milestoneCompleted: result.milestoneCompleted,
      projectCompleted: result.projectCompleted,
      shouldEvaluateTask: false,
    });

    const clientProject = makeProject();
    applyAdvanceProjectPatch(clientProject, patch);

    const completed = clientProject.milestones[0].microtasks[0];
    const opened = clientProject.milestones[0].microtasks[1];
    expect(completed.status).toBe('completed');
    expect(completed.completionReason).toBe('learner fixed the loop bound');
    expect(completed.internalAssessment?.problems).toBe('off by one');
    expect(completed.internalAssessment?.performance).toBe('recovered quickly');
    expect(completed.engagement?.learnerTurnCount).toBe(1);
    expect(completed.engagement?.errorCount).toBe(1);
    expect(completed.engagement?.conceptsUnlocked).toContain('bounds_check');
    expect(opened.status).toBe('in_progress');
    expect(patch.engagementEvents?.map((event) => event.kind)).toEqual([
      'microtask_opened',
      'learner_turn',
      'observation_error',
      'observation_concept_unlocked',
      'microtask_completed',
      'microtask_opened',
    ]);
    expect(clientProject.engagementEvents.map((event) => event.kind)).toEqual([
      'microtask_opened',
      'learner_turn',
      'observation_error',
      'observation_concept_unlocked',
      'microtask_completed',
      'microtask_opened',
    ]);
  });

  it('records status changes when applying a full milestone snapshot patch', () => {
    const serverProject = makeProject();
    const result = advanceMicrotask(serverProject, 'mt-1', 'learner finished the first task', {
      problems: '',
      resolution: 'Ready for task 2',
      performance: 'Steady progress',
    });
    if (!result.ok) throw new Error('expected advance to succeed');

    const patch = buildAdvanceProjectPatch(serverProject, {
      microtaskId: 'mt-1',
      nextMicrotaskId: result.nextMicrotaskId,
      milestoneCompleted: result.milestoneCompleted,
      projectCompleted: result.projectCompleted,
      shouldEvaluateTask: false,
    });

    const clientProject = makeProject();
    applyAdvanceProjectPatch(clientProject, patch);

    expect(
      statusChangedEvents(clientProject).map((event) => ({
        entityType: event.entityType,
        entityId: event.entityId,
        from: event.from,
        to: event.to,
      })),
    ).toEqual([
      {
        entityType: 'microtask',
        entityId: 'mt-1',
        from: 'todo',
        to: 'completed',
      },
      {
        entityType: 'microtask',
        entityId: 'mt-2',
        from: 'todo',
        to: 'in_progress',
      },
    ]);
  });

  it('carries server-minted runtime events once and deduplicates patch replays', () => {
    const serverProject = makeProject();
    serverProject.milestones.push({
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
    });
    serverProject.milestones[0].microtasks = [
      {
        id: 'mt-1',
        title: 'Task 1',
        status: 'todo',
        assignee: 'user',
        hints: [],
        order: 0,
      },
    ];

    const runtimeEventIdsBefore = new Set(
      (serverProject.runtimeEvents ?? []).map((event) => event.id),
    );
    const result = advanceMicrotask(serverProject, 'mt-1', 'stage handover', {
      problems: '',
      resolution: 'Milestone complete',
      performance: 'Ready to continue',
    });
    if (!result.ok) throw new Error('expected advance to succeed');

    const patch = buildAdvanceProjectPatch(serverProject, {
      microtaskId: 'mt-1',
      nextMicrotaskId: result.nextMicrotaskId,
      milestoneCompleted: result.milestoneCompleted,
      projectCompleted: result.projectCompleted,
      shouldEvaluateTask: false,
      runtimeEventIdsBefore,
    });

    const carriedEvents = patch.runtimeEvents ?? [];
    expect(carriedEvents.map((event) => event.kind)).toEqual([
      'status_changed',
      'status_changed',
      'handover_staged',
    ]);

    const clientProject = makeProject();
    clientProject.milestones.push(structuredClone(serverProject.milestones[1]));
    clientProject.milestones[0].microtasks = [
      {
        id: 'mt-1',
        title: 'Task 1',
        status: 'todo',
        assignee: 'user',
        hints: [],
        order: 0,
      },
    ];

    applyAdvanceProjectPatch(clientProject, patch);
    applyAdvanceProjectPatch(clientProject, patch);

    expect(clientProject.runtimeEvents?.map((event) => event.id)).toEqual(
      carriedEvents.map((event) => event.id),
    );
    expect(clientProject.runtimeEvents?.map((event) => event.kind)).toEqual([
      'status_changed',
      'status_changed',
      'handover_staged',
    ]);
    expect(
      statusChangedEvents(clientProject).map((event) => ({
        entityType: event.entityType,
        entityId: event.entityId,
        from: event.from,
        to: event.to,
      })),
    ).toEqual([
      {
        entityType: 'microtask',
        entityId: 'mt-1',
        from: 'todo',
        to: 'completed',
      },
      {
        entityType: 'milestone',
        entityId: 'ms-1',
        from: 'active',
        to: 'completed',
      },
    ]);
  });

  it('carries every newly emitted runtime event when cap eviction happens during advance', () => {
    const serverProject = makeProject();
    serverProject.milestones.push({
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
    });
    serverProject.milestones[0].microtasks = [
      {
        id: 'mt-1',
        title: 'Task 1',
        status: 'todo',
        assignee: 'user',
        hints: [],
        order: 0,
      },
    ];

    for (let i = 0; i < MAX_RUNTIME_EVENTS - 2; i++) {
      appendRuntimeEvent(serverProject, runtimeMessage(`prefill-${i}`));
    }

    const runtimeEventIdsBefore = new Set(
      (serverProject.runtimeEvents ?? []).map((event) => event.id),
    );
    const result = advanceMicrotask(serverProject, 'mt-1', 'stage handover', {
      problems: '',
      resolution: 'Milestone complete',
      performance: 'Ready to continue',
    });
    if (!result.ok) throw new Error('expected advance to succeed');

    const patch = buildAdvanceProjectPatch(serverProject, {
      microtaskId: 'mt-1',
      nextMicrotaskId: result.nextMicrotaskId,
      milestoneCompleted: result.milestoneCompleted,
      projectCompleted: result.projectCompleted,
      shouldEvaluateTask: false,
      runtimeEventIdsBefore,
    });

    expect(serverProject.runtimeEvents).toHaveLength(MAX_RUNTIME_EVENTS);
    expect(patch.runtimeEvents?.map((event) => event.kind)).toEqual([
      'status_changed',
      'status_changed',
      'handover_staged',
    ]);
  });

  it('marks project completed without leaving the workspace before the final CTA', () => {
    const clientProject = makeProject();
    applyAdvanceProjectPatch(clientProject, {
      kind: 'advance',
      microtaskId: 'mt-2',
      milestoneCompleted: true,
      projectCompleted: true,
      shouldEvaluateTask: false,
      shouldEvaluateMilestone: true,
      shouldEvaluateFinal: true,
    });

    expect(clientProject.status).toBe('completed');
    expect(clientProject.uiPhase).toBe('workspace');
  });

  it('does not mark a milestone completed when it has zero microtasks (vacuous every guard)', () => {
    const clientProject = makeProject();
    // Empty out the microtasks to simulate the bug scenario.
    clientProject.milestones[0].microtasks = [];

    applyAdvanceProjectPatch(clientProject, {
      kind: 'advance',
      microtaskId: 'mt-1',
      milestoneCompleted: true,
      projectCompleted: false,
      shouldEvaluateTask: false,
      shouldEvaluateMilestone: true,
      shouldEvaluateFinal: false,
    });

    expect(clientProject.milestones[0].status).not.toBe('completed');
  });

  it('does not mark a milestone completed when every microtask is skipped (no genuine completion)', () => {
    const clientProject = makeProject();
    clientProject.milestones[0].microtasks.forEach((task) => {
      task.status = 'skipped';
    });

    // Use a microtaskId that does NOT match any existing task, so the
    // patch application cannot accidentally set status='completed' on
    // any task before the milestone gate runs.
    applyAdvanceProjectPatch(clientProject, {
      kind: 'advance',
      microtaskId: 'mt-nonexistent',
      milestoneCompleted: true,
      projectCompleted: false,
      shouldEvaluateTask: false,
      shouldEvaluateMilestone: true,
      shouldEvaluateFinal: false,
    });

    expect(clientProject.milestones[0].status).not.toBe('completed');
  });

  it('marks a milestone completed when at least one microtask is genuinely completed (mixed completed + skipped)', () => {
    const clientProject = makeProject();
    clientProject.milestones[0].microtasks[0].status = 'completed';
    clientProject.milestones[0].microtasks[1].status = 'skipped';

    applyAdvanceProjectPatch(clientProject, {
      kind: 'advance',
      microtaskId: 'mt-1',
      milestoneCompleted: true,
      projectCompleted: false,
      shouldEvaluateTask: false,
      shouldEvaluateMilestone: true,
      shouldEvaluateFinal: false,
    });

    expect(clientProject.milestones[0].status).toBe('completed');
  });
});
