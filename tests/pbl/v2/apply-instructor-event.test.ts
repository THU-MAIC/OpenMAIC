import { describe, expect, it } from 'vitest';

import { applyInstructorEvent } from '@/components/scene-renderers/pbl/v2/apply-instructor-event';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

function makeProject(): PBLProjectV2 {
  return {
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    threads: [{ agentId: 'role-i', messages: [] }],
    updatedAt: '2026-05-29T00:00:00.000Z',
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
            status: 'in_progress',
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
    evaluations: [],
    engagementEvents: [],
  } as unknown as PBLProjectV2;
}

describe('PBL v2 — apply SSE events: scenario message routing', () => {
  function makeScenarioProject(): PBLProjectV2 {
    const p = makeProject();
    (p as unknown as { scenario: unknown }).scenario = {
      setting: 's',
      characters: [{ id: 'c1', name: '林夏', persona: 'p', situation: 'x' }],
    };
    p.threads.push({ agentId: 'simulator', messages: [] });
    return p;
  }

  const instructorThread = (p: PBLProjectV2) => p.threads.find((t) => t.agentId === 'role-i')!;
  const simulatorThread = (p: PBLProjectV2) => p.threads.find((t) => t.agentId === 'simulator')!;

  it("routes a 'simulator' message to the simulator thread (not the instructor thread)", () => {
    const project = makeScenarioProject();
    const event: PBLSSEEvent = {
      type: 'project_patch',
      patch: {
        kind: 'message',
        message: {
          id: 'sim-1',
          agentId: 'simulator',
          roleType: 'simulator',
          characterId: 'c1',
          content: '你来啦。',
          ts: '2026-05-29T00:00:02.000Z',
          microtaskId: 'mt-1',
        },
      },
    };
    const next = applyInstructorEvent(event, project, () => {});
    expect(simulatorThread(next).messages).toHaveLength(1);
    expect(simulatorThread(next).messages[0].roleType).toBe('simulator');
    expect(instructorThread(next).messages).toHaveLength(0);
  });

  it("routes a 'system' narration message to the simulator thread", () => {
    const project = makeScenarioProject();
    const event: PBLSSEEvent = {
      type: 'project_patch',
      patch: {
        kind: 'message',
        message: {
          id: 'sys-1',
          agentId: 'simulator',
          roleType: 'system',
          content: '你们走进了一家安静的咖啡馆。',
          ts: '2026-05-29T00:00:02.000Z',
          microtaskId: 'mt-1',
        },
      },
    };
    const next = applyInstructorEvent(event, project, () => {});
    expect(simulatorThread(next).messages).toHaveLength(1);
    expect(instructorThread(next).messages).toHaveLength(0);
  });

  it('still routes instructor messages to the instructor thread on a scenario project', () => {
    const project = makeScenarioProject();
    const event: PBLSSEEvent = {
      type: 'project_patch',
      patch: {
        kind: 'message',
        message: {
          id: 'ins-1',
          agentId: 'role-i',
          roleType: 'instructor',
          content: '欢迎进入项目。',
          ts: '2026-05-29T00:00:02.000Z',
          microtaskId: 'mt-1',
        },
      },
    };
    const next = applyInstructorEvent(event, project, () => {});
    expect(instructorThread(next).messages).toHaveLength(1);
    expect(simulatorThread(next).messages).toHaveLength(0);
  });
});

