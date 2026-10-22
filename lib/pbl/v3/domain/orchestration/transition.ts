import { isExplorationStage } from '../project/project-schema';
import type {
  CourseReleaseDescriptor,
  ProjectDefinition,
  StudentAction,
} from '../project/project-schema';
import { recordDecision } from './decisions';
import type { EngineTransition, OrchestrationEvent } from './events';
import { createRemediationHint } from './remediation';
import {
  createCollectedMilestoneState,
  createPblSessionState,
  currentMilestone,
  currentStage,
} from './state';
import type {
  ArtifactRecord,
  CourseLifecycleStatus,
  EvaluationResult,
  PblSessionState,
  QuizAttempt,
} from './types';

export class InvalidEngineTransitionError extends Error {
  constructor(
    message: string,
    readonly code = 'INVALID_ENGINE_TRANSITION',
  ) {
    super(message);
    this.name = 'InvalidEngineTransitionError';
  }
}

function updateMilestone(
  state: PblSessionState,
  milestoneIndex: number,
  update: (
    milestone: PblSessionState['milestones'][number],
  ) => PblSessionState['milestones'][number],
): PblSessionState {
  return {
    ...state,
    milestones: state.milestones.map((milestone, index) =>
      index === milestoneIndex ? update(milestone) : milestone,
    ),
  };
}

function appendSequence(
  state: PblSessionState,
  events: readonly OrchestrationEvent[],
): PblSessionState {
  return { ...state, lastSequence: state.lastSequence + events.length };
}

export function startOrchestration(
  project: ProjectDefinition,
  createdState?: PblSessionState,
): EngineTransition {
  const initial = createdState ?? createPblSessionState(project);
  if (initial.status !== 'created') {
    throw new InvalidEngineTransitionError('only a created Session can start orchestration');
  }
  const milestone = project.milestones[0];
  if (!milestone)
    return {
      state: {
        ...initial,
        status: 'completed',
        completionRevision: (initial.completionRevision ?? 0) + 1,
      },
      events: [{ type: 'session.completed' }],
    };
  const stage = milestone.stages[0];
  const events: OrchestrationEvent[] = [
    { type: 'session.started', projectId: project.id },
    { type: 'intro.completed' },
    {
      type: 'milestone.entered',
      milestoneId: milestone.id,
      milestoneIndex: 0,
      title: milestone.title,
    },
    ...(stage
      ? [
          {
            type: 'stage.entered',
            milestoneId: milestone.id,
            stageIndex: 0,
            stageKind: stage.kind,
          } as const,
        ]
      : []),
  ];
  let state: PblSessionState = {
    ...initial,
    // Introduction is delivered inside the first teaching step; retain this legacy flag
    // for persisted-session compatibility, without a separate confirmation gate.
    introCompleted: true,
    status:
      stage?.kind === 'dialogue' || stage?.kind === 'produce' ? 'waiting_for_student' : 'running',
    position: { milestoneIndex: 0, milestoneId: milestone.id, stageIndex: stage ? 0 : -1 },
  };
  state = updateMilestone(state, 0, (progress) => ({
    ...progress,
    status: 'active',
    stageIndex: stage ? 0 : -1,
  }));
  return { state: appendSequence(state, events), events };
}

