import { CoachError } from '@/lib/zhongkao/coach-errors';
import type { TransferQuestionAssignedEvent } from '@/lib/zhongkao/coach-event';
import {
  validateTransferQuestionPublic,
  type TransferQuestionPublic,
} from '@/lib/zhongkao/transfer-question';

import { createCoachOperationFingerprint } from './coach-runtime';
import {
  TRANSFER_VERIFICATION_CHECK_NAMES,
  validateTransferQuestionGradingSpec,
  type TransferQuestionGradingSpec,
  type TransferQuestionVerificationMetadata,
  type VerifiedTransferQuestion,
} from './transfer-question-private';

export const TRANSFER_ASSIGNMENT_SCHEMA_VERSION = 1 as const;
export const TRANSFER_GENERATOR_SCHEMA_VERSION = 1 as const;

export interface TransferAssignmentPayload {
  publicQuestion: TransferQuestionPublic;
  gradingSpec: TransferQuestionGradingSpec;
  verification: TransferQuestionVerificationMetadata;
}

export interface VerifiedTransferAssignment extends TransferAssignmentPayload {
  validationRef: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function gradingMatchesQuestion(
  question: TransferQuestionPublic,
  gradingSpec: TransferQuestionGradingSpec,
): boolean {
  if (question.type !== gradingSpec.type) return false;
  if (question.type === 'single_choice' && gradingSpec.type === 'single_choice') {
    return sameStrings(
      question.options.map((option) => option.id),
      gradingSpec.optionIds,
    );
  }
  if (question.type === 'multiple_choice' && gradingSpec.type === 'multiple_choice') {
    return sameStrings(
      question.options.map((option) => option.id),
      gradingSpec.optionIds,
    );
  }
  return question.type === 'numeric' || question.type === 'exact_short_answer';
}

function copyVerification(value: unknown): TransferQuestionVerificationMetadata | null {
  if (!isRecord(value) || !isRecord(value.checks)) return null;
  const checks = value.checks;
  if (
    value.schemaVersion !== 1 ||
    value.status !== 'verified' ||
    value.verifierVersion !== 1 ||
    typeof value.candidateFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.candidateFingerprint) ||
    Object.keys(value).some(
      (key) =>
        !['schemaVersion', 'status', 'candidateFingerprint', 'verifierVersion', 'checks'].includes(
          key,
        ),
    ) ||
    Object.keys(checks).length !== TRANSFER_VERIFICATION_CHECK_NAMES.length ||
    !TRANSFER_VERIFICATION_CHECK_NAMES.every((name) => checks[name] === true)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    status: 'verified',
    candidateFingerprint: value.candidateFingerprint,
    verifierVersion: 1,
    checks: Object.fromEntries(
      TRANSFER_VERIFICATION_CHECK_NAMES.map((name) => [name, true]),
    ) as TransferQuestionVerificationMetadata['checks'],
  };
}

export function deriveTransferQuestionId(input: {
  coachSessionId: string;
  originalResolvedEventId: string;
}): string {
  const digest = createCoachOperationFingerprint({
    coachSessionId: input.coachSessionId,
    originalResolvedEventId: input.originalResolvedEventId,
    generatorSchemaVersion: TRANSFER_GENERATOR_SCHEMA_VERSION,
  });
  return `transfer-question:v${TRANSFER_GENERATOR_SCHEMA_VERSION}:${digest}`;
}

function deriveTransferValidationRef(input: {
  coachSessionId: string;
  originalResolvedEventId: string;
  payload: TransferAssignmentPayload;
}): string {
  const digest = createCoachOperationFingerprint({
    coachSessionId: input.coachSessionId,
    originalResolvedEventId: input.originalResolvedEventId,
    assignmentSchemaVersion: TRANSFER_ASSIGNMENT_SCHEMA_VERSION,
    publicQuestion: input.payload.publicQuestion,
    gradingSpec: input.payload.gradingSpec,
    verification: input.payload.verification,
  });
  return `transfer-validation:v${TRANSFER_ASSIGNMENT_SCHEMA_VERSION}:${digest}`;
}

function validatedPayload(value: unknown): TransferAssignmentPayload | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, 'publicQuestion') ||
    !Object.hasOwn(value, 'gradingSpec') ||
    !Object.hasOwn(value, 'verification')
  ) {
    return null;
  }
  const publicQuestion = validateTransferQuestionPublic(value.publicQuestion);
  const gradingSpec = validateTransferQuestionGradingSpec(value.gradingSpec);
  const verification = copyVerification(value.verification);
  if (
    !publicQuestion ||
    !gradingSpec ||
    !verification ||
    !gradingMatchesQuestion(publicQuestion, gradingSpec)
  ) {
    return null;
  }
  return { publicQuestion, gradingSpec, verification };
}

export function buildTransferAssignment(input: {
  coachSessionId: string;
  originalResolvedEventId: string;
  verifiedQuestion: VerifiedTransferQuestion;
}): VerifiedTransferAssignment {
  const expectedQuestionId = deriveTransferQuestionId(input);
  const payload = validatedPayload({
    publicQuestion: input.verifiedQuestion.publicQuestion,
    gradingSpec: input.verifiedQuestion.gradingSpec,
    verification: input.verifiedQuestion.verification,
  });
  if (!payload || payload.publicQuestion.transferQuestionId !== expectedQuestionId) {
    throw new CoachError('TRANSFER_QUESTION_NOT_VERIFIED');
  }
  return {
    ...payload,
    validationRef: deriveTransferValidationRef({ ...input, payload }),
  };
}

export function extractVerifiedTransferAssignment(
  event: TransferQuestionAssignedEvent,
): VerifiedTransferAssignment {
  if (
    event.assignmentSchemaVersion !== TRANSFER_ASSIGNMENT_SCHEMA_VERSION ||
    event.assignmentPayload === undefined
  ) {
    throw new CoachError('TRANSFER_QUESTION_NOT_VERIFIED');
  }
  const payload = validatedPayload(event.assignmentPayload);
  if (
    !payload ||
    payload.publicQuestion.transferQuestionId !== event.transferQuestionId ||
    !sameStrings(payload.publicQuestion.knowledgePointIds, event.knowledgePointIds) ||
    event.transferQuestionId !==
      deriveTransferQuestionId({
        coachSessionId: event.coachSessionId,
        originalResolvedEventId: event.originalResolvedEventId,
      }) ||
    event.validationRef !==
      deriveTransferValidationRef({
        coachSessionId: event.coachSessionId,
        originalResolvedEventId: event.originalResolvedEventId,
        payload,
      })
  ) {
    throw new CoachError('TRANSFER_QUESTION_NOT_VERIFIED');
  }
  return { ...payload, validationRef: event.validationRef };
}
