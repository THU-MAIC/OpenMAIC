/**
 * PBL v2 — Progress operation tests.
 *
 * Pure logic, no LLM. Validates the milestone / microtask state
 * machine: start, advance, milestone wrap, handover gate, skip,
 * continue.
 */
import { describe, it, expect } from 'vitest';
import {
  MILESTONE_DIVIDER_PREFIX,
  startMicrotask,
  advanceMicrotask,
  continueAfterHandover,
  currentMicrotask,
  currentMilestone,
  normalizeProjectRuntime,
  normalizeScenario,
  hasStartedProject,
  resetProjectProgress,
  completeRoleplayAct,
} from '@/lib/pbl/v2/operations/progress';
import {
  appendTaskCompletionReadyMessage,
  currentPendingTaskCompletion,
  isCoreMilestoneFinalMicrotask,
  isTaskCompletionReadyMessageContent,
  setPendingTaskCompletion,
  taskCompletionReadyText,
  taskEvaluationCanComplete,
} from '@/lib/pbl/v2/operations/task-completion';
import { recordEvent } from '@/lib/pbl/v2/operations/engagement';
import { runtimeEventEpoch } from '@/lib/pbl/v2/operations/runtime-events';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

function makeProject(): PBLProjectV2 {
  const now = '2026-05-25T00:00:00.000Z';
  return {
    uiPhase: 'workspace',
    title: 'Test Project',
    description: 'Test',
    proficiency: 'beginner',
    language: 'en-US',
    tags: [],
    status: 'active',
    roles: [
      {
        id: 'role-i',
        type: 'instructor',
        name: 'Instructor',
      },
    ],
    milestones: [
      {
        id: 'ms-1',
        title: 'Milestone 1',
        status: 'active',
        order: 0,
        microtasks: [
          { id: 'mt-1', title: 'Task A', status: 'todo', assignee: 'user', hints: [], order: 0 },
          { id: 'mt-2', title: 'Task B', status: 'todo', assignee: 'user', hints: [], order: 1 },
        ],
        documents: [],
      },
      {
        id: 'ms-2',
        title: 'Milestone 2',
        status: 'locked',
        order: 1,
        microtasks: [
          { id: 'mt-3', title: 'Task C', status: 'todo', assignee: 'user', hints: [], order: 0 },
        ],
        documents: [],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [{ agentId: 'role-i', messages: [] }],
    engagementEvents: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe('PBL v2 progress — current lookups', () => {
  it('currentMilestone returns the active milestone', () => {
    const p = makeProject();
    expect(currentMilestone(p)?.id).toBe('ms-1');
  });

  it('currentMicrotask returns the first todo/in_progress microtask of active milestone', () => {
    const p = makeProject();
    expect(currentMicrotask(p)?.microtask.id).toBe('mt-1');
  });

  it('currentMicrotask skips completed tasks', () => {
    const p = makeProject();
    p.milestones[0].microtasks[0].status = 'completed';
    expect(currentMicrotask(p)?.microtask.id).toBe('mt-2');
  });
});

describe('PBL v2 task-level manual completion gate', () => {
  it('treats task evaluation score >= 60 as passing evidence', () => {
    expect(
      taskEvaluationCanComplete({
        id: 'eval-pass',
        kind: 'task',
        microtaskId: 'mt-1',
        milestoneId: 'ms-1',
        feedback: 'ok',
        strengths: [],
        improvements: [],
        score: 60,
        createdAt: '2026-05-25T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      taskEvaluationCanComplete({
        id: 'eval-low',
        kind: 'task',
        microtaskId: 'mt-1',
        milestoneId: 'ms-1',
        feedback: 'revise',
        strengths: [],
        improvements: [],
        score: 59,
        createdAt: '2026-05-25T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('sets pending completion without advancing the current microtask', () => {
    const p = makeProject();
    startMicrotask(p, 'mt-1');
    setPendingTaskCompletion(p, {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      reason: 'learner solved it in chat',
    });

    expect(currentPendingTaskCompletion(p, 'mt-1')?.reason).toBe('learner solved it in chat');
    expect(p.milestones[0].microtasks[0].status).toBe('in_progress');
    expect(currentMicrotask(p)?.microtask.id).toBe('mt-1');
  });

  it('clears pending completion only when the learner confirms completion', () => {
    const p = makeProject();
    startMicrotask(p, 'mt-1');
    setPendingTaskCompletion(p, {
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      reason: 'ready',
    });

    const result = advanceMicrotask(p, 'mt-1', 'ready', {});
    expect(result.ok).toBe(true);
    expect(p.pendingTaskCompletion).toBeUndefined();
    expect(p.milestones[0].microtasks[0].status).toBe('completed');
    expect(p.milestones[0].microtasks[1].status).toBe('in_progress');
  });

  it('detects the last microtask of a core milestone', () => {
    const p = makeProject();
    p.milestones[0].synthesisCheck = { coreConcept: 'hash lookup' };

    expect(isCoreMilestoneFinalMicrotask(p.milestones[0], 'mt-1')).toBe(false);
    expect(isCoreMilestoneFinalMicrotask(p.milestones[0], 'mt-2')).toBe(true);
    expect(isCoreMilestoneFinalMicrotask(p.milestones[1], 'mt-3')).toBe(false);
  });

  it('can append the ready prompt after a task evaluation card timestamp', () => {
    const p = makeProject();
    const evaluationTs = '2026-05-25T00:00:10.000Z';

    const message = appendTaskCompletionReadyMessage(p, 'mt-1', { afterTs: evaluationTs });

    expect(message).toBeDefined();
    expect(message?.content).toContain('This task is complete');
    expect(message && message.ts > evaluationTs).toBe(true);
  });

  it('recognizes localized ready prompts for chat typewriter playback', () => {
    expect(isTaskCompletionReadyMessageContent(taskCompletionReadyText('zh-CN'))).toBe(true);
    expect(isTaskCompletionReadyMessageContent(taskCompletionReadyText('en-US'))).toBe(true);
    expect(isTaskCompletionReadyMessageContent('普通 instructor 回复')).toBe(false);
  });
});

describe('PBL v2 progress — runtime normalization', () => {
  it('creates the instructor thread and opens the first task when planner output is structural only', () => {
    const p = makeProject();
    p.threads = [];
    p.milestones[0].microtasks[0].status = 'todo';

    expect(normalizeProjectRuntime(p)).toBe(true);
    expect(p.threads).toEqual([{ agentId: 'role-i', messages: [] }]);
    expect(p.milestones[0].status).toBe('active');
    expect(p.milestones[0].microtasks[0].status).toBe('in_progress');
    expect(currentMicrotask(p)?.microtask.id).toBe('mt-1');
  });

  it('activates the first runnable milestone when no milestone is active', () => {
    const p = makeProject();
    p.milestones[0].status = 'locked';

    expect(normalizeProjectRuntime(p)).toBe(true);
    expect(p.milestones[0].status).toBe('active');
    expect(p.milestones[0].microtasks[0].status).toBe('in_progress');
  });

  it('emits deterministic repair ids for the same normalization transition on clones', () => {
    const first = makeProject();
    first.milestones[0].status = 'locked';
    const second = structuredClone(first) as PBLProjectV2;

    expect(normalizeProjectRuntime(first)).toBe(true);
    expect(normalizeProjectRuntime(second)).toBe(true);

    const firstIds = (first.runtimeEvents ?? [])
      .filter((event) => event.kind === 'status_changed')
      .map((event) => event.id);
    const secondIds = (second.runtimeEvents ?? [])
      .filter((event) => event.kind === 'status_changed')
      .map((event) => event.id);

    expect(firstIds).toEqual([
      'norm:0:milestone:ms-1:locked:active',
      'norm:0:microtask:mt-1:todo:in_progress',
    ]);
    expect(secondIds).toEqual(firstIds);
  });

  it('does not open the next milestone while a handover is waiting for Continue', () => {
    const p = makeProject();
    p.milestones[0].status = 'completed';
    p.milestones[0].microtasks.forEach((task) => {
      task.status = 'completed';
    });
    p.pendingHandover = {
      completedMilestoneId: 'ms-1',
      completedMilestoneTitle: 'Milestone 1',
      nextMilestoneId: 'ms-2',
      nextMilestoneTitle: 'Milestone 2',
      nextTaskId: 'mt-3',
      nextTaskTitle: 'Task C',
      consumed: false,
    };

    expect(normalizeProjectRuntime(p)).toBe(false);
    expect(p.milestones[1].status).toBe('locked');
    expect(p.milestones[1].microtasks[0].status).toBe('todo');
    expect(currentMicrotask(p)).toBeUndefined();
  });
});

describe('PBL v2 progress — scenario normalization (degradation safety net)', () => {
  it('is a no-op for ordinary projects (no scenario, no scene)', () => {
    const p = makeProject();
    expect(normalizeScenario(p)).toBe(false);
    expect(p.scenario).toBeUndefined();
  });

  it('keeps a coherent scenario (cast + full prep→roleplay→wrapup skeleton) intact', () => {
    const p = makeProject();
    p.scenario = {
      setting: 'A cosy campus café',
      characters: [{ id: 'char-1', name: '小敏', persona: '内向的同学，说话轻声细语' }],
    };
    p.schemaVersion = 1;
    // A coherent scenario stamps EVERY milestone in the fixed skeleton. Here the
    // fixture has 2 milestones, so: first = prep, last = roleplay (a minimal but
    // valid scenario needs ≥1 roleplay; the repair only fixes missing/invalid
    // stages, so a fully-stamped coherent skeleton must stay untouched).
    p.milestones[0].scenarioStage = 'prep';
    p.milestones[p.milestones.length - 1].scenarioStage = 'roleplay';

    expect(normalizeScenario(p)).toBe(false);
    expect(p.scenario?.characters).toHaveLength(1);
    expect(p.milestones[0].scenarioStage).toBe('prep');
    expect(p.milestones[p.milestones.length - 1].scenarioStage).toBe('roleplay');
    expect(p.schemaVersion).toBe(1);
  });

  it('assigns missing character ids on a coherent scenario', () => {
    const p = makeProject();
    p.scenario = {
      setting: 'Campus café',
      characters: [{ id: '', name: '小敏', persona: '内向的同学' }],
    };
    p.milestones[0].scenarioStage = 'roleplay';

    expect(normalizeScenario(p)).toBe(true);
    expect(p.scenario?.characters[0].id).toBeTruthy();
    expect(p.scenario).toBeDefined();
  });

  it('SKELETON REPAIR: coerces a middle milestone with missing scenarioStage to "roleplay" (the act-transition bug)', () => {
    // Reproduces the real failure: the planner left a MIDDLE act's
    // scenarioStage undefined, so entering it showed the Instructor (prep)
    // thread instead of the live scene. The repair must position-fix it.
    const p = makeProject();
    // give it the 4-milestone shape the bug appeared in: prep, roleplay,
    // <undefined middle>, wrapup.
    p.milestones = [
      { ...p.milestones[0], id: 'ms-prep', scenarioStage: 'prep' },
      { ...p.milestones[0], id: 'ms-rp1', scenarioStage: 'roleplay' },
      { ...p.milestones[0], id: 'ms-mid', scenarioStage: undefined },
      { ...p.milestones[0], id: 'ms-wrap', scenarioStage: 'wrapup' },
    ] as typeof p.milestones;
    p.scenario = {
      setting: 's',
      characters: [{ id: 'c1', name: 'X', persona: 'p' }],
    };

    expect(normalizeScenario(p)).toBe(true);
    // first stays prep, last stays wrapup, the undefined MIDDLE → roleplay
    expect(p.milestones[0].scenarioStage).toBe('prep');
    expect(p.milestones[2].scenarioStage).toBe('roleplay');
    expect(p.milestones[3].scenarioStage).toBe('wrapup');
    // and it does NOT degrade (scenario stays intact)
    expect(p.scenario).toBeDefined();
  });

  it('SKELETON REPAIR: a first/last milestone with missing stage becomes prep/wrapup', () => {
    const p = makeProject();
    p.milestones = [
      { ...p.milestones[0], id: 'ms-a', scenarioStage: undefined },
      { ...p.milestones[0], id: 'ms-b', scenarioStage: 'roleplay' },
      { ...p.milestones[0], id: 'ms-c', scenarioStage: undefined },
    ] as typeof p.milestones;
    p.scenario = { setting: 's', characters: [{ id: 'c1', name: 'X', persona: 'p' }] };

    expect(normalizeScenario(p)).toBe(true);
    expect(p.milestones[0].scenarioStage).toBe('prep');
    expect(p.milestones[1].scenarioStage).toBe('roleplay');
    expect(p.milestones[2].scenarioStage).toBe('wrapup');
  });

  it('case A: clears orphan scenarioStage markers when there is no scenario (no cast)', () => {
    const p = makeProject();
    p.milestones[0].scenarioStage = 'roleplay'; // marker but project.scenario is undefined

    expect(normalizeScenario(p)).toBe(true);
    expect(p.milestones[0].scenarioStage).toBeUndefined();
    expect(p.scenario).toBeUndefined();
  });

  it('case B: drops scenario when the cast is structurally broken (no usable character)', () => {
    const p = makeProject();
    p.scenario = {
      setting: 'Campus café',
      // missing persona → invalid character
      characters: [{ id: 'char-1', name: '小敏', persona: '   ' }],
    };
    p.schemaVersion = 1;
    p.milestones[0].scenarioStage = 'roleplay';

    expect(normalizeScenario(p)).toBe(true);
    expect(p.scenario).toBeUndefined();
    expect(p.schemaVersion).toBeUndefined();
    expect(p.milestones[0].scenarioStage).toBeUndefined();
  });

  it('case C: drops scenario when a valid cast has no scene stage to host it', () => {
    const p = makeProject();
    p.scenario = {
      setting: 'Campus café',
      characters: [{ id: 'char-1', name: '小敏', persona: '内向的同学' }],
    };
    p.schemaVersion = 1;
    // no milestone has scenarioStage === 'roleplay'

    expect(normalizeScenario(p)).toBe(true);
    expect(p.scenario).toBeUndefined();
    expect(p.schemaVersion).toBeUndefined();
  });

  it('is idempotent (running twice does not mutate again)', () => {
    const p = makeProject();
    p.scenario = {
      setting: 'Campus café',
      characters: [{ id: 'char-1', name: '小敏', persona: '内向的同学' }],
    };
    p.milestones[0].scenarioStage = 'roleplay';
    normalizeScenario(p);
    expect(normalizeScenario(p)).toBe(false);
  });
});

describe('PBL v2 progress — start', () => {
  it('startMicrotask flips todo → in_progress and records microtask_opened event', () => {
    const p = makeProject();
    startMicrotask(p, 'mt-1');
    expect(p.milestones[0].microtasks[0].status).toBe('in_progress');
    expect(p.engagementEvents.some((e) => e.kind === 'microtask_opened')).toBe(true);
  });

  it('startMicrotask is idempotent', () => {
    const p = makeProject();
    startMicrotask(p, 'mt-1');
    const before = p.engagementEvents.length;
    startMicrotask(p, 'mt-1');
    expect(p.engagementEvents.length).toBe(before);
  });
});

describe('PBL v2 progress — advance within a milestone', () => {
  it('advanceMicrotask moves to next microtask in the same milestone', () => {
    const p = makeProject();
    startMicrotask(p, 'mt-1');
    const r = advanceMicrotask(p, 'mt-1', 'done', {
      problems: '',
      resolution: 'n/a',
      performance: 'fluent',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.milestoneCompleted).toBe(false);
    expect(r.nextMicrotaskId).toBe('mt-2');
    expect(p.milestones[0].microtasks[0].status).toBe('completed');
    expect(p.milestones[0].microtasks[1].status).toBe('in_progress');
  });

  it('advanceMicrotask refuses already-terminal microtasks', () => {
    const p = makeProject();
    p.milestones[0].microtasks[0].status = 'completed';
    const r = advanceMicrotask(p, 'mt-1', 'x', {
      problems: '',
      resolution: '',
      performance: '',
    });
    expect(r.ok).toBe(false);
  });
});

describe('PBL v2 progress — milestone boundary + handover', () => {
  it('completing the last microtask of a milestone stages a handover, next milestone stays LOCKED', () => {
    const p = makeProject();
    // Complete mt-1 first
    startMicrotask(p, 'mt-1');
    advanceMicrotask(p, 'mt-1', 'done', { problems: '', resolution: '', performance: '' });
    // Now mt-2 is in_progress → complete it
    const r = advanceMicrotask(p, 'mt-2', 'done', {
      problems: '',
      resolution: '',
      performance: 'great',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.milestoneCompleted).toBe(true);
    expect(r.projectCompleted).toBe(false);

    // Next milestone must stay LOCKED until Continue is clicked
    expect(p.milestones[1].status).toBe('locked');
    expect(p.pendingHandover).toBeDefined();
    expect(p.pendingHandover?.nextMilestoneId).toBe('ms-2');
    expect(p.pendingHandover?.consumed).toBe(false);
  });

  it('continueAfterHandover activates the next milestone and its first task', () => {
    const p = makeProject();
    p.pendingHandover = {
      completedMilestoneId: 'ms-1',
      completedMilestoneTitle: 'Milestone 1',
      nextMilestoneId: 'ms-2',
      nextMilestoneTitle: 'Milestone 2',
      nextTaskId: 'mt-3',
      nextTaskTitle: 'Task C',
      consumed: false,
    };
    p.milestones[0].status = 'completed';
    const r = continueAfterHandover(p);
    expect(r.ok).toBe(true);
    expect(r.activatedMicrotaskId).toBe('mt-3');
    expect(p.milestones[1].status).toBe('active');
    expect(p.milestones[1].microtasks[0].status).toBe('in_progress');
    expect(p.pendingHandover?.consumed).toBe(true);
  });

  it('continueAfterHandover appends a milestone divider to the instructor thread', () => {
    const p = makeProject();
    p.pendingHandover = {
      completedMilestoneId: 'ms-1',
      completedMilestoneTitle: 'Milestone 1',
      nextMilestoneId: 'ms-2',
      nextMilestoneTitle: 'Milestone 2',
      nextTaskId: 'mt-3',
      nextTaskTitle: 'Task C',
      consumed: false,
    };
    p.milestones[0].status = 'completed';

    const r = continueAfterHandover(p);

    expect(r.ok).toBe(true);
    const dividerMessages = p.threads[0].messages.filter((m) =>
      m.content.startsWith(MILESTONE_DIVIDER_PREFIX),
    );
    expect(dividerMessages).toHaveLength(1);
    expect(dividerMessages[0].content).toContain('Stage progression');
    expect(dividerMessages[0].content).toContain('Milestone 1');
    expect(dividerMessages[0].content).toContain('Milestone 2');
    expect(dividerMessages[0].microtaskId).toBe('mt-3');
  });

  it('adds NO milestone divider for ANY scenario transition — roleplay AND wrapup (roadmap labels + history block carry the structure)', () => {
    const p = makeProject();
    // Make it a scenario project whose ms-2 is a roleplay stage, with a
    // Simulator thread present (as normalizeProjectRuntime would create).
    p.scenario = {
      setting: 's',
      characters: [{ id: 'c1', name: '林夏', persona: 'p', situation: 'x' }],
    };
    p.milestones[0].scenarioStage = 'roleplay';
    p.milestones[1].scenarioStage = 'roleplay';
    p.threads.push({ agentId: 'simulator', messages: [] });
    p.pendingHandover = {
      completedMilestoneId: 'ms-1',
      completedMilestoneTitle: 'Scene 1',
      nextMilestoneId: 'ms-2',
      nextMilestoneTitle: 'Scene 2',
      nextTaskId: 'mt-3',
      nextTaskTitle: 'Task C',
      consumed: false,
    };
    p.milestones[0].status = 'completed';

    continueAfterHandover(p);

    const instructorThread = p.threads.find((t) => t.agentId === 'role-i');
    const simThread = p.threads.find((t) => t.agentId === 'simulator');
    // No divider anywhere: not in the instructor thread, not in the simulator
    // thread — scenario projects never get an in-chat stage-advance marker.
    expect(
      instructorThread?.messages.filter((m) => m.content.startsWith(MILESTONE_DIVIDER_PREFIX)) ??
        [],
    ).toHaveLength(0);
    expect(
      simThread?.messages.filter((m) => m.content.startsWith(MILESTONE_DIVIDER_PREFIX)) ?? [],
    ).toHaveLength(0);
    expect(p.milestones[1].status).toBe('active');

    // Now cross into a WRAPUP stage — still NO divider (this is the case the
    // user reported: entering 复盘 used to show a "阶段推进 → 复盘" divider).
    p.milestones[1].status = 'completed';
    p.milestones[1].scenarioStage = 'roleplay';
    p.milestones.push({
      id: 'ms-wrap',
      title: 'Debrief',
      status: 'locked',
      order: 2,
      documents: [],
      scenarioStage: 'wrapup',
      microtasks: [
        { id: 'mt-w', title: 'W', status: 'todo', assignee: 'user', hints: [], order: 0 },
      ],
    } as (typeof p.milestones)[number]);
    p.pendingHandover = {
      completedMilestoneId: 'ms-2',
      completedMilestoneTitle: 'Scene 2',
      nextMilestoneId: 'ms-wrap',
      nextMilestoneTitle: 'Debrief',
      nextTaskId: 'mt-w',
      nextTaskTitle: 'W',
      consumed: false,
    };
    continueAfterHandover(p);
    expect(
      instructorThread?.messages.filter((m) => m.content.startsWith(MILESTONE_DIVIDER_PREFIX)) ??
        [],
    ).toHaveLength(0);
  });

  it('localizes the milestone divider label for Chinese projects', () => {
    const p = makeProject();
    p.language = 'zh-CN';
    p.pendingHandover = {
      completedMilestoneId: 'ms-1',
      completedMilestoneTitle: '阶段一',
      nextMilestoneId: 'ms-2',
      nextMilestoneTitle: '阶段二',
      nextTaskId: 'mt-3',
      nextTaskTitle: 'Task C',
      consumed: false,
    };
    p.milestones[0].status = 'completed';

    continueAfterHandover(p);

    const divider = p.threads[0].messages.find((m) =>
      m.content.startsWith(MILESTONE_DIVIDER_PREFIX),
    );
    expect(divider?.content).toContain('阶段推进');
    expect(divider?.content).toContain('阶段一');
    expect(divider?.content).toContain('阶段二');
  });

  it('completing the last microtask of the LAST milestone keeps chat visible for final evaluation', () => {
    const p = makeProject();
    // Pre-complete ms-1
    p.milestones[0].status = 'completed';
    p.milestones[0].microtasks.forEach((t) => (t.status = 'completed'));
    // Activate ms-2 (no handover gate involved here — we simulate that
    // Continue already happened)
    p.milestones[1].status = 'active';
    p.milestones[1].microtasks[0].status = 'in_progress';

    const r = advanceMicrotask(p, 'mt-3', 'done', {
      problems: '',
      resolution: '',
      performance: '',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.projectCompleted).toBe(true);
    expect(p.status).toBe('completed');
    expect(p.uiPhase).toBe('workspace');
  });
});

describe('PBL v2 engagement — recordEvent', () => {
  it('records and caps the event ledger at the soft limit', () => {
    const p = makeProject();
    for (let i = 0; i < 600; i++) {
      recordEvent(p, 'learner_turn', { microtaskId: 'mt-1', milestoneId: 'ms-1' });
    }
    expect(p.engagementEvents.length).toBeLessThanOrEqual(500);
  });
});

describe('PBL v2 progress — hasStartedProject', () => {
  it('is false for a freshly generated project (all tasks todo, empty threads)', () => {
    const p = makeProject();
    p.uiPhase = 'hero';
    expect(hasStartedProject(p)).toBe(false);
  });

  it('stays false after normalizeProjectRuntime opens the first task in_progress', () => {
    // normalizeProjectRuntime opens the first microtask even on a fresh
    // project, so an in_progress task alone must NOT count as "started".
    const p = makeProject();
    p.uiPhase = 'hero';
    p.threads = [];
    normalizeProjectRuntime(p);
    expect(p.milestones[0].microtasks[0].status).toBe('in_progress');
    expect(hasStartedProject(p)).toBe(false);
  });

  it('is true once the instructor thread has a message (GREETING delivered)', () => {
    const p = makeProject();
    p.uiPhase = 'hero';
    p.threads[0].messages.push({
      id: 'm1',
      agentId: 'role-i',
      roleType: 'instructor',
      content: 'Welcome!',
      ts: '2026-05-25T00:01:00.000Z',
    });
    expect(hasStartedProject(p)).toBe(true);
  });

  it('is true when there are submissions, terminal tasks, or a completed project', () => {
    const withSubmission = makeProject();
    withSubmission.submissions.push({
      id: 's1',
      microtaskId: 'mt-1',
      kind: 'text',
      content: 'x',
      createdAt: '2026-05-25T00:01:00.000Z',
    });
    expect(hasStartedProject(withSubmission)).toBe(true);

    const withTerminalTask = makeProject();
    withTerminalTask.milestones[0].microtasks[0].status = 'completed';
    expect(hasStartedProject(withTerminalTask)).toBe(true);

    const completed = makeProject();
    completed.status = 'completed';
    expect(hasStartedProject(completed)).toBe(true);
  });
});

describe('PBL v2 progress — resetProjectProgress', () => {
  function makeStartedProject(): PBLProjectV2 {
    const p = makeProject();
    p.uiPhase = 'completed';
    p.status = 'completed';
    p.proficiency = 'advanced';
    p.proficiencyAssessment = {
      tier: 'advanced',
      score: 0.6,
      confidence: 0.8,
      source: 'dynamic',
      signals: [],
      lastUpdatedAt: '2026-05-25T00:02:00.000Z',
      transitions: [],
      dynamicSignalsSinceRetier: 3,
      turnsSinceRetier: 5,
    };
    p.milestones[0].status = 'completed';
    p.milestones[0].internalAssessment = { performance: 'great' };
    p.milestones[0].microtasks[0].status = 'completed';
    p.milestones[0].microtasks[0].completionReason = 'done';
    p.milestones[0].microtasks[0].internalAssessment = { performance: 'ok' };
    p.milestones[0].microtasks[0].engagement = { learnerTurnCount: 4 };
    p.milestones[1].status = 'active';
    p.milestones[1].microtasks[0].status = 'in_progress';
    p.submissions.push({
      id: 's1',
      microtaskId: 'mt-1',
      kind: 'text',
      content: 'x',
      createdAt: '2026-05-25T00:01:00.000Z',
    });
    p.evaluations.push({
      id: 'e1',
      kind: 'task',
      microtaskId: 'mt-1',
      feedback: 'good',
      strengths: [],
      improvements: [],
      createdAt: '2026-05-25T00:01:30.000Z',
    });
    p.threads[0].messages.push({
      id: 'm1',
      roleType: 'instructor',
      content: 'hi',
      ts: '2026-05-25T00:01:00.000Z',
    });
    p.engagementEvents.push({
      id: 'ev1',
      kind: 'learner_turn',
      ts: '2026-05-25T00:01:00.000Z',
    });
    p.pendingHandover = {
      completedMilestoneId: 'ms-1',
      completedMilestoneTitle: 'Milestone 1',
      nextMilestoneId: 'ms-2',
      nextMilestoneTitle: 'Milestone 2',
      consumed: true,
    };
    return p;
  }

  it('returns a hero-phase project equivalent to a brand-new one', () => {
    const reset = resetProjectProgress(makeStartedProject());

    expect(reset.uiPhase).toBe('hero');
    expect(reset.status).toBe('active');
    expect(reset.submissions).toEqual([]);
    expect(reset.evaluations).toEqual([]);
    expect(reset.engagementEvents).toEqual([]);
    expect(reset.pendingHandover).toBeUndefined();
    expect(hasStartedProject(reset)).toBe(false);
  });

  it('emits project_reset before the reset status events', () => {
    const reset = resetProjectProgress(makeStartedProject());
    const events = reset.runtimeEvents ?? [];
    const firstStatusIndex = events.findIndex((event) => event.kind === 'status_changed');

    expect(events[0]).toMatchObject({
      kind: 'project_reset',
      actorType: 'user',
    });
    expect(firstStatusIndex).toBeGreaterThan(0);
  });

  it('keeps the reset epoch after the visible project_reset marker is evicted', () => {
    const firstReset = resetProjectProgress(makeStartedProject());
    expect(runtimeEventEpoch(firstReset)).toBe(1);

    firstReset.runtimeEvents = firstReset.runtimeEvents?.filter(
      (event) => event.kind !== 'project_reset',
    );
    expect(firstReset.runtimeEvents?.some((event) => event.kind === 'project_reset')).toBe(false);
    expect(runtimeEventEpoch(firstReset)).toBe(1);

    const secondReset = resetProjectProgress(firstReset);
    expect(runtimeEventEpoch(secondReset)).toBe(2);
  });

  it('keeps repeated deterministic status transitions after reset while deduplicating normalization echoes in one epoch', () => {
    const project = makeProject();
    startMicrotask(project, 'mt-1');
    const firstAdvance = advanceMicrotask(project, 'mt-1', 'first pass', {});
    expect(firstAdvance.ok).toBe(true);

    const reset = resetProjectProgress(project);
    startMicrotask(reset, 'mt-1');
    const secondAdvance = advanceMicrotask(reset, 'mt-1', 'second pass', {});
    expect(secondAdvance.ok).toBe(true);

    const completionEvents = (reset.runtimeEvents ?? []).filter(
      (event) =>
        event.kind === 'status_changed' &&
        event.entityType === 'microtask' &&
        event.entityId === 'mt-1' &&
        event.from === 'in_progress' &&
        event.to === 'completed',
    );
    expect(completionEvents).toHaveLength(2);
    expect(new Set(completionEvents.map((event) => event.id)).size).toBe(2);

    const normalized = makeProject();
    normalized.milestones[0].status = 'locked';
    expect(normalizeProjectRuntime(normalized)).toBe(true);
    normalized.milestones[0].status = 'locked';
    normalized.milestones[0].microtasks[0].status = 'todo';
    expect(normalizeProjectRuntime(normalized)).toBe(true);

    const normalizationEvents = (normalized.runtimeEvents ?? []).filter(
      (event) =>
        event.kind === 'status_changed' &&
        (event.id.startsWith('norm:0:milestone:') || event.id.startsWith('norm:0:microtask:')),
    );
    expect(normalizationEvents).toHaveLength(2);
  });

  it('clears every microtask back to todo and re-locks all but the first milestone', () => {
    const reset = resetProjectProgress(makeStartedProject());

    expect(reset.milestones[0].status).toBe('active');
    expect(reset.milestones[1].status).toBe('locked');
    expect(reset.milestones[0].internalAssessment).toBeUndefined();
    for (const milestone of reset.milestones) {
      for (const microtask of milestone.microtasks) {
        expect(microtask.status).toBe('todo');
        expect(microtask.completionReason).toBeUndefined();
        expect(microtask.internalAssessment).toBeUndefined();
        expect(microtask.engagement).toBeUndefined();
      }
    }
  });

  it('empties thread messages while keeping the thread containers', () => {
    const reset = resetProjectProgress(makeStartedProject());
    expect(reset.threads).toEqual([{ agentId: 'role-i', messages: [] }]);
  });

  it('preserves learner proficiency state (reset only clears PBL progress)', () => {
    // proficiency / proficiencyAssessment are learner-model runtime, not PBL
    // progress. Resetting the project must leave them untouched so a restart
    // keeps the learner's calibrated tier instead of regressing to beginner.
    const started = makeStartedProject();
    const reset = resetProjectProgress(started);
    expect(reset.proficiency).toBe('advanced');
    expect(reset.proficiencyAssessment).toEqual(started.proficiencyAssessment);
  });

  it('does not mutate the input project', () => {
    const original = makeStartedProject();
    resetProjectProgress(original);
    expect(original.uiPhase).toBe('completed');
    expect(original.submissions).toHaveLength(1);
    expect(original.milestones[0].microtasks[0].status).toBe('completed');
  });
});

describe('PBL v2 — completeRoleplayAct (act model: deterministic whole-act finish)', () => {
  function actProject(): PBLProjectV2 {
    return {
      language: 'zh-CN',
      roles: [{ id: 'role-i', type: 'instructor', name: '教练' }],
      threads: [
        { agentId: 'role-i', messages: [] },
        {
          agentId: 'simulator',
          // The learner has actually played the first act (a user message tagged
          // to its beat b1) — satisfies the per-act engagement gate.
          messages: [
            {
              id: 'u1',
              roleType: 'user',
              content: '你好',
              ts: '2026-06-08T00:00:10.000Z',
              microtaskId: 'b1',
            },
          ],
        },
      ],
      scenario: { setting: 's', characters: [{ id: 'c1', name: '林夏', persona: 'p' }] },
      milestones: [
        {
          id: 'ms-rp1',
          title: '第一幕',
          status: 'active',
          order: 0,
          documents: [],
          scenarioStage: 'roleplay',
          microtasks: [
            { id: 'b1', title: 'b1', status: 'in_progress', assignee: 'user', hints: [], order: 0 },
            { id: 'b2', title: 'b2', status: 'todo', assignee: 'user', hints: [], order: 1 },
          ],
        },
        {
          id: 'ms-rp2',
          title: '第二幕',
          status: 'locked',
          order: 1,
          documents: [],
          scenarioStage: 'roleplay',
          microtasks: [
            { id: 'b3', title: 'b3', status: 'todo', assignee: 'user', hints: [], order: 0 },
          ],
        },
      ],
      evaluations: [],
      engagementEvents: [],
    } as unknown as PBLProjectV2;
  }

  it('completes ALL beats of the active act AND advances to the next act in one step (no separate Continue)', () => {
    const p = actProject();
    const r = completeRoleplayAct(p, 'act_completed_by_learner');
    expect(r).toEqual({ ok: true, milestoneCompleted: true, projectCompleted: false });
    const ms1 = p.milestones[0];
    expect(ms1.status).toBe('completed');
    expect(ms1.microtasks.every((t) => t.status === 'completed')).toBe(true);
    // One-step: the handover is staged AND immediately consumed, and the next
    // act is already active — so the UI needs no second "next stage" click.
    expect(p.pendingHandover?.completedMilestoneId).toBe('ms-rp1');
    expect(p.pendingHandover?.nextMilestoneId).toBe('ms-rp2');
    expect(p.pendingHandover?.consumed).toBe(true);
    expect(p.milestones[1].status).toBe('active');
    expect(p.milestones[1].microtasks[0].status).toBe('in_progress');
  });

  it('rejects when the active milestone is not a roleplay stage', () => {
    const p = actProject();
    p.milestones[0].scenarioStage = 'prep';
    expect(completeRoleplayAct(p, 'x')).toEqual({ ok: false, error: 'not_in_roleplay_act' });
  });

  it('rejects when the act has no open beats left (already finished)', () => {
    const p = actProject();
    p.milestones[0].microtasks.forEach((t) => (t.status = 'completed'));
    expect(completeRoleplayAct(p, 'x')).toEqual({ ok: false, error: 'already_terminal' });
  });

  it('rejects finishing an act the learner has NOT engaged (no user message tagged to THIS act)', () => {
    const p = actProject();
    // Simulate being on the SECOND act: first act done, second active, but the
    // only user message belongs to the first act (b1) — the shared thread must
    // NOT let the second act be finished without playing it.
    p.milestones[0].status = 'completed';
    p.milestones[0].microtasks.forEach((t) => (t.status = 'completed'));
    p.milestones[1].status = 'active';
    p.milestones[1].microtasks[0].status = 'in_progress';
    expect(completeRoleplayAct(p, 'x')).toEqual({ ok: false, error: 'act_not_engaged' });

    // Once the learner sends a message in the second act (beat b3), it can finish.
    const sim = p.threads.find((t) => t.agentId === 'simulator')!;
    sim.messages.push({
      id: 'u2',
      roleType: 'user',
      content: '继续',
      ts: '2026-06-08T00:05:00.000Z',
      microtaskId: 'b3',
    } as (typeof sim.messages)[number]);
    const r = completeRoleplayAct(p, 'x');
    expect(r.ok).toBe(true);
  });

  it('completing the LAST roleplay act with no next milestone completes the project', () => {
    const p = actProject();
    // drop the second act so the first is the last milestone
    p.milestones = [p.milestones[0]];
    const r = completeRoleplayAct(p, 'x');
    expect(r).toEqual({ ok: true, milestoneCompleted: true, projectCompleted: true });
    expect(p.status).toBe('completed');
  });
});