export function recordCourseLifecycle(
  project: ProjectDefinition,
  state: PblSessionState,
  input: {
    courseId: string;
    releaseId: string;
    status: CourseLifecycleStatus;
    occurredAt: string;
    errorCode?: string;
  },
): EngineTransition {
  const stage = currentStage(project, state);
  const current = state.courses?.[input.courseId];
  if (stage?.kind !== 'course' || stage.courseId !== input.courseId || !current) {
    throw new InvalidEngineTransitionError(
      `course ${input.courseId} is not active`,
      'COURSE_NOT_ACTIVE',
    );
  }
  if (current.release.releaseId !== input.releaseId) {
    throw new InvalidEngineTransitionError(
      `course ${input.courseId} release does not match the Session release`,
      'COURSE_RELEASE_MISMATCH',
    );
  }
  if (!courseLifecycleTransitionAllowed(current.status, input.status)) {
    throw new InvalidEngineTransitionError(
      `course lifecycle cannot move from ${current.status} to ${input.status}`,
      'COURSE_LIFECYCLE_CONFLICT',
    );
  }
  if (input.status === 'error' && !input.errorCode) {
    throw new InvalidEngineTransitionError(
      'course error lifecycle requires an error code',
      'COURSE_ERROR_CODE_REQUIRED',
    );
  }
  const event: OrchestrationEvent = {
    type: 'course.lifecycle.recorded',
    courseId: input.courseId,
    release: {
      releaseId: current.release.releaseId,
      version: current.release.version,
      formatVersion: current.release.formatVersion,
    },
    status: input.status,
    occurredAt: input.occurredAt,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  };
  const { errorCode: _previousError, ...currentWithoutError } = current;
  const next = {
    ...currentWithoutError,
    status: input.status,
    updatedAt: input.occurredAt,
    ...(input.status === 'ready' ? { readyAt: input.occurredAt } : {}),
    ...(input.status === 'completed' ? { completedAt: input.occurredAt } : {}),
    ...(input.status === 'error' ? { errorCode: input.errorCode! } : {}),
  };
  return {
    state: appendSequence(
      { ...state, courses: { ...(state.courses ?? {}), [input.courseId]: next } },
      [event],
    ),
    events: [event],
  };
}

/**
 * Moves only the active embedded course onto the centrally selected immutable
 * release. Project workspaces and every milestone's collected state are carried
 * through byte-for-byte; the course-local progress is intentionally restarted
 * because scene identities belong to the archive version being replaced.
 */
export function updateActiveCourseRelease(
  project: ProjectDefinition,
  state: PblSessionState,
  release: CourseReleaseDescriptor,
  occurredAt: string,
): EngineTransition {
  const stage = currentStage(project, state);
  const current = state.courses?.[release.courseId];
  if (stage?.kind !== 'course' || stage.courseId !== release.courseId || !current) {
    throw new InvalidEngineTransitionError(
      `course ${release.courseId} is not active`,
      'COURSE_NOT_ACTIVE',
    );
  }
  if (current.release.releaseId === release.releaseId) {
    const unchanged =
      current.release.courseId === release.courseId &&
      current.release.version === release.version &&
      current.release.objectKey === release.objectKey &&
      current.release.sha256 === release.sha256 &&
      current.release.sizeBytes === release.sizeBytes &&
      current.release.formatVersion === release.formatVersion;
    if (!unchanged) {
      throw new InvalidEngineTransitionError(
        `course ${release.courseId} release ${release.releaseId} was redefined`,
        'COURSE_RELEASE_IMMUTABLE_MISMATCH',
      );
    }
    return { state, events: [] };
  }
  const next = {
    courseId: current.courseId,
    milestoneId: current.milestoneId,
    stageIndex: current.stageIndex,
    release,
    status: 'preparing' as const,
    updatedAt: occurredAt,
  };
  const event: OrchestrationEvent = {
    type: 'course.lifecycle.recorded',
    courseId: release.courseId,
    release: {
      releaseId: release.releaseId,
      version: release.version,
      formatVersion: release.formatVersion,
    },
    status: 'preparing',
    occurredAt,
  };
  return {
    state: appendSequence(
      { ...state, courses: { ...(state.courses ?? {}), [release.courseId]: next } },
      [event],
    ),
    events: [event],
  };
}

export function activateAgent(
  state: PblSessionState,
  role: NonNullable<PblSessionState['position']['activeAgent']>,
  agentId: string,
): EngineTransition {
  const event: OrchestrationEvent = { type: 'agent.activated', role, agentId };
  return {
    state: appendSequence(
      { ...state, position: { ...state.position, activeAgent: role, activeAgentId: agentId } },
      [event],
    ),
    events: [event],
  };
}

export function completeIntro(state: PblSessionState): EngineTransition {
  if (state.introCompleted)
    throw new InvalidEngineTransitionError('project introduction is already completed');
  const event: OrchestrationEvent = { type: 'intro.completed' };
  return { state: appendSequence({ ...state, introCompleted: true }, [event]), events: [event] };
}

