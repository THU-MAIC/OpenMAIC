import type { RuntimeRecord } from '@openmaic/dsl';

import type {
  PBLEngagementEvent,
  PBLChatMessage,
  PBLProjectV2,
  PBLRuntimeEvent,
} from '@/lib/pbl/v2/types';
import { MAX_ENGAGEMENT_EVENTS } from '@/lib/pbl/v2/operations/engagement';
import {
  applyLearnerState,
  extractLearnerState,
  stripToDesignTemplate,
  type PBLLearnerState,
} from './learner-state';
import {
  PBL_RUNTIME_EVENT_KINDS_REQUIRING_ATTACHMENT,
  type PBLEngagementEventRecordPayload,
  type PBLRuntimeEventRecordPayload,
  type PBLRuntimeStorePayload,
  type PBLSnapshotRecordPayload,
} from './record-payloads';
import { clone } from './clone';

export interface PBLFoldGap {
  recordId: string;
  seq: number;
  eventId?: string;
  kind: string;
  reason: string;
}

export interface PBLFoldDiagnostics {
  gaps: PBLFoldGap[];
}

export interface FoldPBLRuntimeArgs {
  designTemplate: PBLProjectV2;
  records: readonly RuntimeRecord[];
}

export interface FoldPBLRuntimeResult {
  learnerState: PBLLearnerState;
  diagnostics: PBLFoldDiagnostics;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isRuntimeEvent(value: unknown): value is PBLRuntimeEvent {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    'actorType' in value
  );
}

function isEngagementEvent(value: unknown): value is PBLEngagementEvent {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.ts === 'string' &&
    !('actorType' in value)
  );
}

function normalizePayload(payload: unknown): PBLRuntimeStorePayload | undefined {
  if (!isObject(payload)) return undefined;
  if (payload.kind === 'pbl_runtime_event' && isRuntimeEvent(payload.event)) {
    return payload as unknown as PBLRuntimeStorePayload;
  }
  if (payload.kind === 'pbl_engagement_event' && isEngagementEvent(payload.event)) {
    return payload as unknown as PBLRuntimeStorePayload;
  }
  if (payload.kind === 'pbl_snapshot' && isObject(payload.learnerState)) {
    return payload as unknown as PBLRuntimeStorePayload;
  }
  if (isRuntimeEvent(payload)) {
    return {
      kind: 'pbl_runtime_event',
      payloadVersion: 1,
      event: payload,
      attachment: null,
      attachmentMissingReason: PBL_RUNTIME_EVENT_KINDS_REQUIRING_ATTACHMENT.has(payload.kind)
        ? 'legacy_raw_record_missing_attachment'
        : undefined,
    };
  }
  if (isEngagementEvent(payload)) {
    return {
      kind: 'pbl_engagement_event',
      payloadVersion: 1,
      event: payload,
    };
  }
  return undefined;
}

function eventKey(kind: 'runtime' | 'engagement', id: string): string {
  return `${kind}:${id}`;
}

function addGap(
  gaps: PBLFoldGap[],
  record: RuntimeRecord,
  payload: { kind: string; event?: { id?: string; kind?: string } } | undefined,
  reason: string,
): void {
  const event = payload?.event;
  gaps.push({
    recordId: record.id,
    seq: record.seq,
    eventId: event?.id,
    kind: event?.kind ?? payload?.kind ?? 'unknown',
    reason,
  });
}

function findMilestone(state: PBLLearnerState, milestoneId: string) {
  return state.milestones.find((milestone) => milestone.id === milestoneId);
}

function findMicrotask(state: PBLLearnerState, microtaskId: string) {
  for (const milestone of state.milestones) {
    const microtask = milestone.microtasks.find((candidate) => candidate.id === microtaskId);
    if (microtask) return { milestone, microtask };
  }
  return undefined;
}

