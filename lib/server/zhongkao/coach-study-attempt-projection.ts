import { createHash } from 'node:crypto';

import type { RuntimeRecord } from '@openmaic/dsl';

import {
  COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION,
  COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION_V2,
  COACH_PROJECTION_VERSION,
  assertCoachEvent,
  type CoachEvent,
  type CoachPhase,
} from '@/lib/zhongkao/coach-event';
import { CoachError } from '@/lib/zhongkao/coach-errors';
import { deriveOriginalObservedOutcomes } from '@/lib/zhongkao/coach-original-resolution';
import { foldCoachEvents } from '@/lib/zhongkao/coach-state';
import {
  STUDY_ATTEMPT_SCHEMA_VERSION_V2,
  assertStudyAttempt,
  type EvaluatedStudyAttemptV2,
  type StudyAttemptV2,
  type UnassessedStudyAttemptV2,
} from '@/lib/zhongkao/study-attempt';

import { extractVerifiedTransferAssignment } from './transfer-assignment';

export const COACH_STUDY_ATTEMPT_QUESTION_SUMMARY_MAX_LENGTH = 512;

const STUDY_ATTEMPT_ID_DOMAIN = 'openmaic:zhongkao:study-attempt:v2';
const STUDY_ATTEMPT_FINGERPRINT_DOMAIN = 'openmaic:zhongkao:study-attempt-fingerprint:v2';
const PROJECTION_REF_DOMAIN = 'openmaic:zhongkao:study-attempt-projection:v1';
const SOURCE_FACT_MISSING = 'STUDY_ATTEMPT_SOURCE_FACT_MISSING';

type ProjectionPhase = 'original' | 'transfer';

interface EventRecord<TEvent extends CoachEvent = CoachEvent> {
  event: TEvent;
  record: RuntimeRecord;
}

export interface CoachStudyAttemptProjectionPlan {
  projectionVersion: typeof COACH_PROJECTION_VERSION;
  coachSessionId: string;
  originalAttempt: StudyAttemptV2;
  transferAttempt: EvaluatedStudyAttemptV2;
  originalFingerprint: string;
  transferFingerprint: string;
  projectionRef: string;
}

function missing(): never {
  throw new CoachError(SOURCE_FACT_MISSING);
}

function digest(domain: string, canonicalValue: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0')
    .update(JSON.stringify(canonicalValue), 'utf8')
    .digest('hex');
}

function canonicalKnowledgePointIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

function boundedQuestionSummary(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized) return missing();
  return [...normalized].slice(0, COACH_STUDY_ATTEMPT_QUESTION_SUMMARY_MAX_LENGTH).join('');
}

export function deriveCoachStudyAttemptId(input: {
  coachSessionId: string;
  phase: ProjectionPhase;
}): string {
  const hash = digest(STUDY_ATTEMPT_ID_DOMAIN, [
    ['coachSessionId', input.coachSessionId],
    ['phase', input.phase],
    ['ordinal', 1],
  ]);
  return `study-attempt:v2:${hash}`;
}

function canonicalStudyAttemptV2(attempt: StudyAttemptV2): unknown[] {
  const evaluated = attempt.assessmentStatus === 'evaluated';
  return [
    ['schemaVersion', attempt.schemaVersion],
    ['assessmentStatus', attempt.assessmentStatus],
    ['unassessedReason', evaluated ? null : attempt.unassessedReason],
    ['coachSessionId', attempt.coachSessionId],
    ['id', attempt.id],
    ['profileId', attempt.profileId],
    ['createdAt', attempt.createdAt],
    ['subjectId', attempt.subjectId],
    ['knowledgePointIds', canonicalKnowledgePointIds(attempt.knowledgePointIds)],
    ['questionSummary', attempt.questionSummary],
    ['questionSourceType', attempt.questionSourceType],
    ['sourceMaterialId', attempt.sourceMaterialId ?? null],
    ['sourcePage', attempt.sourcePage ?? null],
    ['attemptKind', attempt.attemptKind],
    ['initialOutcome', evaluated ? attempt.initialOutcome : null],
    ['finalOutcome', evaluated ? attempt.finalOutcome : null],
    ['studentAttemptedBeforeHelp', attempt.studentAttemptedBeforeHelp],
    ['hintsUsed', attempt.hintsUsed],
    ['usedKeyHint', attempt.usedKeyHint],
    ['viewedFullAnswer', attempt.viewedFullAnswer],
    ['errorType', attempt.errorType ?? null],
    ['durationSeconds', attempt.durationSeconds ?? null],
  ];
}

export function fingerprintCoachStudyAttempt(attempt: StudyAttemptV2): string {
  assertStudyAttempt(attempt);
  return `study-attempt-fingerprint:v2:${digest(
    STUDY_ATTEMPT_FINGERPRINT_DOMAIN,
    canonicalStudyAttemptV2(attempt),
  )}`;
}