export function completeTeaching(
  project: ProjectDefinition,
  state: PblSessionState,
): EngineTransition {
  const milestone = currentMilestone(project, state);
  const stage = currentStage(project, state);
  const collected = milestone === undefined ? undefined : state.collected[milestone.id];
  if (!milestone || stage?.kind !== 'mentor_say' || stage.agent !== 'discussion' || !collected) {
    throw new InvalidEngineTransitionError('discussion teaching is not active');
  }
  if (collected.teachingCompleted) return { state, events: [] };
  const event: OrchestrationEvent = { type: 'teaching.completed', milestoneId: milestone.id };
  return {
    state: appendSequence(
      {
        ...state,
        collected: {
          ...state.collected,
          [milestone.id]: { ...collected, teachingCompleted: true },
        },
      },
      [event],
    ),
    events: [event],
  };
}

/** A guided recap has its own approval; Discussion completion cannot approve it. */
export function completeRecap(
  project: ProjectDefinition,
  state: PblSessionState,
): EngineTransition {
  const milestone = currentMilestone(project, state);
  const stage = currentStage(project, state);
  const collected = milestone === undefined ? undefined : state.collected[milestone.id];
  if (
    !milestone ||
    stage?.kind !== 'mentor_say' ||
    stage.agent !== 'mentor' ||
    !stage.skill ||
    !collected
  ) {
    throw new InvalidEngineTransitionError('guided mentor recap is not active');
  }
  if (collected.recapCompleted) return { state, events: [] };
  const event: OrchestrationEvent = { type: 'recap.completed', milestoneId: milestone.id };
  return {
    state: appendSequence(
      {
        ...state,
        collected: { ...state.collected, [milestone.id]: { ...collected, recapCompleted: true } },
      },
      [event],
    ),
    events: [event],
  };
}

export function completeArtifactReview(
  project: ProjectDefinition,
  state: PblSessionState,
  artifactKind: 'plan' | 'code',
): EngineTransition {
  const milestone = currentMilestone(project, state);
  const stage = currentStage(project, state);
  const collected = milestone === undefined ? undefined : state.collected[milestone.id];
  if (
    !milestone ||
    stage?.kind !== 'produce' ||
    !stage.reviewRequired ||
    stage.writes !== artifactKind ||
    !collected?.[artifactKind]
  ) {
    throw new InvalidEngineTransitionError(`${artifactKind} review is not active`);
  }
  const reviewField = artifactKind === 'plan' ? 'planReviewCompleted' : 'codeReviewCompleted';
  if (collected[reviewField]) return { state, events: [] };
  const event: OrchestrationEvent = {
    type: 'artifact.review.completed',
    milestoneId: milestone.id,
    artifactKind,
  };
  return {
    state: appendSequence(
      {
        ...state,
        collected: {
          ...state.collected,
          [milestone.id]: { ...collected, [reviewField]: true },
        },
      },
      [event],
    ),
    events: [event],
  };
}

export function submitDecision(
  project: ProjectDefinition,
  state: PblSessionState,
  input: { decisionId: string; chosen: string; recordId: string },
): EngineTransition {
  const milestone = currentMilestone(project, state);
  const stage = currentStage(project, state);
  if (!milestone || stage?.kind !== 'dialogue' || !milestone.decisions.includes(input.decisionId)) {
    throw new InvalidEngineTransitionError(
      `decision ${input.decisionId} is not allowed in the current stage`,
    );
  }
  const collected = state.collected[milestone.id];
  if (!collected)
    throw new InvalidEngineTransitionError(`missing collected state for ${milestone.id}`);
  const nextProgress = recordDecision(
    { decisions: collected.decisions },
    input.decisionId,
    input.chosen,
  );
  const decision = nextProgress.decisions.find((candidate) => candidate.id === input.decisionId)!;
  const event: OrchestrationEvent = {
    type: 'decision.recorded',
    milestoneId: milestone.id,
    decisionId: input.decisionId,
    recordId: input.recordId,
    chosen: decision.chosen,
    revision: decision.revision,
  };
  const nextState: PblSessionState = {
    ...state,
    collected: {
      ...state.collected,
      [milestone.id]: {
        ...collected,
        decisions: [...nextProgress.decisions],
        decisionRecordIds: { ...collected.decisionRecordIds, [input.decisionId]: input.recordId },
      },
    },
    decisionRevisions: { ...state.decisionRevisions, [input.decisionId]: decision.revision },
  };
  return { state: appendSequence(nextState, [event]), events: [event] };
}

