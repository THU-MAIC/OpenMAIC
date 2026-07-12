import type { PBLProjectV2, PBLRuntimeActorType, PBLRuntimeEvent, PBLUiPhase } from '../types';

export const MAX_RUNTIME_EVENTS = 500;

export function mintRuntimeEventId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function appendRuntimeEvent(project: PBLProjectV2, event: PBLRuntimeEvent): PBLRuntimeEvent {
  project.runtimeEvents ??= [];
  const existing = project.runtimeEvents.find((candidate) => candidate.id === event.id);
  if (existing) {
    capRuntimeEvents(project);
    return existing;
  }
  project.runtimeEvents.push(event);
  capRuntimeEvents(project);
  return event;
}

function capRuntimeEvents(project: PBLProjectV2): void {
  if (!project.runtimeEvents) return;
  if (project.runtimeEvents.length > MAX_RUNTIME_EVENTS) {
    project.runtimeEvents.splice(0, project.runtimeEvents.length - MAX_RUNTIME_EVENTS);
  }
}

export function runtimeEventEpoch(project: PBLProjectV2): number {
  return project.runtimeResetEpoch ?? 0;
}

export function milestoneIdForMicrotask(
  project: PBLProjectV2,
  microtaskId: string | undefined,
): string | undefined {
  if (!microtaskId) return undefined;
  return project.milestones.find((milestone) =>
    milestone.microtasks.some((microtask) => microtask.id === microtaskId),
  )?.id;
}

export function normalizationRepairEventId(
  project: PBLProjectV2,
  entityType: 'project' | 'milestone' | 'microtask' | 'ui_phase',
  entityId: string,
  from: string,
  to: string,
): string {
  return `norm:${runtimeEventEpoch(project)}:${entityType}:${entityId}:${from}:${to}`;
}

export function patchStatusChangedRuntimeEventId(
  project: PBLProjectV2,
  entityType: Extract<PBLRuntimeEvent, { kind: 'status_changed' }>['entityType'],
  entityId: string,
  from: string,
  to: string,
): string {
  return `patch:${runtimeEventEpoch(project)}:${entityType}:${entityId}:${from}:${to}`;
}

export function appendStatusChangedRuntimeEvent(
  project: PBLProjectV2,
  args: {
    entityType: Extract<PBLRuntimeEvent, { kind: 'status_changed' }>['entityType'];
    entityId: string;
    from: string;
    to: string;
    actorType?: PBLRuntimeActorType;
    actorRoleId?: string;
    microtaskId?: string;
    milestoneId?: string;
    id?: string;
  },
): PBLRuntimeEvent | undefined {
  if (args.from === args.to) return undefined;
  return appendRuntimeEvent(project, {
    id: args.id ?? mintRuntimeEventId(),
    kind: 'status_changed',
    actorType: args.actorType ?? 'system',
    actorRoleId: args.actorRoleId,
    entityType: args.entityType,
    entityId: args.entityId,
    from: args.from,
    to: args.to,
    ts: new Date().toISOString(),
    microtaskId: args.microtaskId,
    milestoneId: args.milestoneId,
  });
}

export function appendProficiencyUpdatedRuntimeEvent(
  project: PBLProjectV2,
): PBLRuntimeEvent | undefined {
  const assessment = project.proficiencyAssessment;
  if (!assessment) return undefined;
  return appendRuntimeEvent(project, {
    id: mintRuntimeEventId(),
    kind: 'proficiency_updated',
    actorType: 'system',
    tier: assessment.tier,
    score: assessment.score,
    confidence: assessment.confidence,
    ts: new Date().toISOString(),
  });
}

export function transitionProjectUiPhase(project: PBLProjectV2, uiPhase: PBLUiPhase): PBLProjectV2 {
  const next: PBLProjectV2 = {
    ...project,
    runtimeEvents: project.runtimeEvents ? [...project.runtimeEvents] : undefined,
    uiPhase,
  };
  appendStatusChangedRuntimeEvent(next, {
    actorType: 'user',
    entityType: 'ui_phase',
    entityId: 'project',
    from: project.uiPhase,
    to: uiPhase,
  });
  return next;
}
