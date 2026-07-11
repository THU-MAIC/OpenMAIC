/**
 * PBL v2 — Apply one SSE event to a working project clone.
 *
 * Pure (no React, no fetch): given an incoming event and a project
 * clone, return the (possibly mutated) clone plus push the token
 * delta into the live draft state setter.
 *
 * Extracted from the hook to keep the streaming loop tight and to
 * allow direct unit testing of patch application logic.
 */

import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';
import { applyAdvanceProjectPatch } from '@/lib/pbl/v2/operations/advance-patch';
import { capEngagementEvents } from '@/lib/pbl/v2/operations/engagement';
import { PBL_SIMULATOR_AGENT_ID } from '@/lib/pbl/v2/operations/progress';
import {
  appendProficiencyUpdatedRuntimeEvent,
  appendRuntimeEvent,
  milestoneIdForMicrotask,
  mintRuntimeEventId,
} from '@/lib/pbl/v2/operations/runtime-events';
import { isStandaloneDividerMessage, stripEmbeddedDividerMarkers } from './protocol-markers';
import type { PBLChatMessage, PBLRuntimeActorType } from '@/lib/pbl/v2/types';

function cleanProtocolMarkersFromMessage<M extends { content: string }>(message: M): M {
  const trimmed = message.content.trimStart();
  if (isStandaloneDividerMessage(trimmed)) {
    return message;
  }
  const cleaned = stripEmbeddedDividerMarkers(message.content);
  if (cleaned === message.content) return message;
  return { ...message, content: cleaned };
}

function actorTypeForMessage(message: PBLChatMessage): PBLRuntimeActorType {
  if (message.roleType === 'user') return 'user';
  if (message.roleType === 'system') return 'system';
  return 'agent';
}

export function applyInstructorEvent(
  event: PBLSSEEvent,
  project: PBLProjectV2,
  setDraft: (fn: (prev: string) => string) => void,
): PBLProjectV2 {
  switch (event.type) {
    case 'token':
      setDraft((prev) => prev + event.delta);
      return project;

    case 'reset_draft':
      // An advancing turn discarded its streamed prose in favour of the
      // isolated wrap-up; drop the live draft so a leaked next-task preview
      // doesn't linger until the wrap-up message patch arrives.
      setDraft(() => '');
      return project;

    case 'project_patch': {
      const next = structuredClone(project);
      const patch = event.patch;
      switch (patch.kind) {
        case 'message': {
          // SCENARIO ONLY routing: simulator-spoken lines and neutral
          // system narration land on the dedicated Simulator thread;
          // everything else (instructor / divider) stays on the
          // Instructor thread exactly as before. Ordinary projects only
          // ever produce instructor/user messages, so this is a no-op
          // for them (the simulator thread never exists).
          const toSimulator =
            patch.message.roleType === 'simulator' || patch.message.roleType === 'system';
          const thread = toSimulator
            ? next.threads.find((t) => t.agentId === PBL_SIMULATOR_AGENT_ID)
            : next.threads.find((t) => {
                const r = next.roles.find((r) => r.id === t.agentId);
                return r?.type === 'instructor';
              });
          const message = cleanProtocolMarkersFromMessage(patch.message);
          if (thread && !thread.messages.some((m) => m.id === message.id) && message.content) {
            thread.messages.push(message);
            const actorType = actorTypeForMessage(message);
            appendRuntimeEvent(next, {
              id: mintRuntimeEventId(),
              kind: 'message_created',
              actorType,
              actorRoleId: actorType === 'agent' ? message.agentId : undefined,
              messageId: message.id,
              threadId: thread.agentId,
              ts: message.ts,
              microtaskId: message.microtaskId,
              milestoneId: milestoneIdForMicrotask(next, message.microtaskId),
            });
          }
          // A message patch is the committed version of the live
          // assistant draft. Clear the draft immediately so the UI
          // never shows the same response as both a saved bubble and
          // an "typing" bubble while follow-up patches arrive.
          setDraft(() => '');
          break;
        }
        case 'engagement_event': {
          const event = patch.event ?? {
            id: 'evt_local_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6),
            kind: patch.eventKind as PBLProjectV2['engagementEvents'][number]['kind'],
            microtaskId: patch.microtaskId,
            milestoneId: patch.milestoneId,
            ts: patch.ts ?? new Date().toISOString(),
            payload: patch.payload,
          };
          if (!next.engagementEvents.some((existing) => existing.id === event.id)) {
            next.engagementEvents.push(event);
            capEngagementEvents(next);
          }
          break;
        }
        case 'advance': {
          applyAdvanceProjectPatch(next, patch);
          break;
        }
        case 'handover': {
          next.pendingHandover = patch.handover;
          appendRuntimeEvent(next, {
            id: mintRuntimeEventId(),
            kind: 'handover_staged',
            actorType: 'system',
            completedMilestoneId: patch.handover.completedMilestoneId,
            nextMilestoneId: patch.handover.nextMilestoneId,
            nextMicrotaskId: patch.handover.nextTaskId,
            ts: new Date().toISOString(),
            milestoneId: patch.handover.completedMilestoneId,
            microtaskId: patch.handover.nextTaskId,
          });
          break;
        }
        case 'evaluation': {
          next.evaluations.push(patch.evaluation);
          appendRuntimeEvent(next, {
            id: mintRuntimeEventId(),
            kind: 'evaluation_created',
            actorType: 'system',
            evaluationId: patch.evaluation.id,
            ts: patch.evaluation.createdAt,
            microtaskId: patch.evaluation.microtaskId,
            milestoneId:
              patch.evaluation.milestoneId ??
              milestoneIdForMicrotask(next, patch.evaluation.microtaskId),
          });
          // Evaluation patches are the committed version of the live
          // evaluator draft. Clear it here for the same reason we
          // clear message drafts above: the learner should not see a
          // streamed preview duplicated under the finished card.
          setDraft(() => '');
          break;
        }
        case 'proficiency': {
          // Adaptive engine state update. Replace the assessment
          // wholesale and mirror the tier onto the legacy
          // `proficiency` field so older consumers (tier-guidance
          // block, dev tooling) stay in sync. The chat does NOT
          // render this — it's only consumed by the dev badge.
          next.proficiencyAssessment = patch.assessment;
          next.proficiency = patch.assessment.tier;
          appendProficiencyUpdatedRuntimeEvent(next);
          break;
        }
      }
      next.updatedAt = new Date().toISOString();
      return next;
    }

    case 'error':
    case 'tool_call':
    case 'done':
    default:
      return project;
  }
}