export function recordArtifact(
  project: ProjectDefinition,
  state: PblSessionState,
  artifact: ArtifactRecord,
  options: {
    allowPlanFileUpdate?: boolean;
    preserveReview?: boolean;
    /** What this version consisted of. Recorded on the event only — state keeps just the hash. */
    evidence?: {
      content?: string | undefined;
      changedPaths?: readonly string[] | undefined;
      changes?: string | undefined;
    };
  } = {},
): EngineTransition {
  const milestone = currentMilestone(project, state);
  const stage = currentStage(project, state);
  const isProducedArtifact = stage?.kind === 'produce' && stage.writes === artifact.kind;
  const isCoderRepair =
    stage?.kind === 'check' &&
    stage.checker === 'tests' &&
    artifact.kind === 'code' &&
    state.collected[milestone?.id ?? '']?.remediation?.target === 'coder';
  const isPlanFileUpdate = artifact.kind === 'plan' && options.allowPlanFileUpdate === true;
  if (
    !milestone ||
    (!isProducedArtifact && !isCoderRepair && !isPlanFileUpdate) ||
    artifact.milestoneId !== milestone.id
  ) {
    throw new InvalidEngineTransitionError(
      `artifact ${artifact.kind} is not allowed in the current stage`,
    );
  }
  const collected = state.collected[milestone.id]!;
  const event: OrchestrationEvent = {
    type: 'artifact.recorded',
    artifact,
    ...clip(options.evidence?.content),
    ...(options.evidence?.changedPaths?.length
      ? { changedPaths: [...options.evidence.changedPaths] }
      : {}),
    ...(options.evidence?.changes ? { changes: clipped(options.evidence.changes) } : {}),
  };
  const reviewField = artifact.kind === 'plan' ? 'planReviewCompleted' : 'codeReviewCompleted';
  const nextState = {
    ...state,
    collected: {
      ...state.collected,
      [milestone.id]: {
        ...collected,
        ...(collected.recapCompleted === undefined ? {} : { recapCompleted: false }),
        [artifact.kind]: artifact,
        [reviewField]: options.preserveReview === true ? collected[reviewField] : false,
      },
    },
  };
  return { state: appendSequence(nextState, [event]), events: [event] };
}

/**
 * A plan long enough to hit this is already longer than anything a report will quote, and the tail
 * of it would ride in every replay of the session for the rest of its life.
 */
const ARTIFACT_CONTENT_LIMIT = 12_000;

function clip(content: string | undefined): { content?: string } {
  if (content === undefined || content.length === 0) return {};
  return { content: clipped(content) };
}

/** Second guard behind the one the writer already applies, because this event is kept forever. */
function clipped(content: string): string {
  return content.length <= ARTIFACT_CONTENT_LIMIT
    ? content
    : `${content.slice(0, ARTIFACT_CONTENT_LIMIT)}\n…（后略）`;
}

export function recordEvaluation(
  project: ProjectDefinition,
  state: PblSessionState,
  evaluation: EvaluationResult,
  ids: { remediationId: string },
): EngineTransition {
  const milestone = currentMilestone(project, state);
  const stage = currentStage(project, state);
  if (
    !milestone ||
    stage?.kind !== 'check' ||
    stage.checker !== 'tests' ||
    evaluation.milestoneId !== milestone.id
  ) {
    throw new InvalidEngineTransitionError('test evaluation is not allowed in the current stage');
  }
  const collected = state.collected[milestone.id]!;
  const attempt = (collected.remediation?.attempt ?? 0) + 1;
  const remediation =
    evaluation.status === 'failed'
      ? createRemediationHint(evaluation, { id: ids.remediationId, attempt })
      : null;
  const completedEvaluation = remediation ? { ...evaluation, remediation } : evaluation;
  const events: OrchestrationEvent[] = [
    { type: 'evaluation.recorded', evaluation: completedEvaluation },
    ...(remediation ? [{ type: 'remediation.entered', remediation } as const] : []),
  ];
  let nextState: PblSessionState = {
    ...state,
    status: remediation ? 'waiting_for_student' : state.status,
    collected: {
      ...state.collected,
      [milestone.id]: { ...collected, tests: completedEvaluation, remediation },
    },
  };
  nextState = updateMilestone(nextState, state.position.milestoneIndex, (progress) => ({
    ...progress,
    evaluationIds: [...progress.evaluationIds, evaluation.id],
  }));
  return { state: appendSequence(nextState, events), events };
}

