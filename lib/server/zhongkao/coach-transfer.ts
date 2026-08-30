import type { AICallFn } from '@openmaic/generation';

import { CoachError } from '@/lib/zhongkao/coach-errors';
import { assertCoachEvent, type CoachEvent } from '@/lib/zhongkao/coach-event';
import { directiveForCoachState } from '@/lib/zhongkao/coach-policy';
import {
  COACH_TRANSFER_RESULT_MESSAGES,
  type CoachTransferQuestionPresentation,
  type CoachTransferResultPresentation,
} from '@/lib/zhongkao/coach-public-presentation';
import { curriculumModeForSubject } from '@/lib/zhongkao/curriculum';
import { loadStudentProfile } from '@/lib/zhongkao/runtime';

import { resolveZhongkaoLearnerKeyFromOwnerId } from './learner-identity';
import { ensureStudyAttemptsProjected } from './coach-projection';
import {
  assignVerifiedTransferQuestion,
  getCoachProblemState,
  recordTransferEvaluation,
  type CoachServiceDeps,
} from './coach-service';
import { ensureFullSolutionResolution } from './coach-presentation';
import type { CoachRuntimeSnapshot } from './coach-runtime';
import {
  deriveTransferQuestionId,
  extractVerifiedTransferAssignment,
  type VerifiedTransferAssignment,
} from './transfer-assignment';
import { generateVerifiedTransferQuestion } from './transfer-question-generation';
import { structuredOriginalQuestionFromText } from './original-question';

export interface CoachTransferDependencies extends CoachServiceDeps {
  generationCall?: AICallFn;
  transferVerificationCall?: AICallFn;
  abortSignal?: AbortSignal;
}

export interface CoachTransferPresentationResult<TPresentation> {
  snapshot: CoachRuntimeSnapshot;
  presentation: TPresentation;
  replayed: boolean;
  eventAppended: boolean;
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
  const event = events(snapshot).find((candidate) => candidate.eventType === 'coach_started');
  if (!event || event.eventType !== 'coach_started') throw new CoachError('COACH_EVENT_CONFLICT');
  return event;
}

/**
 * Extract only an unambiguous trailing A-F choice block. Ambiguous text stays
 * intact so similarity checks never gain invented option structure.
 */
export const originalTransferQuestionFromText = structuredOriginalQuestionFromText;

function assignmentEvent(snapshot: CoachRuntimeSnapshot) {
  const eventId = snapshot.state.transfer.assignmentEventId;
  const event = eventId
    ? events(snapshot).find((candidate) => candidate.eventId === eventId)
    : undefined;
  if (!event || event.eventType !== 'transfer_question_assigned') {
    throw new CoachError('TRANSFER_QUESTION_REQUIRED');
  }
  return event;
}

function transferQuestionPresentation(
  assignment: VerifiedTransferAssignment,
): CoachTransferQuestionPresentation {
  const question = assignment.publicQuestion;
  return {
    kind: 'transfer_question',
    transferQuestionId: question.transferQuestionId,
    type: question.type,
    question: question.question,
    ...(question.type === 'single_choice' || question.type === 'multiple_choice'
      ? { options: question.options.map((option) => ({ ...option })) }
      : {}),
    difficulty: question.difficulty,
  } as CoachTransferQuestionPresentation;
}

function persistedTransferQuestion(
  snapshot: CoachRuntimeSnapshot,
): CoachTransferPresentationResult<CoachTransferQuestionPresentation> {
  const assignment = extractVerifiedTransferAssignment(assignmentEvent(snapshot));
  return {
    snapshot,
    presentation: transferQuestionPresentation(assignment),
    replayed: true,
    eventAppended: false,
  };
}

async function loadCurriculumMode(deps: CoachTransferDependencies, snapshot: CoachRuntimeSnapshot) {
  throwIfAborted(deps.abortSignal);
  const profile = await loadStudentProfile(snapshot.state.profileId, {
    store: deps.store,
    learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId),
  });
  throwIfAborted(deps.abortSignal);
  if (!profile) throw new CoachError('COACH_PROFILE_NOT_FOUND');
  return curriculumModeForSubject(profile, snapshot.state.subjectId);
}

