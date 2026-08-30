import type { RuntimeRecord } from '@openmaic/dsl';

import { CoachError, isCoachError } from '@/lib/zhongkao/coach-errors';
import { COACH_PROJECTION_VERSION, assertCoachEvent } from '@/lib/zhongkao/coach-event';
import {
  loadStudyAttempts,
  saveStudyAttempt,
  type ZhongkaoRuntimeDeps,
} from '@/lib/zhongkao/runtime';
import {
  STUDY_ATTEMPT_CONFLICT_CODE,
  studyAttemptFactsEqual,
  type StudyAttempt,
  type StudyAttemptV2,
} from '@/lib/zhongkao/study-attempt';

import { resolveZhongkaoLearnerKeyFromOwnerId } from './learner-identity';
import {
  buildCoachStudyAttemptProjection,
  fingerprintCoachStudyAttempt,
  type CoachStudyAttemptProjectionPlan,
} from './coach-study-attempt-projection';
import type { CoachRuntimeSnapshot, CoachRuntimeWriteResult } from './coach-runtime';
import {
  getCoachProblemState,
  recordStudyAttemptsProjected,
  type CoachServiceDeps,
} from './coach-service';

export interface CoachProjectionDependencies extends CoachServiceDeps {
  abortSignal?: AbortSignal;
}

interface ProjectionSource {
  plan: CoachStudyAttemptProjectionPlan;
  projectionEvent?: Extract<
    ReturnType<typeof coachEvent>,
    { eventType: 'study_attempts_projected' }
  >;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

function coachEvent(record: RuntimeRecord) {
  assertCoachEvent(record.payload);
  return record.payload;
}

function conflict(): never {
  throw new CoachError('STUDY_ATTEMPT_PROJECTION_CONFLICT');
}

function sourceFromSnapshot(snapshot: CoachRuntimeSnapshot): ProjectionSource {
  const projectedRecords = snapshot.records.filter(
    (record) => coachEvent(record).eventType === 'study_attempts_projected',
  );
  if (projectedRecords.length > 1) return conflict();

  const projectionRecord = projectedRecords[0];
  if (!projectionRecord) {
    if (snapshot.state.status !== 'finalizing' || snapshot.state.studyAttemptsProjected) {
      return conflict();
    }
    return { plan: buildCoachStudyAttemptProjection(snapshot.records) };
  }
  const projectionEvent = coachEvent(projectionRecord);
  if (
    projectionEvent.eventType !== 'study_attempts_projected' ||
    snapshot.state.status !== 'completed' ||
    !snapshot.state.studyAttemptsProjected ||
    snapshot.state.projectionEventId !== projectionEvent.eventId ||
    projectionRecord.seq !== snapshot.records.length - 1
  ) {
    return conflict();
  }

  const sourceRecords = snapshot.records.filter((record) => record !== projectionRecord);
  return {
    plan: buildCoachStudyAttemptProjection(sourceRecords),
    projectionEvent,
  };
}

function runtimeDeps(deps: CoachProjectionDependencies): ZhongkaoRuntimeDeps {
  return {
    store: deps.store,
    learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId),
    ...(deps.now ? { now: deps.now } : {}),
  };
}

function isPersistedFactConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    STUDY_ATTEMPT_CONFLICT_CODE,
    'ZHONGKAO_STUDY_ATTEMPT_INVALID',
    'ZHONGKAO_RUNTIME_PROFILE_MISMATCH',
    'ZHONGKAO_RUNTIME_SESSION_INVARIANT',
    'ZHONGKAO_RUNTIME_SESSION_AMBIGUOUS',
  ].some((code) => error.message.includes(code));
}

function mapAttemptPersistenceError(error: unknown): never {
  if (isCoachError(error)) throw error;
  if (isPersistedFactConflict(error)) return conflict();
  throw new CoachError('STUDY_ATTEMPT_PERSISTENCE_UNAVAILABLE');
}