function upsertThreadMessage(
  state: PBLLearnerState,
  threadId: string,
  message: PBLChatMessage,
): void {
  let thread = state.threads.find((candidate) => candidate.agentId === threadId);
  if (!thread) {
    thread = { agentId: threadId, messages: [] };
    state.threads.push(thread);
  }
  if (!thread.messages.some((candidate) => candidate.id === message.id)) {
    thread.messages.push(clone(message));
  }
}

function applyRuntimeEvent(
  state: PBLLearnerState,
  payload: PBLRuntimeEventRecordPayload,
  record: RuntimeRecord,
  gaps: PBLFoldGap[],
): 'reset' | undefined {
  const event = payload.event;
  switch (event.kind) {
    case 'project_reset':
      return 'reset';
    case 'status_changed': {
      if (event.entityType === 'project') {
        state.status = event.to as PBLLearnerState['status'];
        return undefined;
      }
      if (event.entityType === 'ui_phase') {
        state.uiPhase = event.to as PBLLearnerState['uiPhase'];
        return undefined;
      }
      if (event.entityType === 'milestone') {
        const milestone = findMilestone(state, event.entityId);
        if (!milestone) {
          addGap(gaps, record, payload, 'milestone_not_found');
          return undefined;
        }
        milestone.status = event.to as typeof milestone.status;
        if (payload.attachment?.kind === 'status') {
          milestone.internalAssessment = clone(payload.attachment.milestone?.internalAssessment);
        }
        return undefined;
      }
      const found = findMicrotask(state, event.entityId);
      if (!found) {
        addGap(gaps, record, payload, 'microtask_not_found');
        return undefined;
      }
      found.microtask.status = event.to as typeof found.microtask.status;
      if (payload.attachment?.kind === 'status') {
        found.microtask.internalAssessment = clone(
          payload.attachment.microtask?.internalAssessment,
        );
        found.microtask.completionReason = payload.attachment.microtask?.completionReason;
        found.microtask.engagement = clone(payload.attachment.microtask?.engagement);
      }
      return undefined;
    }
    case 'message_created':
      if (payload.attachment?.kind !== 'message') {
        addGap(
          gaps,
          record,
          payload,
          payload.attachmentMissingReason ?? 'message_attachment_missing',
        );
        return undefined;
      }
      upsertThreadMessage(state, event.threadId, payload.attachment.message);
      return undefined;
    case 'submission_created':
      if (payload.attachment?.kind !== 'submission') {
        addGap(
          gaps,
          record,
          payload,
          payload.attachmentMissingReason ?? 'submission_attachment_missing',
        );
        return undefined;
      }
      {
        const attachment = payload.attachment;
        if (!state.submissions.some((submission) => submission.id === attachment.submission.id)) {
          state.submissions.push(clone(attachment.submission));
        }
      }
      return undefined;
    case 'evaluation_created':
      if (payload.attachment?.kind !== 'evaluation') {
        addGap(
          gaps,
          record,
          payload,
          payload.attachmentMissingReason ?? 'evaluation_attachment_missing',
        );
        return undefined;
      }
      {
        const attachment = payload.attachment;
        if (!state.evaluations.some((evaluation) => evaluation.id === attachment.evaluation.id)) {
          state.evaluations.push(clone(attachment.evaluation));
        }
      }
      return undefined;
    case 'handover_staged':
      if (payload.attachment?.kind !== 'handover') {
        addGap(
          gaps,
          record,
          payload,
          payload.attachmentMissingReason ?? 'handover_attachment_missing',
        );
        return undefined;
      }
      state.pendingHandover = clone(payload.attachment.handover);
      return undefined;
    case 'handover_consumed':
      if (payload.attachment?.kind === 'handover') {
        state.pendingHandover = clone(payload.attachment.handover);
      } else if (state.pendingHandover) {
        state.pendingHandover = { ...state.pendingHandover, consumed: true };
      } else {
        addGap(
          gaps,
          record,
          payload,
          payload.attachmentMissingReason ?? 'handover_attachment_missing',
        );
      }
      return undefined;
    case 'task_completion_staged':
      if (payload.attachment?.kind !== 'pending_task_completion') {
        addGap(
          gaps,
          record,
          payload,
          payload.attachmentMissingReason ?? 'pending_task_completion_attachment_missing',
        );
        return undefined;
      }
      state.pendingTaskCompletion = clone(payload.attachment.pendingTaskCompletion);
      return undefined;
    case 'task_completion_cleared':
      state.pendingTaskCompletion = undefined;
      return undefined;
    case 'proficiency_updated':
      if (payload.attachment?.kind !== 'proficiency') {
        addGap(
          gaps,
          record,
          payload,
          payload.attachmentMissingReason ?? 'proficiency_attachment_missing',
        );
        return undefined;
      }
      state.proficiencyAssessment = clone(payload.attachment.assessment);
      return undefined;
    case 'tool_call_started':
    case 'tool_call_succeeded':
    case 'tool_call_failed':
      return undefined;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      addGap(gaps, record, payload, 'unhandled_event_kind');
      return undefined;
    }
  }
}

