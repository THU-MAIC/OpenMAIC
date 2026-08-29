import type { RuntimeRecord } from '@openmaic/dsl';

import { CoachError } from './coach-errors';
import {
  assertCoachEvent,
  type CoachEvent,
  type CoachOutcome,
  type CoachPhase,
  type CoachQuestionSource,
} from './coach-event';
import { isFullSolutionAvailable } from './coach-policy';

export type CoachStatus =
  | 'awaiting_student_attempt'
  | 'hint_pending'
  | 'hinting'
  | 'solution_locked'
  | 'solution_available'
  | 'transfer_pending'
  | 'finalizing'
  | 'completed'
  | 'abandoned';

export interface CoachMessageRef {
  agentSessionId: string;
  userMessageSeq: number;
}

export interface CoachPhaseState {
  attemptCount: number;
  attemptEventIds: string[];
  attemptMessageRefs: CoachMessageRef[];
  hintRequestEventIds: string[];
  pendingHintRequestEventId?: string;
  hintIssuedEventIds: string[];
  hintsIssued: number;
  keyHintUsed: boolean;
  fullSolutionRequestEventIds: string[];
  pendingFullSolutionRequestEventId?: string;
  viewedFullAnswer: boolean;
}

export interface CoachOriginalState extends CoachPhaseState {
  fullSolutionAvailable: boolean;
  resolved: boolean;
  resolutionEventId?: string;
  outcome?: CoachOutcome;
}

export interface CoachTransferState extends CoachPhaseState {
  assigned: boolean;
  assignmentEventId?: string;
  transferQuestionId?: string;
  submissionEventIds: string[];
  evaluationEventId?: string;
  outcome?: CoachOutcome;
}

export interface CoachState {
  schemaVersion: 1;
  coachSessionId: string;
  profileId: string;
  status: CoachStatus;
  revision: number;
  sourceAgentSessionIds: string[];
  subjectId: string;
  knowledgePointIds: string[];
  questionSource: CoachQuestionSource;
  questionMessageRef: CoachMessageRef;
  original: CoachOriginalState;
  transfer: CoachTransferState;
  studyAttemptsProjected: boolean;
  projectionEventId?: string;
  projectionRef?: string;
  createdAt: string;
  updatedAt: string;
}

function conflict(): never {
  throw new CoachError('COACH_EVENT_CONFLICT');
}

function messageRef(event: CoachEvent): CoachMessageRef {
  if (event.sourceUserMessageSeq === undefined) return conflict();
  return {
    agentSessionId: event.agentSessionId,
    userMessageSeq: event.sourceUserMessageSeq,
  };
}

function messageRefKey(ref: CoachMessageRef): string {
  return `${ref.agentSessionId}\0${ref.userMessageSeq}`;
}

function sameIdentifierSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort();
  const orderedRight = [...right].sort();
  return orderedLeft.every((value, index) => value === orderedRight[index]);
}

function emptyPhaseState(): CoachPhaseState {
  return {
    attemptCount: 0,
    attemptEventIds: [],
    attemptMessageRefs: [],
    hintRequestEventIds: [],
    hintIssuedEventIds: [],
    hintsIssued: 0,
    keyHintUsed: false,
    fullSolutionRequestEventIds: [],
    viewedFullAnswer: false,
  };
}

function phaseState(state: CoachState, phase: CoachPhase): CoachPhaseState {
  return phase === 'original' ? state.original : state.transfer;
}

function originalAcceptsStudentAction(state: CoachState): boolean {
  return (
    state.status !== 'abandoned' &&
    state.status !== 'completed' &&
    !state.original.resolved &&
    !state.original.viewedFullAnswer &&
    !state.transfer.assigned
  );
}

function transferAcceptsStudentAction(state: CoachState): boolean {
  return (
    state.status !== 'abandoned' &&
    state.status !== 'completed' &&
    state.transfer.assigned &&
    state.transfer.attemptCount === 0
  );
}

function phaseAcceptsHintRequest(state: CoachState, phase: CoachPhase): boolean {
  return phase === 'original'
    ? originalAcceptsStudentAction(state)
    : transferAcceptsStudentAction(state);
}

function derivedStatus(state: CoachState): CoachStatus {
  if (state.status === 'abandoned') return 'abandoned';
  if (state.studyAttemptsProjected) return 'completed';
  if (state.transfer.attemptCount > 0) return 'finalizing';
  if (state.transfer.assigned) {
    return state.transfer.pendingHintRequestEventId ? 'hint_pending' : 'transfer_pending';
  }
  if (state.original.resolved || state.original.viewedFullAnswer) return 'transfer_pending';
  if (state.original.pendingHintRequestEventId) return 'hint_pending';
  if (state.original.fullSolutionAvailable) return 'solution_available';
  if (state.original.hintsIssued > 0) return 'hinting';
  if (state.original.attemptCount > 0 || state.original.fullSolutionRequestEventIds.length > 0) {
    return 'solution_locked';
  }
  return 'awaiting_student_attempt';
}