/** Generate only from authoritative transfer-required state, persist, then expose public fields. */
export async function completeTransferQuestionGeneration(
  deps: CoachTransferDependencies,
  input: { profileId: string; coachSessionId: string },
): Promise<CoachTransferPresentationResult<CoachTransferQuestionPresentation>> {
  let snapshot = await getCoachProblemState(deps, input.profileId, input.coachSessionId);
  throwIfAborted(deps.abortSignal);
  if (snapshot.state.transfer.assigned) return persistedTransferQuestion(snapshot);
  if (!snapshot.state.original.resolved && snapshot.state.original.viewedFullAnswer) {
    const resolved = await ensureFullSolutionResolution(deps, snapshot);
    snapshot = resolved.snapshot;
    throwIfAborted(deps.abortSignal);
  }

  const originalResolvedEventId = snapshot.state.original.resolutionEventId;
  if (
    !snapshot.state.original.resolved ||
    !originalResolvedEventId ||
    snapshot.state.status === 'abandoned' ||
    snapshot.state.status === 'completed' ||
    directiveForCoachState(snapshot.state) !== 'GENERATE_TRANSFER_QUESTION'
  ) {
    throw new CoachError('COACH_ACTION_NOT_ALLOWED');
  }

  const original = startEvent(snapshot);
  const transferQuestionId = deriveTransferQuestionId({
    coachSessionId: snapshot.state.coachSessionId,
    originalResolvedEventId,
  });
  const curriculumMode = await loadCurriculumMode(deps, snapshot);
  const generated = await generateVerifiedTransferQuestion(
    {
      generateCandidate: deps.generationCall,
      verifyCandidate: deps.transferVerificationCall ?? deps.generationCall,
    },
    {
      transferQuestionId,
      subjectId: snapshot.state.subjectId,
      originalQuestion: structuredOriginalQuestionFromText(original.questionText),
      allowedKnowledgePointIds: snapshot.state.knowledgePointIds,
      curriculumMode,
      allowedDifficulties: ['same'],
    },
    deps.abortSignal,
  );
  throwIfAborted(deps.abortSignal);

  let assigned;
  try {
    assigned = await assignVerifiedTransferQuestion(deps, {
      profileId: input.profileId,
      coachSessionId: input.coachSessionId,
      expectedRevision: snapshot.state.revision,
      originalResolvedEventId,
      verifiedQuestion: generated,
    });
  } catch (error) {
    // A competing exact causal assignment wins. Never regenerate or expose the losing candidate.
    try {
      snapshot = await getCoachProblemState(deps, input.profileId, input.coachSessionId);
      if (snapshot.state.transfer.assigned) return persistedTransferQuestion(snapshot);
    } catch {
      // Preserve the original append error when durable reconciliation also fails.
    }
    throw error;
  }
  throwIfAborted(deps.abortSignal);
  const persisted = extractVerifiedTransferAssignment(assignmentEvent(assigned.snapshot));
  return {
    snapshot: assigned.snapshot,
    presentation: transferQuestionPresentation(persisted),
    replayed: assigned.replayed,
    eventAppended: assigned.eventAppended,
  };
}

function transferResultPresentation(
  outcome: 'correct' | 'incorrect',
): CoachTransferResultPresentation {
  return outcome === 'correct'
    ? {
        kind: 'transfer_result',
        outcome: 'correct',
        message: COACH_TRANSFER_RESULT_MESSAGES.correct,
      }
    : {
        kind: 'transfer_result',
        outcome: 'incorrect',
        message: COACH_TRANSFER_RESULT_MESSAGES.incorrect,
      };
}

function completedTransferEvaluation(
  evaluated: Awaited<ReturnType<typeof recordTransferEvaluation>>,
  submission: Extract<CoachEvent, { eventType: 'transfer_answer_submitted' }>,
): CoachTransferPresentationResult<CoachTransferResultPresentation> {
  const evaluation = events(evaluated.snapshot).find(
    (event) =>
      event.eventType === 'transfer_answer_evaluated' &&
      event.submissionEventId === submission.eventId,
  );
  if (
    !evaluation ||
    evaluation.eventType !== 'transfer_answer_evaluated' ||
    evaluation.transferQuestionId !== submission.transferQuestionId ||
    (evaluated.snapshot.state.status !== 'finalizing' &&
      evaluated.snapshot.state.status !== 'completed') ||
    (evaluated.snapshot.state.status === 'finalizing' &&
      evaluated.snapshot.state.studyAttemptsProjected) ||
    (evaluated.snapshot.state.status === 'completed' &&
      !evaluated.snapshot.state.studyAttemptsProjected)
  ) {
    throw new CoachError('TRANSFER_EVALUATION_FAILED');
  }
  return {
    snapshot: evaluated.snapshot,
    presentation: transferResultPresentation(evaluation.outcome),
    replayed: evaluated.replayed,
    eventAppended: evaluated.eventAppended,
  };
}

