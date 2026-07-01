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
import type { PBLProjectV2 } from '../types';

export function buildAdvanceProjectPatch(
  project: PBLProjectV2,
  args: {
    readonly microtaskId: string;
    readonly milestoneCompleted: boolean;
    readonly projectCompleted: boolean;
    readonly nextMicrotaskId?: string;
    readonly shouldEvaluateTask: boolean;
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
  for (const milestone of project.milestones) {
    if (patch.milestone?.id === milestone.id) {
      Object.assign(milestone, patch.milestone);
    }
    for (const task of milestone.microtasks) {
      if (patch.completedMicrotask?.id === task.id) {
        Object.assign(task, patch.completedMicrotask);
      } else if (task.id === patch.microtaskId) {
        task.status = 'completed';
      }

      if (patch.nextMicrotask?.id === task.id) {
        Object.assign(task, patch.nextMicrotask);
      } else if (task.id === patch.nextMicrotaskId) {
        task.status = 'in_progress';
      }
    }

    if (
      patch.milestoneCompleted &&
      milestone.microtasks.length > 0 &&
      milestone.microtasks.some((task) => task.status === 'completed') &&
      milestone.microtasks.every((task) => task.status === 'completed' || task.status === 'skipped')
    ) {
      milestone.status = 'completed';
    }
  }

  if (patch.engagementEvents?.length) {
    appendUniqueEngagementEvents(project, patch.engagementEvents);
  }

  if (patch.projectCompleted) {
    project.status = 'completed';
  }
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