export function recordQuiz(
  project: ProjectDefinition,
  state: PblSessionState,
  quiz: QuizAttempt,
): EngineTransition {
  const milestone = currentMilestone(project, state);
  const stage = currentStage(project, state);
  if (!milestone || stage?.kind !== 'check' || stage.checker !== 'quiz') {
    throw new InvalidEngineTransitionError('quiz result is not allowed in the current stage');
  }
  const event: OrchestrationEvent = { type: 'quiz.recorded', milestoneId: milestone.id, quiz };
  const collected = state.collected[milestone.id]!;
  const nextState = {
    ...state,
    status: quiz.passed ? state.status : ('waiting_for_student' as const),
    collected: { ...state.collected, [milestone.id]: { ...collected, quiz } },
  };
  return { state: appendSequence(nextState, [event]), events: [event] };
}

export function completeCurrentStage(
  project: ProjectDefinition,
  state: PblSessionState,
): EngineTransition {
  return advanceCurrentStage(project, state, false);
}

function advanceCurrentStage(
  project: ProjectDefinition,
  state: PblSessionState,
  skipRecap: boolean,
): EngineTransition {
  if (!state.introCompleted)
    throw new InvalidEngineTransitionError(
      'project introduction must be completed before advancing stages',
    );
  const milestone = currentMilestone(project, state);
  const stage = currentStage(project, state);
  if (!milestone || !stage) throw new InvalidEngineTransitionError('there is no active stage');
  const progress = state.milestones[state.position.milestoneIndex];
  const nextMilestoneAfterCompletedBoundary = project.milestones[state.position.milestoneIndex + 1];
  if (
    progress?.status === 'completed' &&
    progress.completedStageIndexes.includes(state.position.stageIndex) &&
    nextMilestoneAfterCompletedBoundary
  ) {
    const nextMilestoneIndex = state.position.milestoneIndex + 1;
    const existingNextProgress = state.milestones[nextMilestoneIndex];
    if (
      existingNextProgress &&
      existingNextProgress.milestoneId !== nextMilestoneAfterCompletedBoundary.id
    ) {
      throw new InvalidEngineTransitionError(
        'current Project Release does not preserve the existing milestone prefix',
        'PROJECT_RELEASE_MILESTONE_PREFIX_MISMATCH',
      );
    }
    if (!existingNextProgress && state.milestones.length !== nextMilestoneIndex) {
      throw new InvalidEngineTransitionError(
        'current Project Release is missing more than its direct successor milestone',
        'PROJECT_RELEASE_MILESTONE_PREFIX_MISMATCH',
      );
    }
    if (!existingNextProgress && state.projectDefinitionRevision !== project.definitionRevision) {
      throw new InvalidEngineTransitionError(
        'Session must migrate before entering a successor from a different project definition',
        'PROJECT_RELEASE_MILESTONE_PREFIX_MISMATCH',
      );
    }
    // Early rollout builds could pin the appended Project Release before its progress row was
    // materialized. The Runtime already has the authoritative current definition in this branch,
    // so repair that single direct-successor slot without running another release migration.
    const boundaryState = existingNextProgress
      ? state
      : {
          ...state,
          milestones: [
            ...state.milestones,
            {
              milestoneId: nextMilestoneAfterCompletedBoundary.id,
              status: 'pending' as const,
              stageIndex: -1,
              completedStageIndexes: [],
              evaluationIds: [],
            },
          ],
          collected: {
            ...state.collected,
            [nextMilestoneAfterCompletedBoundary.id]:
              state.collected[nextMilestoneAfterCompletedBoundary.id] ??
              createCollectedMilestoneState(),
          },
        };
    const firstStage = nextMilestoneAfterCompletedBoundary.stages[0];
    const events: OrchestrationEvent[] = [
      {
        type: 'milestone.entered',
        milestoneId: nextMilestoneAfterCompletedBoundary.id,
        milestoneIndex: state.position.milestoneIndex + 1,
        title: nextMilestoneAfterCompletedBoundary.title,
      },
      ...(firstStage
        ? [
            {
              type: 'stage.entered',
              milestoneId: nextMilestoneAfterCompletedBoundary.id,
              stageIndex: 0,
              stageKind: firstStage.kind,
            } as const,
          ]
        : []),
    ];
    const nextState = updateMilestone(
      {
        ...boundaryState,
        status:
          firstStage?.kind === 'dialogue' || firstStage?.kind === 'produce'
            ? 'waiting_for_student'
            : 'running',
        position: {
          milestoneIndex: nextMilestoneIndex,
          milestoneId: nextMilestoneAfterCompletedBoundary.id,
          stageIndex: firstStage ? 0 : -1,
        },
      },
      nextMilestoneIndex,
      (nextProgress) => ({
        ...nextProgress,
        status: 'active',
        stageIndex: firstStage ? 0 : -1,
      }),
    );
    return { state: appendSequence(nextState, events), events };
  }
  const collected = state.collected[milestone.id]!;
  if (stage.kind === 'mentor_say' && stage.agent === 'discussion' && !collected.teachingCompleted) {
    throw new InvalidEngineTransitionError(
      'discussion teaching must be completed before entering decision discussion',
    );
  }
  if (
    stage.kind === 'mentor_say' &&
    stage.agent === 'mentor' &&
    stage.skill &&
    !collected.recapCompleted &&
    !skipRecap
  ) {
    throw new InvalidEngineTransitionError('guided recap must be confirmed before advancing');
  }
  if (
    stage.kind === 'dialogue' &&
    !milestone.decisions.every((id) => collected.decisions.some((decision) => decision.id === id))
  ) {
    throw new InvalidEngineTransitionError(
      'all milestone decisions must be submitted before advancing',
    );
  }
  if (isExplorationStage(stage))
    throw new InvalidEngineTransitionError(
      'exploration stays open; viewing a report is navigation',
      'EXPLORATION_STAYS_OPEN',
    );
  if (stage.kind === 'produce' && !collected[stage.writes])
    throw new InvalidEngineTransitionError(`${stage.writes} must be recorded before advancing`);
  if (
    stage.kind === 'produce' &&
    stage.reviewRequired &&
    stage.writes === 'plan' &&
    !collected.planReviewCompleted
  ) {
    throw new InvalidEngineTransitionError('plan review must be completed before coding');
  }
  if (
    stage.kind === 'produce' &&
    stage.reviewRequired &&
    stage.writes === 'code' &&
    !collected.codeReviewCompleted
  ) {
    throw new InvalidEngineTransitionError('code review must be completed before testing');
  }
  if (stage.kind === 'check' && stage.checker === 'tests' && collected.tests?.status !== 'passed')
    throw new InvalidEngineTransitionError('tests must pass before advancing');
  if (stage.kind === 'check' && stage.checker === 'quiz' && collected.quiz?.passed !== true)
    throw new InvalidEngineTransitionError('quiz must pass before advancing');
  if (stage.kind === 'course' && state.courses?.[stage.courseId]?.status !== 'completed') {
    throw new InvalidEngineTransitionError(
      'course must be completed before advancing',
      'COURSE_NOT_COMPLETED',
    );
  }
  const isCurrentReleaseBoundary =
    state.position.milestoneIndex === project.milestones.length - 1 &&
    state.position.stageIndex === milestone.stages.length - 1;
  if (isCurrentReleaseBoundary && project.completionMode === 'awaiting_more_milestones') {
    throw new InvalidEngineTransitionError(
      'the current Project Release is awaiting more milestones',
      'PROJECT_RELEASE_AWAITS_MORE_MILESTONES',
    );
  }

  const stageCompleted: OrchestrationEvent = skipRecap
    ? {
        type: 'stage.skipped',
        milestoneId: milestone.id,
        stageIndex: state.position.stageIndex,
        reason: 'project_release_upgrade',
      }
    : { type: 'stage.completed', milestoneId: milestone.id, stageIndex: state.position.stageIndex };
  const nextStageIndex = state.position.stageIndex + 1;
  const nextStage = milestone.stages[nextStageIndex];
  let events: OrchestrationEvent[] = [stageCompleted];
  let nextState = updateMilestone(state, state.position.milestoneIndex, (progress) => ({
    ...progress,
    ...(skipRecap
      ? {
          skippedStageIndexes: [
            ...new Set([...(progress.skippedStageIndexes ?? []), state.position.stageIndex]),
          ],
        }
      : {}),
    completedStageIndexes:
      skipRecap || progress.completedStageIndexes.includes(state.position.stageIndex)
        ? progress.completedStageIndexes
        : [...progress.completedStageIndexes, state.position.stageIndex],
  }));

  if (nextStage) {
    events = [
      ...events,
      {
        type: 'stage.entered',
        milestoneId: milestone.id,
        stageIndex: nextStageIndex,
        stageKind: nextStage.kind,
      },
    ];
    nextState = updateMilestone(
      {
        ...nextState,
        status:
          nextStage.kind === 'dialogue' || nextStage.kind === 'produce'
            ? 'waiting_for_student'
            : 'running',
        position: {
          milestoneIndex: state.position.milestoneIndex,
          milestoneId: milestone.id,
          stageIndex: nextStageIndex,
        },
      },
      state.position.milestoneIndex,
      (progress) => ({ ...progress, stageIndex: nextStageIndex }),
    );
    return { state: appendSequence(nextState, events), events };
  }

  const milestoneCompleted: OrchestrationEvent = {
    type: 'milestone.completed',
    milestoneId: milestone.id,
    milestoneIndex: state.position.milestoneIndex,
  };
  events = [...events, milestoneCompleted];
  nextState = updateMilestone(nextState, state.position.milestoneIndex, (progress) => ({
    ...progress,
    status: 'completed',
  }));
  const nextMilestoneIndex = state.position.milestoneIndex + 1;
  const nextMilestone = project.milestones[nextMilestoneIndex];
  if (!nextMilestone) {
    events = [...events, { type: 'session.completed' }];
    nextState = {
      ...nextState,
      status: 'completed',
      completionRevision: (state.completionRevision ?? 0) + 1,
      position: clearActiveAgent({
        milestoneIndex: state.position.milestoneIndex,
        milestoneId: milestone.id,
        stageIndex: state.position.stageIndex,
      }),
    };
    return { state: appendSequence(nextState, events), events };
  }
  const firstStage = nextMilestone.stages[0];
  events = [
    ...events,
    {
      type: 'milestone.entered',
      milestoneId: nextMilestone.id,
      milestoneIndex: nextMilestoneIndex,
      title: nextMilestone.title,
    },
    ...(firstStage
      ? [
          {
            type: 'stage.entered',
            milestoneId: nextMilestone.id,
            stageIndex: 0,
            stageKind: firstStage.kind,
          } as const,
        ]
      : []),
  ];
  nextState = updateMilestone(
    {
      ...nextState,
      status:
        firstStage?.kind === 'dialogue' || firstStage?.kind === 'produce'
          ? 'waiting_for_student'
          : 'running',
      position: {
        milestoneIndex: nextMilestoneIndex,
        milestoneId: nextMilestone.id,
        stageIndex: firstStage ? 0 : -1,
      },
    },
    nextMilestoneIndex,
    (progress) => ({ ...progress, status: 'active', stageIndex: firstStage ? 0 : -1 }),
  );
  return { state: appendSequence(nextState, events), events };
}

