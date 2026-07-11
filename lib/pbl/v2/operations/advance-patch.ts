/**
 * PBL v2 — advance checkpoint transport.
 *
 * `advanceMicrotask()` mutates more than status flags: it records
 * completion evidence, caches engagement summaries, opens the next
 * task, and may complete a milestone. The browser-held project is
 * later sent to /evaluate, so the SSE advance patch must carry this
 * checkpoint across the server/client boundary as one contract.
 */

import type { PBLAdvanceProjectPatch } from '../api/sse';
import { capEngagementEvents } from './engagement';
import type { PBLProjectV2, PBLRuntimeEvent } from '../types';
import {
  appendRuntimeEvent,
  appendStatusChangedRuntimeEvent,
  patchStatusChangedRuntimeEventId,
} from './runtime-events';

export function buildAdvanceProjectPatch(
  project: PBLProjectV2,
  args: {
    readonly microtaskId: string;
    readonly milestoneCompleted: boolean;
    readonly projectCompleted: boolean;
    readonly nextMicrotaskId?: string;
    readonly shouldEvaluateTask: boolean;
    readonly runtimeEventIdsBefore?: ReadonlySet<string>;
  },
): PBLAdvanceProjectPatch {
  const milestone = project.milestones.find((m) =>
    m.microtasks.some((task) => task.id === args.microtaskId),
  );
  const completedMicrotask = milestone?.microtasks.find((task) => task.id === args.microtaskId);
  const nextMicrotask = args.nextMicrotaskId
    ? project.milestones
        .flatMap((m) => m.microtasks)
        .find((task) => task.id === args.nextMicrotaskId)
    : undefined;
  const engagementEvents = project.engagementEvents.filter((event) => {
    if (event.microtaskId === args.microtaskId) return true;
    return (
      event.kind === 'microtask_opened' &&
      args.nextMicrotaskId !== undefined &&
      event.microtaskId === args.nextMicrotaskId
    );
  });
  const runtimeEvents = args.runtimeEventIdsBefore
    ? project.runtimeEvents?.filter((event) => !args.runtimeEventIdsBefore?.has(event.id))
    : undefined;

  return {
    kind: 'advance',
    microtaskId: args.microtaskId,
    milestoneCompleted: args.milestoneCompleted,
    projectCompleted: args.projectCompleted,
    nextMicrotaskId: args.nextMicrotaskId,
    completedMicrotask,
    nextMicrotask,
    milestone,
    engagementEvents,
    runtimeEvents: runtimeEvents?.length ? runtimeEvents : undefined,
    shouldEvaluateTask: args.shouldEvaluateTask,
    // SCENARIO ONLY: role-play projects show NO per-stage milestone reflection
    // card (roleplay beats already skip it; the wrapup auto-complete must not
    // pop one either). The skill report lives entirely on the completion page.
    shouldEvaluateMilestone: args.milestoneCompleted && !project.scenario,
    shouldEvaluateFinal: args.projectCompleted,
  };
}