async function projectCompletedTransferEvaluation(
  deps: CoachTransferDependencies,
  input: { profileId: string; coachSessionId: string },
  evaluated: Awaited<ReturnType<typeof recordTransferEvaluation>>,
  submission: Extract<CoachEvent, { eventType: 'transfer_answer_submitted' }>,
): Promise<CoachTransferPresentationResult<CoachTransferResultPresentation>> {
  const result = completedTransferEvaluation(evaluated, submission);
  const projected = await ensureStudyAttemptsProjected(deps, input);
  return {
    snapshot: projected.snapshot,
    presentation: result.presentation,
    replayed: result.replayed && projected.replayed,
    eventAppended: result.eventAppended || projected.eventAppended,
  };
}

function exactSubmissionForTurn(
  deps: CoachTransferDependencies,
  snapshot: CoachRuntimeSnapshot,
  userMessageSeq: number,
) {
  const matches = events(snapshot).filter(
    (event) =>
      event.eventType === 'transfer_answer_submitted' &&
      event.agentSessionId === deps.agentSessionId &&
      event.sourceUserMessageSeq === userMessageSeq,
  );
  if (matches.length !== 1 || matches[0]?.eventType !== 'transfer_answer_submitted') {
    throw new CoachError('TRANSFER_EVALUATION_FAILED');
  }
  return matches[0];
}

/** Evaluate the exact durable submission and publish only the persisted binary outcome. */
export async function completeTransferAnswerEvaluation(
  deps: CoachTransferDependencies,
  input: { profileId: string; coachSessionId: string; userMessageSeq: number },
): Promise<CoachTransferPresentationResult<CoachTransferResultPresentation>> {
  const snapshot = await getCoachProblemState(deps, input.profileId, input.coachSessionId);
  throwIfAborted(deps.abortSignal);
  const submission = exactSubmissionForTurn(deps, snapshot, input.userMessageSeq);
  const evaluated = await recordTransferEvaluation(deps, {
    profileId: input.profileId,
    coachSessionId: input.coachSessionId,
    expectedRevision: snapshot.state.revision,
    submissionEventId: submission.eventId,
  });
  throwIfAborted(deps.abortSignal);
  return projectCompletedTransferEvaluation(deps, input, evaluated, submission);
}

/**
 * Repair the crash window after a durable transfer submission but before its
 * deterministic evaluation. This path deliberately has no user-turn input.
 */
export async function completePendingTransferAnswerEvaluation(
  deps: CoachTransferDependencies,
  input: { profileId: string; coachSessionId: string },
): Promise<CoachTransferPresentationResult<CoachTransferResultPresentation> | undefined> {
  const snapshot = await getCoachProblemState(deps, input.profileId, input.coachSessionId);
  throwIfAborted(deps.abortSignal);
  if (snapshot.state.transfer.submissionEventIds.length === 0) return undefined;
  if (
    snapshot.state.transfer.attemptCount !== 1 ||
    snapshot.state.transfer.submissionEventIds.length !== 1
  ) {
    throw new CoachError('TRANSFER_EVALUATION_FAILED');
  }

  const submissionEventId = snapshot.state.transfer.submissionEventIds[0]!;
  const submission = events(snapshot).find((event) => event.eventId === submissionEventId);
  if (!submission || submission.eventType !== 'transfer_answer_submitted') {
    throw new CoachError('TRANSFER_EVALUATION_FAILED');
  }
  if (snapshot.state.transfer.evaluationEventId !== undefined) {
    return projectCompletedTransferEvaluation(
      deps,
      input,
      { snapshot, replayed: true, eventAppended: false },
      submission,
    );
  }
  const evaluated = await recordTransferEvaluation(deps, {
    profileId: input.profileId,
    coachSessionId: input.coachSessionId,
    expectedRevision: snapshot.state.revision,
    submissionEventId: submission.eventId,
  });
  throwIfAborted(deps.abortSignal);
  return projectCompletedTransferEvaluation(deps, input, evaluated, submission);
}