export function failOrchestration(state: PblSessionState, reason: string): EngineTransition {
  const event: OrchestrationEvent = { type: 'session.failed', reason };
  return {
    state: appendSequence(
      { ...state, status: 'failed', position: clearActiveAgent(state.position) },
      [event],
    ),
    events: [event],
  };
}

export function markStatePersisted(state: PblSessionState): EngineTransition {
  const event: OrchestrationEvent = {
    type: 'state.persisted',
    milestoneId: state.position.milestoneId ?? 'completed',
    stageIndex: state.position.stageIndex,
  };
  return { state: appendSequence(state, [event]), events: [event] };
}

export function releaseMilestoneAgents(
  state: PblSessionState,
  milestoneId: string,
  agentIds: string[],
): EngineTransition {
  const event: OrchestrationEvent = { type: 'milestone.agents.released', milestoneId, agentIds };
  const nextState = agentIds.includes(state.position.activeAgentId ?? '')
    ? { ...state, position: clearActiveAgent(state.position) }
    : state;
  return { state: appendSequence(nextState, [event]), events: [event] };
}

export function allowedStudentActions(
  project: ProjectDefinition,
  state: PblSessionState,
): readonly StudentAction[] {
  if (!state.introCompleted) return ['chat', 'next'];
  const progress = state.milestones[state.position.milestoneIndex];
  if (progress?.status === 'completed' && project.milestones[state.position.milestoneIndex + 1]) {
    // An appended release reopens a formerly final Session at its completed recap. The old stage
    // contract must not be re-run or edited; the learner has exactly one meaningful action here:
    // explicitly enter the newly available next milestone.
    return ['next'];
  }
  const stage = currentStage(project, state);
  if (!stage) return [];
  const isCurrentReleaseBoundary =
    state.position.milestoneIndex === project.milestones.length - 1 &&
    state.position.stageIndex === (project.milestones.at(-1)?.stages.length ?? 0) - 1;
  if (stage.kind === 'mentor_say' || stage.kind === 'dialogue' || stage.kind === 'produce') {
    const collected = state.collected[state.position.milestoneId ?? ''];
    if (
      stage.kind === 'dialogue' &&
      !currentMilestone(project, state)!.decisions.every((id) =>
        collected?.decisions.some((decision) => decision.id === id),
      )
    )
      return stage.studentActions.filter((action) => action !== 'next');
    if (
      stage.kind === 'mentor_say' &&
      stage.agent === 'discussion' &&
      !collected?.teachingCompleted
    ) {
      return stage.studentActions.filter((action) => action !== 'next');
    }
    if (
      stage.kind === 'mentor_say' &&
      stage.agent === 'mentor' &&
      stage.skill &&
      !collected?.recapCompleted
    ) {
      return stage.studentActions.filter((action) => action !== 'next');
    }
    if (stage.kind === 'produce' && stage.reviewRequired) {
      const reviewCompleted =
        stage.writes === 'plan' ? collected?.planReviewCompleted : collected?.codeReviewCompleted;
      if (!reviewCompleted) return stage.studentActions.filter((action) => action !== 'next');
    }
    return isCurrentReleaseBoundary && project.completionMode === 'awaiting_more_milestones'
      ? stage.studentActions.filter((action) => action !== 'next')
      : stage.studentActions;
  }
  if (
    stage.kind === 'check' &&
    stage.checker === 'tests' &&
    state.collected[state.position.milestoneId ?? '']?.remediation?.target === 'coder'
  ) {
    return [
      'chat',
      'edit',
      'create',
      'delete',
      'rename',
      'move',
      'restore',
      'evaluate',
      ...(state.collected[state.position.milestoneId ?? '']?.tests?.status === 'passed'
        ? ['next' as const]
        : []),
    ];
  }
  if (stage.kind === 'check' && stage.checker === 'tests') {
    return [
      'evaluate',
      ...(state.collected[state.position.milestoneId ?? '']?.tests?.status === 'passed'
        ? ['next' as const]
        : []),
    ];
  }
  if (stage.kind === 'check' && stage.checker === 'quiz') {
    return [
      'quiz',
      ...(state.collected[state.position.milestoneId ?? '']?.quiz?.passed === true
        ? ['next' as const]
        : []),
    ];
  }
  if (stage.kind === 'course')
    return state.courses?.[stage.courseId]?.status === 'completed' ? ['next'] : [];
  return [];
}

function courseLifecycleTransitionAllowed(
  current: CourseLifecycleStatus,
  next: CourseLifecycleStatus,
): boolean {
  if (current === next) return true;
  if (current === 'pending') return next === 'preparing';
  if (current === 'preparing') return next === 'ready' || next === 'error';
  if (current === 'ready') return next === 'completed' || next === 'error';
  if (current === 'error') return next === 'preparing';
  return false;
}

export function assertStudentActionAllowed(
  project: ProjectDefinition,
  state: PblSessionState,
  action: StudentAction,
): void {
  const stage = currentStage(project, state);
  if (
    action === 'next' &&
    stage?.kind === 'course' &&
    state.courses?.[stage.courseId]?.status !== 'completed'
  ) {
    throw new InvalidEngineTransitionError(
      'course must be completed before advancing',
      'COURSE_NOT_COMPLETED',
    );
  }
  if (!allowedStudentActions(project, state).includes(action)) {
    throw new InvalidEngineTransitionError(
      `student action ${action} is not allowed in the current stage`,
    );
  }
}

function clearActiveAgent(position: PblSessionState['position']): PblSessionState['position'] {
  const { activeAgent: _, activeAgentId: __, ...rest } = position;
  return rest;
}