export function deriveCoachStudyAttemptProjectionRef(input: {
  projectionVersion: typeof COACH_PROJECTION_VERSION;
  coachSessionId: string;
  originalAttemptId: string;
  originalFingerprint: string;
  transferAttemptId: string;
  transferFingerprint: string;
}): string {
  const hash = digest(PROJECTION_REF_DOMAIN, [
    ['projectionVersion', input.projectionVersion],
    ['coachSessionId', input.coachSessionId],
    ['originalAttemptId', input.originalAttemptId],
    ['originalFingerprint', input.originalFingerprint],
    ['transferAttemptId', input.transferAttemptId],
    ['transferFingerprint', input.transferFingerprint],
  ]);
  return `coach-projection:v1:${hash}`;
}

function validatedEventRecords(records: readonly RuntimeRecord[]): {
  ordered: EventRecord[];
  state: ReturnType<typeof foldCoachEvents>;
} {
  if (!Array.isArray(records) || records.length === 0) return missing();
  const orderedRecords = [...records].sort((left, right) => left.seq - right.seq);
  const state = foldCoachEvents(orderedRecords);
  if (state.status !== 'finalizing' || state.studyAttemptsProjected) return missing();
  const ordered = orderedRecords.map((record) => {
    assertCoachEvent(record.payload);
    return { event: record.payload, record };
  });
  return { ordered, state };
}

function exactById<TType extends CoachEvent['eventType']>(
  records: readonly EventRecord[],
  eventId: string | undefined,
  eventType: TType,
): EventRecord<Extract<CoachEvent, { eventType: TType }>> {
  if (!eventId) return missing();
  const matches = records.filter(({ event }) => event.eventId === eventId);
  if (matches.length !== 1 || matches[0]!.event.eventType !== eventType) return missing();
  return matches[0] as EventRecord<Extract<CoachEvent, { eventType: TType }>>;
}

function firstOfType<TType extends CoachEvent['eventType']>(
  records: readonly EventRecord[],
  eventType: TType,
): EventRecord<Extract<CoachEvent, { eventType: TType }>> {
  const match = records.find(({ event }) => event.eventType === eventType);
  if (!match) return missing();
  return match as EventRecord<Extract<CoachEvent, { eventType: TType }>>;
}

function phaseHelpFacts(
  records: readonly EventRecord[],
  phase: CoachPhase,
  firstAttemptSeq: number,
): {
  studentAttemptedBeforeHelp: boolean;
  hintsUsed: number;
  usedKeyHint: boolean;
  viewedFullAnswer: boolean;
} {
  const hints = records.filter(
    ({ event }) => event.eventType === 'hint_issued' && event.phase === phase,
  ) as EventRecord<Extract<CoachEvent, { eventType: 'hint_issued' }>>[];
  const reveals = records.filter(
    ({ event }) => event.eventType === 'full_solution_revealed' && event.phase === phase,
  );
  const firstExposureSeq = [...hints, ...reveals]
    .map(({ record }) => record.seq)
    .toSorted((left, right) => left - right)[0];
  return {
    studentAttemptedBeforeHelp:
      firstExposureSeq === undefined || firstAttemptSeq < firstExposureSeq,
    hintsUsed: hints.length,
    usedKeyHint: hints.some(({ event }) => event.hintNumber === 3),
    viewedFullAnswer: reveals.length > 0,
  };
}

function buildOriginalAttempt(
  records: readonly EventRecord[],
  state: ReturnType<typeof foldCoachEvents>,
): StudyAttemptV2 {
  const start = firstOfType(records, 'coach_started');
  const originalSubmissions = records.filter(
    ({ event }) => event.eventType === 'student_attempt_submitted' && event.phase === 'original',
  ) as EventRecord<Extract<CoachEvent, { eventType: 'student_attempt_submitted' }>>[];
  const firstSubmission = originalSubmissions[0];
  if (!firstSubmission || !state.original.resolved) return missing();
  const resolution = exactById(
    records,
    state.original.resolutionEventId,
    'original_resolved',
  ).event;
  const common = {
    schemaVersion: STUDY_ATTEMPT_SCHEMA_VERSION_V2,
    id: deriveCoachStudyAttemptId({ coachSessionId: state.coachSessionId, phase: 'original' }),
    coachSessionId: state.coachSessionId,
    profileId: start.event.profileId,
    createdAt: firstSubmission.record.createdAt,
    subjectId: start.event.subjectId,
    knowledgePointIds: canonicalKnowledgePointIds(start.event.knowledgePointIds),
    questionSummary: boundedQuestionSummary(start.event.questionText),
    questionSourceType: start.event.questionSource.type,
    ...(start.event.questionSource.type === 'material'
      ? { sourceMaterialId: start.event.questionSource.materialId }
      : {}),
    attemptKind: 'initial' as const,
    ...phaseHelpFacts(records, 'original', firstSubmission.record.seq),
  };

  let attempt: StudyAttemptV2;
  if (state.original.assessment.status === 'unavailable') {
    const unavailable = exactById(
      records,
      state.original.assessment.unavailableEventId,
      'original_assessment_unavailable',
    ).event;
    if (
      resolution.resolutionSchemaVersion !== COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION ||
      resolution.resolutionKind !== 'full_solution' ||
      unavailable.reason !== state.original.assessment.reason
    ) {
      return missing();
    }
    attempt = {
      ...common,
      assessmentStatus: 'unassessed',
      unassessedReason: unavailable.reason,
    } satisfies UnassessedStudyAttemptV2;
  } else {
    if (
      state.original.assessment.status !== 'prepared' ||
      (resolution.resolutionSchemaVersion !== COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION_V2 &&
        resolution.resolutionSchemaVersion !== COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION)
    ) {
      return missing();
    }
    const outcomes = deriveOriginalObservedOutcomes({
      records: records.map(({ record }) => record),
    });
    if (!outcomes.firstEvaluatedOutcome || !outcomes.lastEvaluatedOutcome) return missing();
    let finalOutcome = outcomes.lastEvaluatedOutcome;
    if (resolution.resolutionKind === 'evaluated_attempt') {
      const evaluation = exactById(
        records,
        resolution.evaluationEventId,
        'original_attempt_evaluated',
      ).event;
      if (!state.original.evaluationEventIds.includes(evaluation.eventId)) return missing();
      finalOutcome = evaluation.outcome;
    }
    attempt = {
      ...common,
      assessmentStatus: 'evaluated',
      initialOutcome: outcomes.firstEvaluatedOutcome,
      finalOutcome,
    } satisfies EvaluatedStudyAttemptV2;
  }
  assertStudyAttempt(attempt);
  return attempt;
}

