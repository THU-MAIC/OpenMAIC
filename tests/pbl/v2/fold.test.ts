import { describe, expect, it } from 'vitest';
import type { RuntimeRecord } from '@openmaic/dsl';

import { foldPBLRuntime } from '@/lib/pbl/v2/runtime/fold';
import { MAX_ENGAGEMENT_EVENTS } from '@/lib/pbl/v2/operations/engagement';
import { emptyAssessment } from '@/lib/pbl/v2/operations/proficiency';
import {
  PBL_RUNTIME_PAYLOAD_VERSION,
  type PBLRuntimeStorePayload,
} from '@/lib/pbl/v2/runtime/record-payloads';
import {
  extractLearnerState,
  stripToDesignTemplate,
  type PBLLearnerState,
} from '@/lib/pbl/v2/runtime/learner-state';
import type { PBLProjectV2, PBLRuntimeEvent } from '@/lib/pbl/v2/types';

function makeProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'hero',
    title: 'Fold project',
    description: 'Build something',
    proficiency: 'intermediate',
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
        microtasks: [
          {
            id: 'mt-1',
            title: 'Task 1',
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

function statusEvent(
  id: string,
  to: string,
  overrides: Partial<Extract<PBLRuntimeEvent, { kind: 'status_changed' }>> = {},
): Extract<PBLRuntimeEvent, { kind: 'status_changed' }> {
  return {
    id,
    kind: 'status_changed',
    actorType: 'system',
    entityType: 'microtask',
    entityId: 'mt-1',
    from: 'todo',
    to,
    ts: `2026-05-29T00:00:${id.slice(-1).padStart(2, '0')}.000Z`,
    microtaskId: 'mt-1',
    milestoneId: 'ms-1',
    ...overrides,
  };
}

function runtimePayload(
  event: PBLRuntimeEvent,
  attachment:
    | Extract<PBLRuntimeStorePayload, { kind: 'pbl_runtime_event' }>['attachment']
    | undefined = undefined,
): PBLRuntimeStorePayload {
  return {
    kind: 'pbl_runtime_event',
    payloadVersion: PBL_RUNTIME_PAYLOAD_VERSION,
    event,
    attachment: attachment ?? null,
    ...(attachment ? {} : { attachmentMissingReason: 'not_attached' }),
  };
}

function snapshotPayload(
  learnerState: PBLLearnerState,
  overrides: Partial<Extract<PBLRuntimeStorePayload, { kind: 'pbl_snapshot' }>> = {},
): PBLRuntimeStorePayload {
  return {
    kind: 'pbl_snapshot',
    payloadVersion: PBL_RUNTIME_PAYLOAD_VERSION,
    epoch: learnerState.runtimeResetEpoch ?? 0,
    learnerState,
    anchor: {},
    reason: 'self_heal',
    ...overrides,
  };
}

function record(seq: number, payload: PBLRuntimeStorePayload, id = `record-${seq}`): RuntimeRecord {
  return {
    id,
    sessionId: 'session-1',
    seq,
    sceneId: 'scene-1',
    createdAt: '2026-05-29T00:00:00.000Z',
    payload,
  };
}

function rawRecord(seq: number, payload: PBLRuntimeEvent, id = `legacy-${seq}`): RuntimeRecord {
  return {
    id,
    sessionId: 'session-1',
    seq,
    sceneId: 'scene-1',
    createdAt: '2026-05-29T00:00:00.000Z',
    payload,
  };
}

describe('foldPBLRuntime', () => {
  it('returns the design baseline for empty history', () => {
    const designTemplate = makeProject({ proficiencyAssessment: emptyAssessment() });

    const folded = foldPBLRuntime({ designTemplate, records: [] });

    expect(folded.learnerState).toEqual(extractLearnerState(stripToDesignTemplate(designTemplate)));
    expect(folded.learnerState.proficiencyAssessment).toBeUndefined();
    expect(folded.diagnostics.gaps).toEqual([]);
  });

  it('orders records strictly by RuntimeStore seq', () => {
    const designTemplate = stripToDesignTemplate(makeProject());
    const folded = foldPBLRuntime({
      designTemplate,
      records: [
        record(2, runtimePayload(statusEvent('evt-2', 'completed'))),
        record(1, runtimePayload(statusEvent('evt-1', 'in_progress'))),
      ],
    });

    expect(folded.learnerState.milestones[0]?.microtasks[0]?.status).toBe('completed');
  });

  it('deduplicates at-least-once duplicate event ids', () => {
    const designTemplate = stripToDesignTemplate(makeProject());
    const folded = foldPBLRuntime({
      designTemplate,
      records: [
        record(0, runtimePayload(statusEvent('same-id', 'in_progress'))),
        record(1, runtimePayload(statusEvent('same-id', 'completed'))),
      ],
    });

    expect(folded.learnerState.milestones[0]?.microtasks[0]?.status).toBe('in_progress');
  });

  it('discards old-epoch events and old-epoch snapshots after project_reset', () => {
    const designTemplate = stripToDesignTemplate(makeProject());
    const completed = extractLearnerState(
      makeProject({
        uiPhase: 'workspace',
        status: 'completed',
        milestones: [
          {
            ...makeProject().milestones[0]!,
            status: 'completed',
            microtasks: [{ ...makeProject().milestones[0]!.microtasks[0]!, status: 'completed' }],
          },
        ],
      }),
    );
    const resetEvent: PBLRuntimeEvent = {
      id: 'reset-1',
      kind: 'project_reset',
      actorType: 'user',
      ts: '2026-05-29T00:00:02.000Z',
    };

    const folded = foldPBLRuntime({
      designTemplate,
      records: [
        record(0, runtimePayload(statusEvent('evt-1', 'completed'))),
        record(1, runtimePayload(resetEvent)),
        record(2, snapshotPayload(completed, { epoch: 0 })),
        record(3, runtimePayload(statusEvent('evt-3', 'in_progress'))),
      ],
    });

    expect(folded.learnerState.runtimeResetEpoch).toBe(1);
    expect(folded.learnerState.status).toBe('active');
    expect(folded.learnerState.uiPhase).toBe('hero');
    expect(folded.learnerState.milestones[0]?.microtasks[0]?.status).toBe('in_progress');
  });

  it('preserves the learner proficiency model across project_reset', () => {
    const designTemplate = stripToDesignTemplate(makeProject());
    const assessment = {
      ...emptyAssessment(),
      tier: 'advanced' as const,
      score: 0.8,
      confidence: 0.9,
    };
    const assessed = extractLearnerState(
      makeProject({ proficiency: 'advanced', proficiencyAssessment: assessment }),
    );
    const resetEvent: PBLRuntimeEvent = {
      id: 'reset-assessed',
      kind: 'project_reset',
      actorType: 'user',
      ts: '2026-05-29T00:00:02.000Z',
    };

    const folded = foldPBLRuntime({
      designTemplate,
      records: [record(0, snapshotPayload(assessed)), record(1, runtimePayload(resetEvent))],
    });

    expect(folded.learnerState.proficiencyAssessment).toEqual(assessment);
    expect(folded.learnerState.runtimeResetEpoch).toBe(1);
  });

  it('uses a snapshot anchor to skip already-reflected duplicate events', () => {
    const designTemplate = stripToDesignTemplate(makeProject());
    const withFirstMessage = extractLearnerState(makeProject());
    withFirstMessage.threads[0]!.messages.push({
      id: 'msg-1',
      roleType: 'user',
      content: 'Already reflected',
      ts: '2026-05-29T00:00:01.000Z',
      microtaskId: 'mt-1',
    });

    const duplicateMessageEvent: PBLRuntimeEvent = {
      id: 'evt-msg-1',
      kind: 'message_created',
      actorType: 'user',
      messageId: 'msg-1',
      threadId: 'role-i',
      ts: '2026-05-29T00:00:01.000Z',
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
    };
    const secondMessageEvent: PBLRuntimeEvent = {
      ...duplicateMessageEvent,
      id: 'evt-msg-2',
      messageId: 'msg-2',
      ts: '2026-05-29T00:00:02.000Z',
    };

    const folded = foldPBLRuntime({
      designTemplate,
      records: [
        record(
          0,
          snapshotPayload(withFirstMessage, {
            anchor: { lastRuntimeEventId: 'evt-msg-1' },
          }),
        ),
        record(
          1,
          runtimePayload(duplicateMessageEvent, {
            kind: 'message',
            message: {
              id: 'msg-1',
              roleType: 'user',
              content: 'Already reflected',
              ts: '2026-05-29T00:00:01.000Z',
              microtaskId: 'mt-1',
            },
          }),
        ),
        record(
          2,
          runtimePayload(secondMessageEvent, {
            kind: 'message',
            message: {
              id: 'msg-2',
              roleType: 'user',
              content: 'New message',
              ts: '2026-05-29T00:00:02.000Z',
              microtaskId: 'mt-1',
            },
          }),
        ),
      ],
    });

    expect(folded.learnerState.threads[0]?.messages.map((message) => message.id)).toEqual([
      'msg-1',
      'msg-2',
    ]);
  });

  it('clears legacy raw-record gaps when a later snapshot supersedes them', () => {
    const designTemplate = stripToDesignTemplate(makeProject());
    const snapshottedState = extractLearnerState(makeProject());
    snapshottedState.threads[0]!.messages.push({
      id: 'legacy-msg',
      roleType: 'user',
      content: 'Recovered by snapshot',
      ts: '2026-05-29T00:00:01.000Z',
      microtaskId: 'mt-1',
    });

    const folded = foldPBLRuntime({
      designTemplate,
      records: [
        rawRecord(0, {
          id: 'legacy-raw-message',
          kind: 'message_created',
          actorType: 'user',
          messageId: 'legacy-msg',
          threadId: 'role-i',
          ts: '2026-05-29T00:00:01.000Z',
          microtaskId: 'mt-1',
          milestoneId: 'ms-1',
        }),
        record(1, snapshotPayload(snapshottedState), 'self-heal-snapshot'),
      ],
    });

    expect(folded.diagnostics.gaps).toEqual([]);
    expect(folded.learnerState).toEqual(snapshottedState);
  });

  it('applies the shared engagement ring cap while folding old records', () => {
    const designTemplate = stripToDesignTemplate(makeProject());
    const engagementEvents = Array.from({ length: MAX_ENGAGEMENT_EVENTS + 3 }, (_, index) => ({
      id: `eng-${index}`,
      kind: 'learner_turn' as const,
      microtaskId: 'mt-1',
      milestoneId: 'ms-1',
      ts: `2026-05-29T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(
        index % 60,
      ).padStart(2, '0')}.000Z`,
      payload: { index },
    }));
    const cappedProject = makeProject({
      engagementEvents: engagementEvents.slice(-MAX_ENGAGEMENT_EVENTS),
    });

    const folded = foldPBLRuntime({
      designTemplate,
      records: engagementEvents.map((event, seq) =>
        record(seq, {
          kind: 'pbl_engagement_event',
          payloadVersion: PBL_RUNTIME_PAYLOAD_VERSION,
          event,
        }),
      ),
    });

    expect(folded.diagnostics.gaps).toEqual([]);
    expect(folded.learnerState).toEqual(extractLearnerState(cappedProject));
  });

  it('clears pre-reset gaps when project_reset starts a new epoch', () => {
    const designTemplate = stripToDesignTemplate(makeProject());
    const resetEvent: PBLRuntimeEvent = {
      id: 'reset-after-gap',
      kind: 'project_reset',
      actorType: 'user',
      ts: '2026-05-29T00:00:02.000Z',
    };

    const folded = foldPBLRuntime({
      designTemplate,
      records: [
        rawRecord(0, {
          id: 'legacy-missing-message',
          kind: 'message_created',
          actorType: 'user',
          messageId: 'missing-message',
          threadId: 'role-i',
          ts: '2026-05-29T00:00:01.000Z',
          microtaskId: 'mt-1',
          milestoneId: 'ms-1',
        }),
        record(1, runtimePayload(resetEvent)),
      ],
    });

    expect(folded.diagnostics.gaps).toEqual([]);
    expect(folded.learnerState.runtimeResetEpoch).toBe(1);
  });

  it('records a gap for forward-version runtime events instead of ignoring them', () => {
    const designTemplate = stripToDesignTemplate(makeProject());
    const folded = foldPBLRuntime({
      designTemplate,
      records: [
        record(0, {
          kind: 'pbl_runtime_event',
          payloadVersion: PBL_RUNTIME_PAYLOAD_VERSION,
          event: {
            id: 'future-event',
            kind: 'future_kind',
            actorType: 'system',
            ts: '2026-05-29T00:00:01.000Z',
          } as unknown as PBLRuntimeEvent,
          attachment: null,
        }),
      ],
    });

    expect(folded.diagnostics.gaps).toEqual([
      expect.objectContaining({
        eventId: 'future-event',
        kind: 'future_kind',
        reason: 'unhandled_event_kind',
      }),
    ]);
  });

  it('reports gaps instead of throwing for malformed history', () => {
    const designTemplate = stripToDesignTemplate(makeProject());

    const folded = foldPBLRuntime({
      designTemplate,
      records: [
        record(
          0,
          runtimePayload(
            statusEvent('evt-missing-task', 'completed', {
              entityId: 'missing-task',
              microtaskId: 'missing-task',
            }),
          ),
        ),
        record(
          1,
          runtimePayload({
            id: 'evt-missing-message',
            kind: 'message_created',
            actorType: 'user',
            messageId: 'missing-message',
            threadId: 'role-i',
            ts: '2026-05-29T00:00:03.000Z',
            microtaskId: 'mt-1',
            milestoneId: 'ms-1',
          }),
        ),
      ],
    });

    expect(folded.diagnostics.gaps.map((gap) => gap.eventId)).toEqual([
      'evt-missing-task',
      'evt-missing-message',
    ]);
  });
});
