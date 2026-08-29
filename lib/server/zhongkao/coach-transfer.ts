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

const ORIGINAL_CHOICE_LINE = /^\s*([A-F])[.)\uFF0E\uFF09\u3001:\uFF1A]\s*(\S(?:.*\S)?)\s*$/u;

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
export function originalTransferQuestionFromText(questionText: string): {
  question: string;
  options?: { id: string; text: string }[];
} {
  const lines = questionText.replace(/\r\n?/gu, '\n').split('\n');
  while (lines.length > 0 && lines.at(-1)?.trim().length === 0) lines.pop();

  const reversedOptions: { id: string; text: string }[] = [];
  let optionStart = lines.length;
  while (optionStart > 0) {
    const match = ORIGINAL_CHOICE_LINE.exec(lines[optionStart - 1]!);
    if (!match) break;
    reversedOptions.push({ id: match[1]!, text: match[2]! });
    optionStart -= 1;
  }

  const options = reversedOptions.reverse();
  const sequential =
    options.length >= 3 &&
    options.length <= 6 &&
    options.every((option, index) => option.id === String.fromCharCode('A'.charCodeAt(0) + index));
  const stem = lines.slice(0, optionStart).join('\n').trim();
  if (!sequential || stem.length === 0) return { question: questionText };
  return { question: stem, options };
}

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
      originalQuestion: originalTransferQuestionFromText(original.questionText),
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
    evaluated.snapshot.state.status !== 'finalizing' ||
    evaluated.snapshot.state.studyAttemptsProjected
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
  return completedTransferEvaluation(evaluated, submission);
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
    return completedTransferEvaluation(
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
  return completedTransferEvaluation(evaluated, submission);
}