function buildTransferAttempt(
  records: readonly EventRecord[],
  state: ReturnType<typeof foldCoachEvents>,
): EvaluatedStudyAttemptV2 {
  const start = firstOfType(records, 'coach_started');
  const assignment = exactById(
    records,
    state.transfer.assignmentEventId,
    'transfer_question_assigned',
  );
  const verified = extractVerifiedTransferAssignment(assignment.event);
  if (
    state.transfer.submissionEventIds.length !== 1 ||
    state.transfer.attemptCount !== 1 ||
    !state.transfer.evaluationEventId
  ) {
    return missing();
  }
  const submission = exactById(
    records,
    state.transfer.submissionEventIds[0],
    'transfer_answer_submitted',
  );
  const evaluation = exactById(
    records,
    state.transfer.evaluationEventId,
    'transfer_answer_evaluated',
  );
  if (
    evaluation.event.submissionEventId !== submission.event.eventId ||
    evaluation.event.transferQuestionId !== verified.publicQuestion.transferQuestionId
  ) {
    return missing();
  }
  const help = phaseHelpFacts(records, 'transfer', submission.record.seq);
  const attempt: EvaluatedStudyAttemptV2 = {
    schemaVersion: STUDY_ATTEMPT_SCHEMA_VERSION_V2,
    id: deriveCoachStudyAttemptId({ coachSessionId: state.coachSessionId, phase: 'transfer' }),
    coachSessionId: state.coachSessionId,
    profileId: start.event.profileId,
    createdAt: submission.record.createdAt,
    subjectId: start.event.subjectId,
    knowledgePointIds: canonicalKnowledgePointIds(verified.publicQuestion.knowledgePointIds),
    questionSummary: boundedQuestionSummary(verified.publicQuestion.question),
    questionSourceType: 'generated',
    attemptKind: 'transfer',
    assessmentStatus: 'evaluated',
    initialOutcome: evaluation.event.outcome,
    finalOutcome: evaluation.event.outcome,
    studentAttemptedBeforeHelp: help.studentAttemptedBeforeHelp,
    hintsUsed: help.hintsUsed,
    usedKeyHint: help.usedKeyHint,
    viewedFullAnswer: false,
  };
  assertStudyAttempt(attempt);
  return attempt;
}

/** Validate and fold raw durable Coach records before deriving any learning fact. */
export function buildCoachStudyAttemptProjection(
  records: readonly RuntimeRecord[],
): CoachStudyAttemptProjectionPlan {
  const { ordered, state } = validatedEventRecords(records);
  const originalAttempt = buildOriginalAttempt(ordered, state);
  const transferAttempt = buildTransferAttempt(ordered, state);
  const originalFingerprint = fingerprintCoachStudyAttempt(originalAttempt);
  const transferFingerprint = fingerprintCoachStudyAttempt(transferAttempt);
  const projectionRef = deriveCoachStudyAttemptProjectionRef({
    projectionVersion: COACH_PROJECTION_VERSION,
    coachSessionId: state.coachSessionId,
    originalAttemptId: originalAttempt.id,
    originalFingerprint,
    transferAttemptId: transferAttempt.id,
    transferFingerprint,
  });
  return {
    projectionVersion: COACH_PROJECTION_VERSION,
    coachSessionId: state.coachSessionId,
    originalAttempt,
    transferAttempt,
    originalFingerprint,
    transferFingerprint,
    projectionRef,
  };
}