export function applyAdvanceProjectPatch(
  project: PBLProjectV2,
  patch: PBLAdvanceProjectPatch,
): void {
  // Server-carried runtime events are authoritative: the server observed the
  // advance operation and preserves ordering with sibling facts such as
  // handover_staged. Local emissions below are the compatibility fallback for
  // older patches and use matching deterministic ids so carried echoes collapse.
  if (patch.runtimeEvents?.length) {
    for (const event of patch.runtimeEvents) {
      appendRuntimeEvent(project, event);
    }
  }

  for (const milestone of project.milestones) {
    const appliesMilestoneSnapshot = patch.milestone?.id === milestone.id;
    const milestoneStatusFrom = appliesMilestoneSnapshot ? milestone.status : undefined;
    const microtaskStatusFrom = appliesMilestoneSnapshot
      ? new Map(milestone.microtasks.map((task) => [task.id, task.status] as const))
      : undefined;

    if (patch.milestone?.id === milestone.id) {
      Object.assign(milestone, patch.milestone);
      appendPatchStatusChangedRuntimeEvent(project, {
        entityType: 'milestone',
        entityId: milestone.id,
        from: milestoneStatusFrom ?? milestone.status,
        to: milestone.status,
        milestoneId: milestone.id,
      });
    }
    for (const task of milestone.microtasks) {
      if (patch.completedMicrotask?.id === task.id) {
        const from = microtaskStatusFrom?.get(task.id) ?? task.status;
        Object.assign(task, patch.completedMicrotask);
        appendPatchStatusChangedRuntimeEvent(project, {
          entityType: 'microtask',
          entityId: task.id,
          from,
          to: task.status,
          microtaskId: task.id,
          milestoneId: milestone.id,
        });
      } else if (task.id === patch.microtaskId) {
        const from = microtaskStatusFrom?.get(task.id) ?? task.status;
        task.status = 'completed';
        appendPatchStatusChangedRuntimeEvent(project, {
          entityType: 'microtask',
          entityId: task.id,
          from,
          to: task.status,
          microtaskId: task.id,
          milestoneId: milestone.id,
        });
      }

      if (patch.nextMicrotask?.id === task.id) {
        const from = microtaskStatusFrom?.get(task.id) ?? task.status;
        Object.assign(task, patch.nextMicrotask);
        appendPatchStatusChangedRuntimeEvent(project, {
          entityType: 'microtask',
          entityId: task.id,
          from,
          to: task.status,
          microtaskId: task.id,
          milestoneId: milestone.id,
        });
      } else if (task.id === patch.nextMicrotaskId) {
        const from = microtaskStatusFrom?.get(task.id) ?? task.status;
        task.status = 'in_progress';
        appendPatchStatusChangedRuntimeEvent(project, {
          entityType: 'microtask',
          entityId: task.id,
          from,
          to: task.status,
          microtaskId: task.id,
          milestoneId: milestone.id,
        });
      }
    }

    if (
      patch.milestoneCompleted &&
      milestone.microtasks.length > 0 &&
      milestone.microtasks.some((task) => task.status === 'completed') &&
      milestone.microtasks.every((task) => task.status === 'completed' || task.status === 'skipped')
    ) {
      const from = milestoneStatusFrom ?? milestone.status;
      milestone.status = 'completed';
      appendPatchStatusChangedRuntimeEvent(project, {
        entityType: 'milestone',
        entityId: milestone.id,
        from,
        to: milestone.status,
        milestoneId: milestone.id,
        microtaskId: patch.microtaskId,
      });
    }
  }

  if (patch.engagementEvents?.length) {
    appendUniqueEngagementEvents(project, patch.engagementEvents);
  }

  if (patch.projectCompleted) {
    const from = project.status;
    project.status = 'completed';
    appendPatchStatusChangedRuntimeEvent(project, {
      entityType: 'project',
      entityId: 'project',
      from,
      to: project.status,
      microtaskId: patch.microtaskId,
    });
  }
}

function appendPatchStatusChangedRuntimeEvent(
  project: PBLProjectV2,
  args: {
    entityType: Extract<PBLRuntimeEvent, { kind: 'status_changed' }>['entityType'];
    entityId: string;
    from: string;
    to: string;
    actorType?: PBLRuntimeEvent['actorType'];
    actorRoleId?: string;
    microtaskId?: string;
    milestoneId?: string;
  },
): PBLRuntimeEvent | undefined {
  return appendStatusChangedRuntimeEvent(project, {
    ...args,
    id: patchStatusChangedRuntimeEventId(
      project,
      args.entityType,
      args.entityId,
      args.from,
      args.to,
    ),
  });
}

function appendUniqueEngagementEvents(
  project: PBLProjectV2,
  events: NonNullable<PBLAdvanceProjectPatch['engagementEvents']>,
): void {
  const existingIds = new Set(project.engagementEvents.map((event) => event.id));
  const existingFingerprints = new Set(project.engagementEvents.map(eventFingerprint));

  for (const event of events) {
    const fingerprint = eventFingerprint(event);
    if (existingIds.has(event.id) || existingFingerprints.has(fingerprint)) continue;
    project.engagementEvents.push(event);
    existingIds.add(event.id);
    existingFingerprints.add(fingerprint);
  }
  capEngagementEvents(project);
}

function eventFingerprint(event: PBLProjectV2['engagementEvents'][number]): string {
  return [
    event.kind,
    event.microtaskId ?? '',
    event.milestoneId ?? '',
    event.ts,
    JSON.stringify(event.payload ?? {}),
  ].join('|');
}