function exactPersistedAttempt(
  attempts: readonly StudyAttempt[],
  expected: StudyAttemptV2,
  expectedFingerprint: string,
): void {
  const matches = attempts.filter((attempt) => attempt.id === expected.id);
  if (matches.length === 0) return conflict();
  for (const attempt of matches) {
    if (
      attempt.schemaVersion !== 2 ||
      !studyAttemptFactsEqual(attempt, expected) ||
      fingerprintCoachStudyAttempt(attempt) !== expectedFingerprint
    ) {
      return conflict();
    }
  }
}

async function verifyPersistedAttempts(
  deps: CoachProjectionDependencies,
  profileId: string,
  expected: readonly { attempt: StudyAttemptV2; fingerprint: string }[],
): Promise<void> {
  let attempts;
  try {
    attempts = await loadStudyAttempts(profileId, runtimeDeps(deps));
  } catch (error) {
    return mapAttemptPersistenceError(error);
  }
  for (const item of expected) {
    exactPersistedAttempt(attempts, item.attempt, item.fingerprint);
  }
}

async function verifyPersistedPlan(
  deps: CoachProjectionDependencies,
  plan: CoachStudyAttemptProjectionPlan,
): Promise<void> {
  await verifyPersistedAttempts(deps, plan.originalAttempt.profileId, [
    { attempt: plan.originalAttempt, fingerprint: plan.originalFingerprint },
    { attempt: plan.transferAttempt, fingerprint: plan.transferFingerprint },
  ]);
}

function assertPlanIdentity(
  plan: CoachStudyAttemptProjectionPlan,
  profileId: string,
  coachSessionId: string,
): void {
  if (
    plan.projectionVersion !== COACH_PROJECTION_VERSION ||
    plan.coachSessionId !== coachSessionId ||
    plan.originalAttempt.profileId !== profileId ||
    plan.transferAttempt.profileId !== profileId ||
    plan.originalAttempt.coachSessionId !== coachSessionId ||
    plan.transferAttempt.coachSessionId !== coachSessionId
  ) {
    conflict();
  }
}

function assertSamePlan(
  expected: CoachStudyAttemptProjectionPlan,
  current: CoachStudyAttemptProjectionPlan,
): void {
  if (
    expected.projectionRef !== current.projectionRef ||
    expected.originalFingerprint !== current.originalFingerprint ||
    expected.transferFingerprint !== current.transferFingerprint ||
    !studyAttemptFactsEqual(expected.originalAttempt, current.originalAttempt) ||
    !studyAttemptFactsEqual(expected.transferAttempt, current.transferAttempt)
  ) {
    conflict();
  }
}

async function verifiedCompletedReplay(
  deps: CoachProjectionDependencies,
  snapshot: CoachRuntimeSnapshot,
  expectedPlan?: CoachStudyAttemptProjectionPlan,
): Promise<CoachRuntimeWriteResult> {
  let source: ProjectionSource;
  try {
    source = sourceFromSnapshot(snapshot);
  } catch {
    // Once the terminal projection event exists, any inability to rebuild its
    // source plan is durable corruption rather than a recoverable missing fact.
    return conflict();
  }
  assertPlanIdentity(source.plan, snapshot.state.profileId, snapshot.state.coachSessionId);
  if (!source.projectionEvent) return conflict();
  if (expectedPlan) assertSamePlan(expectedPlan, source.plan);
  if (
    source.projectionEvent.projectionVersion !== source.plan.projectionVersion ||
    source.projectionEvent.projectionRef !== source.plan.projectionRef ||
    source.projectionEvent.evaluationEventId !== snapshot.state.transfer.evaluationEventId ||
    snapshot.state.projectionRef !== source.plan.projectionRef
  ) {
    return conflict();
  }
  await verifyPersistedPlan(deps, source.plan);
  return { snapshot, replayed: true, eventAppended: false };
}

