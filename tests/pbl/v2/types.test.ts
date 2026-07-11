/**
 * PBL v2 — type schema sanity tests.
 *
 * Pure schema tests: no LLM, no I/O. They guarantee:
 *   1. The exported types compile (caught at typecheck, but the round-
 *      trip test also constructs a full object so any required field
 *      drift is caught at runtime).
 *   2. JSON serialize / deserialize is loss-free (PBL state is
 *      persisted as part of `scene.content` to IndexedDB / Postgres
 *      JSONB — anything that doesn't survive `JSON.parse(JSON.stringify())`
 *      will corrupt learner data).
 *   3. The `isPBLProjectV2` type guard reliably distinguishes v1
 *      `PBLProjectConfig` from v2 `PBLProjectV2`.
 */
import { describe, it, expect } from 'vitest';
import {
  isPBLProjectV2,
  type PBLProjectV2,
  type PBLMilestone,
  type PBLMicrotask,
  type PBLRole,
  type PBLEvaluation,
  type PBLSubmission,
  type PBLEngagementEvent,
  type PBLAgentThread,
  type PBLHandover,
  type PBLRuntimeEvent,
} from '@/lib/pbl/v2/types';

// A fully-populated reference value covering every optional field so
// drift in any nested shape is caught.
function makeFullProject(): PBLProjectV2 {
  const instructorRole: PBLRole = {
    id: 'role-instructor',
    type: 'instructor',
    name: 'Instructor',
    description: 'Guides the learner through the project',
    systemPrompt: 'You are an Instructor...',
  };

  const microtask: PBLMicrotask = {
    id: 'mt-1',
    title: 'Read project context',
    description: 'Open the brief and identify the dataset.',
    status: 'todo',
    assignee: 'user',
    hints: ['Look at the CSV columns.'],
    order: 0,
    internalAssessment: {
      problems: 'Skipped column inspection',
      resolution: 'Re-read the brief once',
      performance: 'ok',
    },
    completionReason: '',
    engagement: {
      startedAt: '2026-05-25T08:00:00.000Z',
      learnerTurnCount: 3,
      errorCount: 1,
      repeatErrorCount: 0,
      errorSignatures: ['undefined_column'],
      conceptsUnlocked: ['DataFrame'],
      struggles: [],
      questionsRaised: 1,
      closingQuestion: 'Why must we read the brief first?',
      closingAnswer: 'To know what the dataset contains.',
      closingQuality: 'ok',
    },
  };

  const milestone: PBLMilestone = {
    id: 'ms-1',
    title: 'Understand the brief',
    description: 'Read the brief and pick the dataset.',
    status: 'active',
    order: 0,
    microtasks: [microtask],
    documents: [
      {
        id: 'doc-1',
        title: 'Project brief',
        content: '# Brief\n\nWe need to analyse sales data.',
        docType: 'markdown',
      },
    ],
    briefing: 'In this stage you will...',
    completionCriteria: 'You have summarised the brief...',
    debrief: 'Great — you now know...',
    internalAssessment: undefined,
  };

  const submission: PBLSubmission = {
    id: 'sub-1',
    microtaskId: 'mt-1',
    milestoneId: 'ms-1',
    kind: 'text',
    content: 'My summary of the brief...',
    summary: 'Learner summarised the brief correctly.',
    createdAt: '2026-05-25T08:05:00.000Z',
  };

  const evaluation: PBLEvaluation = {
    id: 'eval-1',
    kind: 'milestone',
    milestoneId: 'ms-1',
    feedback: 'You did great on this stage...',
    strengths: ['Read the brief carefully'],
    improvements: ['Spend more time on column types'],
    score: 88,
    stars: 4.5,
    createdAt: '2026-05-25T08:10:00.000Z',
  };

  const event: PBLEngagementEvent = {
    id: 'evt-1',
    kind: 'closing_check',
    microtaskId: 'mt-1',
    milestoneId: 'ms-1',
    ts: '2026-05-25T08:09:00.000Z',
    payload: {
      question: 'Why read the brief first?',
      quality: 'ok',
    },
  };

  const thread: PBLAgentThread = {
    agentId: 'role-instructor',
    messages: [
      {
        id: 'msg-1',
        agentId: 'role-instructor',
        roleType: 'instructor',
        content: 'Welcome! Let us start by reading the brief.',
        ts: '2026-05-25T08:00:00.000Z',
        microtaskId: 'mt-1',
      },
      {
        id: 'msg-2',
        roleType: 'user',
        content: 'OK, opening the brief now.',
        ts: '2026-05-25T08:00:30.000Z',
        microtaskId: 'mt-1',
      },
    ],
    earlierSummary: undefined,
  };

  const handover: PBLHandover = {
    completedMilestoneId: 'ms-0-prev',
    completedMilestoneTitle: 'Setup',
    nextMilestoneId: 'ms-1',
    nextMilestoneTitle: 'Understand the brief',
    nextTaskId: 'mt-1',
    nextTaskTitle: 'Read project context',
    consumed: false,
  };

  const runtimeEvent: PBLRuntimeEvent = {
    id: 'runtime-event-1',
    kind: 'tool_call_started',
    actorType: 'agent',
    actorRoleId: 'role-instructor',
    toolCallId: 'tool-call-1',
    toolName: 'advance_micro_task',
    args: { microtaskId: 'mt-1' },
    ts: '2026-05-25T08:09:30.000Z',
    microtaskId: 'mt-1',
    milestoneId: 'ms-1',
  };

  return {
    uiPhase: 'workspace',
    title: 'Python Data Analysis Project',
    description: 'Build a CSV → chart → report mini tool.',
    learningObjective: 'Learn DataFrame, file IO, and visualisation.',
    proficiency: 'beginner',
    language: 'zh-CN',
    tags: ['python', 'data-analysis'],
    status: 'active',
    roles: [instructorRole],
    milestones: [milestone],
    submissions: [submission],
    evaluations: [evaluation],
    threads: [thread],
    engagementEvents: [event],
    runtimeEvents: [runtimeEvent],
    pendingHandover: handover,
    createdAt: '2026-05-25T08:00:00.000Z',
    updatedAt: '2026-05-25T08:10:00.000Z',
  };
}

