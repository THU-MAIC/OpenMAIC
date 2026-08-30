import type { AICallFn } from '@openmaic/generation';

import { CoachError } from '@/lib/zhongkao/coach-errors';
import { assertCoachEvent, type CoachEvent } from '@/lib/zhongkao/coach-event';

import {
  generateVerifiedOriginalAssessment,
  extractVerifiedOriginalAssessment,
} from './original-assessment-private';
import {
  getCoachProblemState,
  recordOriginalAssessmentPrepared,
  recordOriginalAttemptEvaluation,
  recordOriginalResolvedFromEvaluation,
  type CoachActionResult,
  type CoachServiceDeps,
} from './coach-service';
import type { CoachRuntimeSnapshot } from './coach-runtime';
import { createCoachOperationFingerprint } from './coach-runtime';

export interface CoachOriginalAssessmentDependencies extends CoachServiceDeps {
  generationCall?: AICallFn;
  originalAssessmentVerificationCall?: AICallFn;
  abortSignal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

function events(snapshot: CoachRuntimeSnapshot): CoachEvent[] {
  return snapshot.records.map((record) => {
    assertCoachEvent(record.payload);
    return record.payload;
  });
}

function startEvent(snapshot: CoachRuntimeSnapshot) {
  const start = events(snapshot).find((event) => event.eventType === 'coach_started');
  if (!start || start.eventType !== 'coach_started') throw new CoachError('COACH_EVENT_CONFLICT');
  return start;
}

function preparedEvent(snapshot: CoachRuntimeSnapshot) {
  const prepared = events(snapshot).filter(
    (event) => event.eventType === 'original_assessment_prepared',
  );
  if (prepared.length > 1) throw new CoachError('COACH_EVENT_CONFLICT');
  const event = prepared[0];
  if (!event || event.eventType !== 'original_assessment_prepared') return undefined;
  extractVerifiedOriginalAssessment(event, startEvent(snapshot));
  return event;
}

function attemptEvent(snapshot: CoachRuntimeSnapshot, attemptEventId: string) {
  const attempt = events(snapshot).find((event) => event.eventId === attemptEventId);
  if (!attempt || attempt.eventType !== 'student_attempt_submitted') {
    throw new CoachError('ORIGINAL_ATTEMPT_EVALUATION_FAILED');
  }
  return attempt;
}

function evaluationForAttempt(snapshot: CoachRuntimeSnapshot, attemptEventId: string) {
  const matches = events(snapshot).filter(
    (event) =>
      event.eventType === 'original_attempt_evaluated' && event.attemptEventId === attemptEventId,
  );
  if (matches.length > 1) throw new CoachError('ORIGINAL_ATTEMPT_EVALUATION_CONFLICT');
  const evaluation = matches[0];
  return evaluation?.eventType === 'original_attempt_evaluated' ? evaluation : undefined;
}

function assessmentFactsFingerprint(value: ReturnType<typeof extractVerifiedOriginalAssessment>) {
  return createCoachOperationFingerprint({
    assessmentVersion: value.assessmentVersion,
    assessmentId: value.assessmentId,
    questionFingerprint: value.questionFingerprint,
    questionType: value.questionType,
    gradingSpec: value.gradingSpec,
    verificationRef: value.verificationRef,
    verification: value.verification,
  });
}

async function reload(
  deps: CoachOriginalAssessmentDependencies,
  profileId: string,
  coachSessionId: string,
) {
  throwIfAborted(deps.abortSignal);
  return getCoachProblemState(deps, profileId, coachSessionId);
}

async function resolvePendingCorrect(
  deps: CoachOriginalAssessmentDependencies,
  snapshot: CoachRuntimeSnapshot,
): Promise<CoachActionResult> {
  if (snapshot.state.original.resolved) {
    return { snapshot, replayed: true, eventAppended: false };
  }
  const evaluationEventId = snapshot.state.original.correctEvaluationEventId;
  if (!evaluationEventId) return { snapshot, replayed: true, eventAppended: false };
  return recordOriginalResolvedFromEvaluation(deps, {
    profileId: snapshot.state.profileId,
    coachSessionId: snapshot.state.coachSessionId,
    expectedRevision: snapshot.state.revision,
    evaluationEventId,
  });
}

/** Recover only from an already durable assessment; this path never invokes a model. */
export async function recoverPreparedOriginalAssessment(
  deps: CoachOriginalAssessmentDependencies,
  input: { profileId: string; coachSessionId: string },
): Promise<CoachActionResult | undefined> {
  let snapshot = await reload(deps, input.profileId, input.coachSessionId);
  const assessment = preparedEvent(snapshot);
  if (!assessment) return undefined;
  let eventAppended = false;

  for (;;) {
    throwIfAborted(deps.abortSignal);
    if (snapshot.state.original.resolved) {
      return { snapshot, replayed: !eventAppended, eventAppended };
    }
    const nextAttemptId = snapshot.state.original.attemptEventIds.find(
      (id) => !snapshot.state.original.evaluatedAttemptEventIds.includes(id),
    );
    if (!nextAttemptId) {
      if (snapshot.state.original.correctEvaluationEventId) {
        const resolved = await resolvePendingCorrect(deps, snapshot);
        return {
          snapshot: resolved.snapshot,
          replayed: !eventAppended && resolved.replayed,
          eventAppended: eventAppended || resolved.eventAppended,
        };
      }
      return { snapshot, replayed: !eventAppended, eventAppended };
    }
    try {
      const evaluated = await recordOriginalAttemptEvaluation(deps, {
        profileId: input.profileId,
        coachSessionId: input.coachSessionId,
        expectedRevision: snapshot.state.revision,
        assessmentEventId: assessment.eventId,
        attemptEventId: nextAttemptId,
      });
      snapshot = evaluated.snapshot;
      eventAppended ||= evaluated.eventAppended;
    } catch (error) {
      if (!(error instanceof CoachError) || error.code !== 'COACH_SESSION_CONFLICT') throw error;
      snapshot = await reload(deps, input.profileId, input.coachSessionId);
      const persisted = evaluationForAttempt(snapshot, nextAttemptId);
      if (!persisted) throw error;
    }
  }
}

/** Lazy prepare, durable persist, deterministic evaluation, and correct-only resolution. */
export async function completeOriginalAttemptAssessment(
  deps: CoachOriginalAssessmentDependencies,
  input: { profileId: string; coachSessionId: string; attemptEventId: string },
): Promise<CoachActionResult> {
  let snapshot = await reload(deps, input.profileId, input.coachSessionId);
  attemptEvent(snapshot, input.attemptEventId);
  let assessment = preparedEvent(snapshot);
  let assessmentAppended = false;

  if (!assessment) {
    const start = startEvent(snapshot);
    const verified = await generateVerifiedOriginalAssessment(
      {
        generateCandidate: deps.generationCall,
        verifyCandidate: deps.originalAssessmentVerificationCall ?? deps.generationCall,
      },
      {
        coachSessionId: snapshot.state.coachSessionId,
        subjectId: start.subjectId,
        knowledgePointIds: start.knowledgePointIds,
        questionText: start.questionText,
        questionSource: start.questionSource,
      },
      deps.abortSignal,
    );
    throwIfAborted(deps.abortSignal);
    try {
      const prepared = await recordOriginalAssessmentPrepared(deps, {
        profileId: input.profileId,
        coachSessionId: input.coachSessionId,
        expectedRevision: snapshot.state.revision,
        verifiedAssessment: verified,
      });
      snapshot = prepared.snapshot;
      assessmentAppended = prepared.eventAppended;
    } catch (error) {
      snapshot = await reload(deps, input.profileId, input.coachSessionId);
      assessment = preparedEvent(snapshot);
      if (!assessment) throw error;
      const winner = extractVerifiedOriginalAssessment(assessment, startEvent(snapshot));
      if (assessmentFactsFingerprint(winner) !== assessmentFactsFingerprint(verified)) {
        throw new CoachError('COACH_EVENT_CONFLICT');
      }
    }
    assessment ??= preparedEvent(snapshot);
    if (!assessment) throw new CoachError('ORIGINAL_ASSESSMENT_NOT_VERIFIED');
  }

  const recovered = await recoverPreparedOriginalAssessment(deps, input);
  if (!recovered) throw new CoachError('ORIGINAL_ATTEMPT_EVALUATION_FAILED');
  const targetEvaluation = evaluationForAttempt(recovered.snapshot, input.attemptEventId);
  if (!targetEvaluation) throw new CoachError('ORIGINAL_ATTEMPT_EVALUATION_FAILED');
  return {
    snapshot: recovered.snapshot,
    replayed: !assessmentAppended && recovered.replayed,
    eventAppended: assessmentAppended || recovered.eventAppended,
  };
}