function referencedEvent<TType extends CoachEvent['eventType']>(
  eventsById: ReadonlyMap<string, CoachEvent>,
  eventId: string,
  eventType: TType,
): Extract<CoachEvent, { eventType: TType }> {
  const event = eventsById.get(eventId);
  if (!event || event.eventType !== eventType) return conflict();
  return event as Extract<CoachEvent, { eventType: TType }>;
}

export function foldCoachEvents(records: readonly RuntimeRecord[]): CoachState {
  if (records.length === 0) return conflict();
  const ordered = [...records].sort((left, right) => left.seq - right.seq);
  let runtimeSessionId: string | undefined;
  let state: CoachState | undefined;
  const eventsById = new Map<string, CoachEvent>();
  const operationIds = new Set<string>();
  const attemptMessageRefs = new Set<string>();
  const hintRequestMessageRefs = new Set<string>();
  const fullSolutionRequestMessageRefs = new Set<string>();

  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index]!;
    if (!Number.isSafeInteger(record.seq) || record.seq !== index) conflict();
    runtimeSessionId ??= record.sessionId;
    if (record.sessionId !== runtimeSessionId) conflict();

    assertCoachEvent(record.payload);
    const event = record.payload;
    if (eventsById.has(event.eventId) || operationIds.has(event.operationId)) conflict();

    if (!state) {
      if (event.eventType !== 'coach_started') conflict();
      state = {
        schemaVersion: 1,
        coachSessionId: event.coachSessionId,
        profileId: event.profileId,
        status: 'awaiting_student_attempt',
        revision: 0,
        sourceAgentSessionIds: [event.agentSessionId],
        subjectId: event.subjectId,
        knowledgePointIds: [...event.knowledgePointIds],
        questionSource: { ...event.questionSource },
        questionMessageRef: messageRef(event),
        original: {
          ...emptyPhaseState(),
          fullSolutionAvailable: false,
          resolved: false,
        },
        transfer: {
          ...emptyPhaseState(),
          assigned: false,
          submissionEventIds: [],
        },
        studyAttemptsProjected: false,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      };
      eventsById.set(event.eventId, event);
      operationIds.add(event.operationId);
      continue;
    }

    if (
      event.eventType === 'coach_started' ||
      event.coachSessionId !== state.coachSessionId ||
      event.profileId !== state.profileId
    ) {
      conflict();
    }
    if (state.status === 'completed' || state.status === 'abandoned') conflict();
    if (!state.sourceAgentSessionIds.includes(event.agentSessionId)) {
      state.sourceAgentSessionIds.push(event.agentSessionId);
    }

    switch (event.eventType) {
      case 'student_attempt_submitted': {
        if (!originalAcceptsStudentAction(state)) conflict();
        const ref = messageRef(event);
        const key = messageRefKey(ref);
        if (attemptMessageRefs.has(key)) conflict();
        attemptMessageRefs.add(key);
        state.original.attemptMessageRefs.push(ref);
        state.original.attemptEventIds.push(event.eventId);
        state.original.attemptCount += 1;
        break;
      }
      case 'hint_requested': {
        if (!phaseAcceptsHintRequest(state, event.phase)) conflict();
        const target = phaseState(state, event.phase);
        const ref = messageRef(event);
        const key = messageRefKey(ref);
        if (
          target.hintsIssued >= 3 ||
          target.pendingHintRequestEventId !== undefined ||
          hintRequestMessageRefs.has(key)
        ) {
          conflict();
        }
        hintRequestMessageRefs.add(key);
        target.hintRequestEventIds.push(event.eventId);
        target.pendingHintRequestEventId = event.eventId;
        break;
      }
      case 'hint_issued': {
        const request = referencedEvent(eventsById, event.requestEventId, 'hint_requested');
        const target = phaseState(state, event.phase);
        if (
          request.phase !== event.phase ||
          target.pendingHintRequestEventId !== request.eventId ||
          event.hintNumber !== target.hintsIssued + 1 ||
          target.hintsIssued >= 3
        ) {
          conflict();
        }
        target.pendingHintRequestEventId = undefined;
        target.hintIssuedEventIds.push(event.eventId);
        target.hintsIssued += 1;
        if (event.hintNumber === 3) target.keyHintUsed = true;
        break;
      }
      case 'full_solution_requested': {
        if (!originalAcceptsStudentAction(state)) conflict();
        const ref = messageRef(event);
        const key = messageRefKey(ref);
        if (fullSolutionRequestMessageRefs.has(key)) conflict();
        fullSolutionRequestMessageRefs.add(key);
        state.original.fullSolutionRequestEventIds.push(event.eventId);
        if (state.original.fullSolutionAvailable) {
          if (state.original.pendingFullSolutionRequestEventId !== undefined) conflict();
          state.original.pendingFullSolutionRequestEventId = event.eventId;
        }
        break;
      }
      case 'full_solution_revealed': {
        const request = referencedEvent(
          eventsById,
          event.requestEventId,
          'full_solution_requested',
        );
        if (
          request.phase !== 'original' ||
          !state.original.fullSolutionAvailable ||
          state.original.pendingFullSolutionRequestEventId !== request.eventId ||
          state.original.viewedFullAnswer
        ) {
          conflict();
        }
        state.original.pendingFullSolutionRequestEventId = undefined;
        state.original.viewedFullAnswer = true;
        break;
      }
      case 'presentation_failed': {
        if (event.presentationKind === 'hint') {
          const request = referencedEvent(eventsById, event.requestEventId, 'hint_requested');
          const target = phaseState(state, event.phase);
          if (
            request.phase !== event.phase ||
            target.pendingHintRequestEventId !== request.eventId
          ) {
            conflict();
          }
          target.pendingHintRequestEventId = undefined;
        } else {
          const request = referencedEvent(
            eventsById,
            event.requestEventId,
            'full_solution_requested',
          );
          if (
            event.phase !== 'original' ||
            request.phase !== 'original' ||
            state.original.pendingFullSolutionRequestEventId !== request.eventId ||
            state.original.viewedFullAnswer
          ) {
            conflict();
          }
          state.original.pendingFullSolutionRequestEventId = undefined;
        }
        break;
      }
      case 'original_resolved': {
        const attempt = referencedEvent(
          eventsById,
          event.attemptEventId,
          'student_attempt_submitted',
        );
        if (
          attempt.phase !== 'original' ||
          !state.original.attemptEventIds.includes(attempt.eventId) ||
          state.original.resolved ||
          state.original.pendingHintRequestEventId !== undefined
        ) {
          conflict();
        }
        state.original.resolved = true;
        state.original.resolutionEventId = event.eventId;
        state.original.outcome = event.outcome;
        break;
      }
      case 'transfer_question_assigned': {
        const resolution = referencedEvent(
          eventsById,
          event.originalResolvedEventId,
          'original_resolved',
        );
        if (
          !state.original.resolved ||
          state.original.resolutionEventId !== resolution.eventId ||
          state.transfer.assigned ||
          !sameIdentifierSet(state.knowledgePointIds, event.knowledgePointIds)
        ) {
          conflict();
        }
        state.transfer.assigned = true;
        state.transfer.assignmentEventId = event.eventId;
        state.transfer.transferQuestionId = event.transferQuestionId;
        break;
      }
      case 'transfer_answer_submitted': {
        if (
          !transferAcceptsStudentAction(state) ||
          event.transferQuestionId !== state.transfer.transferQuestionId
        ) {
          conflict();
        }
        const ref = messageRef(event);
        const key = messageRefKey(ref);
        if (attemptMessageRefs.has(key)) conflict();
        attemptMessageRefs.add(key);
        state.transfer.attemptMessageRefs.push(ref);
        state.transfer.attemptEventIds.push(event.eventId);
        state.transfer.submissionEventIds.push(event.eventId);
        state.transfer.attemptCount = 1;
        break;
      }
      case 'transfer_answer_evaluated': {
        const submission = referencedEvent(
          eventsById,
          event.submissionEventId,
          'transfer_answer_submitted',
        );
        if (
          state.transfer.attemptCount !== 1 ||
          state.transfer.evaluationEventId !== undefined ||
          submission.transferQuestionId !== event.transferQuestionId ||
          event.transferQuestionId !== state.transfer.transferQuestionId ||
          !state.transfer.submissionEventIds.includes(submission.eventId)
        ) {
          conflict();
        }
        state.transfer.evaluationEventId = event.eventId;
        state.transfer.outcome = event.outcome;
        break;
      }
      case 'study_attempts_projected': {
        const evaluation = referencedEvent(
          eventsById,
          event.evaluationEventId,
          'transfer_answer_evaluated',
        );
        if (
          state.transfer.evaluationEventId !== evaluation.eventId ||
          state.studyAttemptsProjected
        ) {
          conflict();
        }
        state.studyAttemptsProjected = true;
        state.projectionEventId = event.eventId;
        state.projectionRef = event.projectionRef;
        break;
      }
      case 'problem_abandoned':
        state.status = 'abandoned';
        break;
    }

    state.original.fullSolutionAvailable = isFullSolutionAvailable(state.original);
    state.status = derivedStatus(state);
    state.revision = record.seq;
    state.updatedAt = event.createdAt;
    eventsById.set(event.eventId, event);
    operationIds.add(event.operationId);
  }

  if (!state) return conflict();
  state.revision = ordered.length - 1;
  return state;
}