function applyEngagementEvent(
  state: PBLLearnerState,
  payload: PBLEngagementEventRecordPayload,
): void {
  if (!state.engagementEvents.some((event) => event.id === payload.event.id)) {
    state.engagementEvents.push(clone(payload.event));
    if (state.engagementEvents.length > MAX_ENGAGEMENT_EVENTS) {
      state.engagementEvents.splice(0, state.engagementEvents.length - MAX_ENGAGEMENT_EVENTS);
    }
  }
}

function snapshotIsUsable(snapshot: PBLSnapshotRecordPayload, currentEpoch: number): boolean {
  return snapshot.epoch >= currentEpoch;
}

export function foldPBLRuntime({
  designTemplate,
  records,
}: FoldPBLRuntimeArgs): FoldPBLRuntimeResult {
  const baselineProject = stripToDesignTemplate(designTemplate);
  const baseline = extractLearnerState(baselineProject);
  let state = clone(baseline);
  let epoch = state.runtimeResetEpoch ?? 0;
  const gaps: PBLFoldGap[] = [];
  const seen = new Set<string>();

  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    const payload = normalizePayload(record.payload);
    if (!payload) {
      addGap(gaps, record, undefined, 'payload_malformed');
      continue;
    }

    if (payload.kind === 'pbl_snapshot') {
      if (!snapshotIsUsable(payload, epoch)) continue;
      epoch = payload.epoch;
      state = clone(payload.learnerState);
      state.runtimeResetEpoch = payload.epoch === 0 ? state.runtimeResetEpoch : payload.epoch;
      gaps.length = 0;
      if (payload.anchor.lastRuntimeEventId) {
        seen.add(eventKey('runtime', payload.anchor.lastRuntimeEventId));
      }
      if (payload.anchor.lastEngagementEventId) {
        seen.add(eventKey('engagement', payload.anchor.lastEngagementEventId));
      }
      continue;
    }

    if (payload.kind === 'pbl_engagement_event') {
      const key = eventKey('engagement', payload.event.id);
      if (seen.has(key)) continue;
      seen.add(key);
      applyEngagementEvent(state, payload);
      continue;
    }

    const key = eventKey('runtime', payload.event.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const result = applyRuntimeEvent(state, payload, record, gaps);
    if (result === 'reset') {
      const proficiencyAssessment = clone(state.proficiencyAssessment);
      epoch += 1;
      state = clone(baseline);
      state.proficiencyAssessment = proficiencyAssessment;
      state.runtimeResetEpoch = epoch;
      gaps.length = 0;
    }
  }

  // Normalise through the public apply/extract boundary so the result uses the
  // same defaulting rules as hydration.
  const normalized = extractLearnerState(applyLearnerState(baselineProject, state));
  return { learnerState: normalized, diagnostics: { gaps } };
}