describe('PBL v2 — apply instructor SSE events', () => {
  it('clears the live draft on reset_draft (advancing turn discards leaked prose)', () => {
    // The server emits reset_draft the moment a turn advances, so a premature
    // next-task mention that leaked into the live draft is dropped immediately
    // instead of lingering until the isolated wrap-up message arrives.
    let draft = '接下来下一阶段我们要做……'; // leaked next-task preview
    const project = makeProject();
    const event: PBLSSEEvent = { type: 'reset_draft' };

    const next = applyInstructorEvent(event, project, (fn) => {
      draft = fn(draft);
    });

    expect(draft).toBe('');
    // No committed message is added by a draft reset.
    expect(next.threads[0].messages).toHaveLength(0);
  });

  it('clears the live draft when a streamed assistant message is committed', () => {
    let draft = '旧任务收尾回答';
    const project = makeProject();
    const event: PBLSSEEvent = {
      type: 'project_patch',
      patch: {
        kind: 'message',
        message: {
          id: 'msg-1',
          agentId: 'role-i',
          roleType: 'instructor',
          content: draft,
          ts: '2026-05-29T00:00:01.000Z',
          microtaskId: 'mt-1',
        },
      },
    };

    const next = applyInstructorEvent(event, project, (fn) => {
      draft = fn(draft);
    });

    expect(next.threads[0].messages).toHaveLength(1);
    expect(draft).toBe('');
  });

  it('does not persist embedded divider protocol markers in normal assistant messages', () => {
    let draft = '';
    const project = makeProject();
    const event: PBLSSEEvent = {
      type: 'project_patch',
      patch: {
        kind: 'message',
        message: {
          id: 'msg-1',
          agentId: 'role-i',
          roleType: 'instructor',
          content:
            '可以，这一步已经完成。[TASK_DIVIDER]任务完成：准备手算测试样例 ｜ 开始下一任务：确定双指针起点',
          ts: '2026-05-29T00:00:01.000Z',
          microtaskId: 'mt-1',
        },
      },
    };

    const next = applyInstructorEvent(event, project, (fn) => {
      draft = fn(draft);
    });

    expect(next.threads[0].messages[0].content).toBe('可以，这一步已经完成。');
  });

  it('keeps standalone divider messages so the chat can render them as dividers', () => {
    let draft = '';
    const project = makeProject();
    const event: PBLSSEEvent = {
      type: 'project_patch',
      patch: {
        kind: 'message',
        message: {
          id: 'msg-divider',
          agentId: 'role-i',
          roleType: 'instructor',
          content: '[TASK_DIVIDER]任务完成：A ｜ 开始下一任务：B',
          ts: '2026-05-29T00:00:01.000Z',
          microtaskId: 'mt-2',
        },
      },
    };

    const next = applyInstructorEvent(event, project, (fn) => {
      draft = fn(draft);
    });

    expect(next.threads[0].messages[0].content).toBe(
      '[TASK_DIVIDER]任务完成：A ｜ 开始下一任务：B',
    );
  });

  it('still appends token events into the live draft', () => {
    let draft = '你好';
    const project = makeProject();

    applyInstructorEvent({ type: 'token', delta: '！' }, project, (fn) => {
      draft = fn(draft);
    });

    expect(draft).toBe('你好！');
  });

  it('clears the live draft when a streamed evaluation is committed', () => {
    let draft = '任务点评正文';
    const project = makeProject();

    const next = applyInstructorEvent(
      {
        type: 'project_patch',
        patch: {
          kind: 'evaluation',
          evaluation: {
            id: 'eval-task-1',
            kind: 'task',
            microtaskId: 'mt-1',
            milestoneId: 'ms-1',
            feedback: '任务点评正文',
            strengths: ['结构清楚'],
            improvements: [],
            score: 88,
            createdAt: '2026-05-29T00:00:01.000Z',
          },
        },
      },
      project,
      (fn) => {
        draft = fn(draft);
      },
    );

    expect(next.evaluations).toHaveLength(1);
    expect(draft).toBe('');
  });

  it('applies authoritative server engagement events instead of reconstructing local ones', () => {
    let draft = '';
    const project = makeProject();
    const next = applyInstructorEvent(
      {
        type: 'project_patch',
        patch: {
          kind: 'engagement_event',
          event: {
            id: 'evt-server-observation',
            kind: 'observation_concept_unlocked',
            microtaskId: 'mt-1',
            milestoneId: 'ms-1',
            ts: '2026-05-29T00:00:01.000Z',
            payload: { signature: 'loop_guard' },
          },
          eventKind: 'observation_concept_unlocked',
          microtaskId: 'mt-1',
          milestoneId: 'ms-1',
          payload: { signature: 'loop_guard' },
        },
      },
      project,
      (fn) => {
        draft = fn(draft);
      },
    );

    expect(next.engagementEvents).toEqual([
      {
        id: 'evt-server-observation',
        kind: 'observation_concept_unlocked',
        microtaskId: 'mt-1',
        milestoneId: 'ms-1',
        ts: '2026-05-29T00:00:01.000Z',
        payload: { signature: 'loop_guard' },
      },
    ]);
  });

  it('merges authoritative advance snapshots so evaluation keeps task process evidence', () => {
    let draft = '';
    const project = makeProject();
    const event: PBLSSEEvent = {
      type: 'project_patch',
      patch: {
        kind: 'advance',
        microtaskId: 'mt-1',
        nextMicrotaskId: 'mt-2',
        milestoneCompleted: false,
        projectCompleted: false,
        completedMicrotask: {
          id: 'mt-1',
          title: 'Task 1',
          status: 'completed',
          assignee: 'user',
          hints: [],
          order: 0,
          completionReason: 'learner solved it',
          internalAssessment: {
            problems: 'minor syntax wobble',
            resolution: 'fixed after prompt',
            performance: 'steady',
          },
          engagement: {
            learnerTurnCount: 3,
            errorCount: 1,
            conceptsUnlocked: ['loop_guard'],
          },
        },
        nextMicrotask: {
          id: 'mt-2',
          title: 'Task 2',
          status: 'in_progress',
          assignee: 'user',
          hints: [],
          order: 1,
        },
        engagementEvents: [
          {
            id: 'evt-turn',
            kind: 'learner_turn',
            microtaskId: 'mt-1',
            milestoneId: 'ms-1',
            ts: '2026-05-29T00:00:01.000Z',
            payload: { chars: 24 },
          },
          {
            id: 'evt-observation',
            kind: 'observation_concept_unlocked',
            microtaskId: 'mt-1',
            milestoneId: 'ms-1',
            ts: '2026-05-29T00:00:01.500Z',
            payload: { signature: 'loop_guard' },
          },
          {
            id: 'evt-completed',
            kind: 'microtask_completed',
            microtaskId: 'mt-1',
            milestoneId: 'ms-1',
            ts: '2026-05-29T00:00:02.000Z',
            payload: { reason: 'learner solved it' },
          },
          {
            id: 'evt-opened',
            kind: 'microtask_opened',
            microtaskId: 'mt-2',
            milestoneId: 'ms-1',
            ts: '2026-05-29T00:00:03.000Z',
          },
        ],
      },
    };

    const next = applyInstructorEvent(event, project, (fn) => {
      draft = fn(draft);
    });

    const completed = next.milestones[0].microtasks[0];
    const opened = next.milestones[0].microtasks[1];
    expect(completed.status).toBe('completed');
    expect(completed.completionReason).toBe('learner solved it');
    expect(completed.internalAssessment?.performance).toBe('steady');
    expect(completed.engagement?.learnerTurnCount).toBe(3);
    expect(completed.engagement?.conceptsUnlocked).toContain('loop_guard');
    expect(opened.status).toBe('in_progress');
    expect(next.engagementEvents.map((event) => event.kind)).toEqual([
      'learner_turn',
      'observation_concept_unlocked',
      'microtask_completed',
      'microtask_opened',
    ]);
  });

  it('deduplicates engagement events included in advance snapshots', () => {
    let draft = '';
    const project = makeProject();
    project.engagementEvents.push({
      id: 'evt-observation',
      kind: 'observation_concept_unlocked',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      ts: '2026-05-29T00:00:02.000Z',
      payload: { signature: 'already_here' },
    });

    const next = applyInstructorEvent(
      {
        type: 'project_patch',
        patch: {
          kind: 'advance',
          microtaskId: 'mt-1',
          milestoneCompleted: false,
          projectCompleted: false,
          engagementEvents: [
            {
              id: 'evt-observation',
              kind: 'observation_concept_unlocked',
              microtaskId: 'mt-1',
              milestoneId: 'ms-1',
              ts: '2026-05-29T00:00:02.000Z',
              payload: { signature: 'already_here' },
            },
            {
              id: 'evt-completed',
              kind: 'microtask_completed',
              microtaskId: 'mt-1',
              milestoneId: 'ms-1',
              ts: '2026-05-29T00:00:03.000Z',
              payload: { reason: 'completed after observation' },
            },
          ],
        },
      },
      project,
      (fn) => {
        draft = fn(draft);
      },
    );

    expect(next.engagementEvents.map((event) => event.id)).toEqual([
      'evt-observation',
      'evt-completed',
    ]);
    expect(next.milestones[0].microtasks[0].status).toBe('completed');
  });
});