describe('PBL v2 — types', () => {
  it('JSON round-trip is loss-free on a fully populated project', () => {
    const project = makeFullProject();
    const serialized = JSON.stringify(project);
    const restored = JSON.parse(serialized) as PBLProjectV2;
    expect(restored).toEqual(project);
  });

  it('passes minimal-project structure (only required fields)', () => {
    const minimal: PBLProjectV2 = {
      uiPhase: 'hero',
      title: '',
      description: '',
      proficiency: '',
      language: 'en-US',
      tags: [],
      status: 'designing',
      roles: [],
      milestones: [],
      submissions: [],
      evaluations: [],
      threads: [],
      engagementEvents: [],
      createdAt: '2026-05-25T08:00:00.000Z',
      updatedAt: '2026-05-25T08:00:00.000Z',
    };
    const restored = JSON.parse(JSON.stringify(minimal)) as PBLProjectV2;
    expect(restored).toEqual(minimal);
  });
});

describe('PBL v2 — isPBLProjectV2 type guard', () => {
  it('accepts a valid v2 project', () => {
    expect(isPBLProjectV2(makeFullProject())).toBe(true);
  });

  it('rejects a v1 PBLProjectConfig shape (no uiPhase / milestones)', () => {
    const v1Shape = {
      projectInfo: { title: 't', description: 'd' },
      agents: [],
      issueboard: { agent_ids: [], issues: [], current_issue_id: null },
      chat: { messages: [] },
    };
    expect(isPBLProjectV2(v1Shape)).toBe(false);
  });

  it('rejects null / undefined / primitives', () => {
    expect(isPBLProjectV2(null)).toBe(false);
    expect(isPBLProjectV2(undefined)).toBe(false);
    expect(isPBLProjectV2('string')).toBe(false);
    expect(isPBLProjectV2(42)).toBe(false);
  });

  it('rejects partial v2 shapes (missing milestones array)', () => {
    expect(
      isPBLProjectV2({
        uiPhase: 'hero',
        title: 'incomplete',
        roles: [],
        threads: [],
      }),
    ).toBe(false);
  });
});
