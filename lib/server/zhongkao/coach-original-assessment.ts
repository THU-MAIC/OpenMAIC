import type { AICallFn } from '@openmaic/generation';

import { CoachError } from '@/lib/zhongkao/coach-errors';
import { assertCoachEvent, type CoachEvent } from '@/lib/zhongkao/coach-event';
import { selectOriginalResolution } from '@/lib/zhongkao/coach-original-resolution';

import {
  generateVerifiedOriginalAssessment,
  extractVerifiedOriginalAssessment,
} from './original-assessment-private';
import {
  getCoachProblemState,
  recordOriginalAssessmentPrepared,
  recordOriginalAssessmentUnavailable,
  recordOriginalAttemptEvaluation,
  recordOriginalResolvedFromEvaluation,
  recordOriginalResolvedFromFullSolution,
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

function unavailableResult(snapshot: CoachRuntimeSnapshot): CoachActionResult | undefined {
  if (snapshot.state.original.assessment.status !== 'unavailable') return undefined;
  return {
    snapshot,
    replayed: true,
    eventAppended: false,
    code: 'ORIGINAL_ASSESSMENT_UNAVAILABLE',
  };
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

/** Recover only from an already durable assessment; this path never invokes a model. */
export async function recoverPreparedOriginalAssessment(
  deps: CoachOriginalAssessmentDependencies,
  input: { profileId: string; coachSessionId: string },
): Promise<CoachActionResult | undefined> {
  let snapshot = await reload(deps, input.profileId, input.coachSessionId);
  if (snapshot.state.status === 'abandoned' || snapshot.state.status === 'completed') {
    return { snapshot, replayed: true, eventAppended: false };
  }
  const assessment = preparedEvent(snapshot);
  if (!assessment) return undefined;
  let eventAppended = false;

  for (;;) {
    throwIfAborted(deps.abortSignal);
    const decision = selectOriginalResolution(snapshot);
    if (decision.kind === 'existing') {
      return { snapshot, replayed: !eventAppended, eventAppended };
    }
    if (decision.kind === 'evaluated_attempt' || decision.kind === 'full_solution') {
      try {
        const resolved =
          decision.kind === 'evaluated_attempt'
            ? await recordOriginalResolvedFromEvaluation(deps, {
                profileId: input.profileId,
                coachSessionId: input.coachSessionId,
                expectedRevision: snapshot.state.revision,
                evaluationEventId: decision.evaluationEventId,
              })
            : await recordOriginalResolvedFromFullSolution(deps, {
                profileId: input.profileId,
                coachSessionId: input.coachSessionId,
                expectedRevision: snapshot.state.revision,
                fullSolutionEventId: decision.fullSolutionEventId,
              });
        return {
          snapshot: resolved.snapshot,
          replayed: !eventAppended && resolved.replayed,
          eventAppended: eventAppended || resolved.eventAppended,
        };
      } catch (error) {
        if (!(error instanceof CoachError) || error.code !== 'COACH_SESSION_CONFLICT') throw error;
        snapshot = await reload(deps, input.profileId, input.coachSessionId);
        continue;
      }
    }
    if (decision.kind === 'unresolved') {
      return { snapshot, replayed: !eventAppended, eventAppended };
    }
    try {
      const evaluated = await recordOriginalAttemptEvaluation(deps, {
        profileId: input.profileId,
        coachSessionId: input.coachSessionId,
        expectedRevision: snapshot.state.revision,
        assessmentEventId: decision.assessmentEventId,
        attemptEventId: decision.attemptEventId,
      });
      snapshot = evaluated.snapshot;
      eventAppended ||= evaluated.eventAppended;
    } catch (error) {
      if (!(error instanceof CoachError) || error.code !== 'COACH_SESSION_CONFLICT') throw error;
      snapshot = await reload(deps, input.profileId, input.coachSessionId);
      const persisted = evaluationForAttempt(snapshot, decision.attemptEventId);
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
  const unavailable = unavailableResult(snapshot);
  if (unavailable) return unavailable;
  let assessment = preparedEvent(snapshot);
  let assessmentAppended = false;

  if (!assessment) {
    const start = startEvent(snapshot);
    let verified;
    try {
      verified = await generateVerifiedOriginalAssessment(
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
    } catch (error) {
      if (!(error instanceof CoachError) || error.code !== 'ORIGINAL_ASSESSMENT_UNAVAILABLE') {
        throw error;
      }
      throwIfAborted(deps.abortSignal);
      try {
        const recorded = await recordOriginalAssessmentUnavailable(deps, {
          profileId: input.profileId,
          coachSessionId: input.coachSessionId,
          expectedRevision: snapshot.state.revision,
          reason: 'unsupported_question_type',
          abortSignal: deps.abortSignal,
        });
        return { ...recorded, code: 'ORIGINAL_ASSESSMENT_UNAVAILABLE' };
      } catch (persistError) {
        snapshot = await reload(deps, input.profileId, input.coachSessionId);
        const persistedUnavailable = unavailableResult(snapshot);
        if (persistedUnavailable) return persistedUnavailable;
        assessment = preparedEvent(snapshot);
        if (!assessment) throw persistError;
      }
    }
    if (!verified) {
      if (!assessment) throw new CoachError('COACH_EVENT_CONFLICT');
    } else {
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
        const persistedUnavailable = unavailableResult(snapshot);
        if (persistedUnavailable) return persistedUnavailable;
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