async function persistAttempt(
  deps: CoachProjectionDependencies,
  attempt: StudyAttemptV2,
): Promise<void> {
  try {
    await saveStudyAttempt(attempt, runtimeDeps(deps));
  } catch (error) {
    return mapAttemptPersistenceError(error);
  }
}

async function reloadCompletedAfterAppendFailure(
  deps: CoachProjectionDependencies,
  profileId: string,
  coachSessionId: string,
  plan: CoachStudyAttemptProjectionPlan,
): Promise<CoachRuntimeWriteResult | undefined> {
  let latest: CoachRuntimeSnapshot;
  try {
    latest = await getCoachProblemState(deps, profileId, coachSessionId);
  } catch {
    return undefined;
  }
  if (latest.state.status !== 'completed') return undefined;
  return verifiedCompletedReplay(deps, latest, plan);
}

/**
 * Persist the two deterministic StudyAttempts before atomically committing the
 * terminal Coach event. Every authority input is reloaded from durable history.
 */
export async function ensureStudyAttemptsProjected(
  deps: CoachProjectionDependencies,
  input: { profileId: string; coachSessionId: string },
): Promise<CoachRuntimeWriteResult> {
  throwIfAborted(deps.abortSignal);
  let snapshot = await getCoachProblemState(deps, input.profileId, input.coachSessionId);
  throwIfAborted(deps.abortSignal);

  if (snapshot.state.status === 'completed') {
    return verifiedCompletedReplay(deps, snapshot);
  }

  const initialSource = sourceFromSnapshot(snapshot);
  const plan = initialSource.plan;
  if (initialSource.projectionEvent) return conflict();
  assertPlanIdentity(plan, input.profileId, input.coachSessionId);

  await persistAttempt(deps, plan.originalAttempt);
  throwIfAborted(deps.abortSignal);
  await verifyPersistedAttempts(deps, plan.originalAttempt.profileId, [
    { attempt: plan.originalAttempt, fingerprint: plan.originalFingerprint },
  ]);
  await persistAttempt(deps, plan.transferAttempt);
  throwIfAborted(deps.abortSignal);
  await verifyPersistedPlan(deps, plan);

  snapshot = await getCoachProblemState(deps, input.profileId, input.coachSessionId);
  throwIfAborted(deps.abortSignal);
  if (snapshot.state.status === 'completed') {
    return verifiedCompletedReplay(deps, snapshot, plan);
  }
  const currentSource = sourceFromSnapshot(snapshot);
  if (currentSource.projectionEvent) return conflict();
  assertSamePlan(plan, currentSource.plan);
  await verifyPersistedPlan(deps, plan);

  const evaluationEventId = snapshot.state.transfer.evaluationEventId;
  if (!evaluationEventId) {
    throw new CoachError('STUDY_ATTEMPT_SOURCE_FACT_MISSING');
  }
  let projected: CoachRuntimeWriteResult;
  try {
    projected = await recordStudyAttemptsProjected(deps, {
      profileId: input.profileId,
      coachSessionId: input.coachSessionId,
      expectedRevision: snapshot.state.revision,
      evaluationEventId,
      projectionRef: plan.projectionRef,
    });
  } catch (error) {
    const completed = await reloadCompletedAfterAppendFailure(
      deps,
      input.profileId,
      input.coachSessionId,
      plan,
    );
    if (completed) return completed;
    if (
      isCoachError(error) &&
      (error.code === 'COACH_EVENT_CONFLICT' || error.code === 'COACH_ACTION_NOT_ALLOWED')
    ) {
      return conflict();
    }
    throw new CoachError('STUDY_ATTEMPT_PROJECTION_FAILED');
  }
  throwIfAborted(deps.abortSignal);
  if (projected.snapshot.state.status !== 'completed') {
    throw new CoachError('STUDY_ATTEMPT_PROJECTION_FAILED');
  }
  const verified = await verifiedCompletedReplay(deps, projected.snapshot, plan);
  return {
    snapshot: verified.snapshot,
    replayed: projected.replayed,
    eventAppended: projected.eventAppended,
  };
}
