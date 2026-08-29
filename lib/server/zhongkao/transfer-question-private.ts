import { Type } from 'typebox';
import { Value } from 'typebox/value';

import type { CurriculumClaimType } from '@/lib/zhongkao/curriculum';
import {
  TRANSFER_QUESTION_DIFFICULTIES,
  TRANSFER_QUESTION_DIFFICULTY_SCHEMA,
  TRANSFER_QUESTION_OPTION_MAX_ITEMS,
  TRANSFER_QUESTION_OPTION_MIN_ITEMS,
  TRANSFER_QUESTION_OPTION_SCHEMA,
  TRANSFER_QUESTION_SCHEMA_VERSION,
  TRANSFER_QUESTION_TEXT_MAX_LENGTH,
  isTransferQuestionType,
  validateTransferQuestionPublic,
  type TransferQuestionDifficulty,
  type TransferQuestionOption,
  type TransferQuestionPublic,
  type TransferQuestionType,
} from '@/lib/zhongkao/transfer-question';

const CLOSED = { additionalProperties: false } as const;
const CANONICAL_TEXT_PATTERN = '^(?:\\S|\\S[\\s\\S]*\\S)$';
const IDENTIFIER_PATTERN = '^[^\\s\\u0000-\\u001f\\u007f]{1,128}$';
const EXACT_ANSWER_MAX_LENGTH = 256;
const EXACT_ANSWER_MAX_ITEMS = 16;

const CLAIM_TYPES = [
  'publisher',
  'textbook_title',
  'volume',
  'chapter',
  'page',
  'regional_exam_scope',
  'regional_exam_policy',
  'source_attribution',
  'generic_knowledge_point',
] as const satisfies readonly CurriculumClaimType[];

const CandidateClaimSchema = Type.Object(
  {
    type: Type.Union(CLAIM_TYPES.map((type) => Type.Literal(type))),
  },
  CLOSED,
);

const CandidateKnowledgePointIdsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 128, pattern: IDENTIFIER_PATTERN }),
  { minItems: 1, maxItems: 32 },
);

const CandidateBase = {
  schemaVersion: Type.Literal(TRANSFER_QUESTION_SCHEMA_VERSION),
  question: Type.String({
    minLength: 1,
    maxLength: TRANSFER_QUESTION_TEXT_MAX_LENGTH,
    pattern: CANONICAL_TEXT_PATTERN,
  }),
  knowledgePointIds: CandidateKnowledgePointIdsSchema,
  difficulty: TRANSFER_QUESTION_DIFFICULTY_SCHEMA,
  claims: Type.Array(CandidateClaimSchema, { maxItems: CLAIM_TYPES.length }),
};

const CandidateOptionsSchema = Type.Array(TRANSFER_QUESTION_OPTION_SCHEMA, {
  minItems: TRANSFER_QUESTION_OPTION_MIN_ITEMS,
  maxItems: TRANSFER_QUESTION_OPTION_MAX_ITEMS,
});

const SingleChoiceCandidateSchema = Type.Object(
  {
    ...CandidateBase,
    type: Type.Literal('single_choice'),
    options: CandidateOptionsSchema,
    expectedAnswer: Type.Object(
      {
        correctOptionId: Type.String({
          minLength: 1,
          maxLength: 128,
          pattern: IDENTIFIER_PATTERN,
        }),
      },
      CLOSED,
    ),
  },
  CLOSED,
);

const MultipleChoiceCandidateSchema = Type.Object(
  {
    ...CandidateBase,
    type: Type.Literal('multiple_choice'),
    options: CandidateOptionsSchema,
    expectedAnswer: Type.Object(
      {
        correctOptionIds: Type.Array(
          Type.String({ minLength: 1, maxLength: 128, pattern: IDENTIFIER_PATTERN }),
          { minItems: 1, maxItems: TRANSFER_QUESTION_OPTION_MAX_ITEMS - 1 },
        ),
      },
      CLOSED,
    ),
  },
  CLOSED,
);

const NumericCandidateSchema = Type.Object(
  {
    ...CandidateBase,
    type: Type.Literal('numeric'),
    expectedAnswer: Type.Object(
      {
        expectedNumericValue: Type.Number(),
      },
      CLOSED,
    ),
  },
  CLOSED,
);

const ExactShortAnswerCandidateSchema = Type.Object(
  {
    ...CandidateBase,
    type: Type.Literal('exact_short_answer'),
    expectedAnswer: Type.Object(
      {
        acceptedAnswers: Type.Array(
          Type.String({
            minLength: 1,
            maxLength: EXACT_ANSWER_MAX_LENGTH,
            pattern: CANONICAL_TEXT_PATTERN,
          }),
          { minItems: 1, maxItems: EXACT_ANSWER_MAX_ITEMS },
        ),
      },
      CLOSED,
    ),
  },
  CLOSED,
);

/** Closed model-output schema. It deliberately has no trusted status or identity fields. */
export const TRANSFER_QUESTION_CANDIDATE_SCHEMA = Type.Union([
  SingleChoiceCandidateSchema,
  MultipleChoiceCandidateSchema,
  NumericCandidateSchema,
  ExactShortAnswerCandidateSchema,
]);

export type TransferQuestionCandidateClaim = { type: CurriculumClaimType };

interface TransferQuestionCandidateBase {
  schemaVersion: 1;
  type: TransferQuestionType;
  question: string;
  knowledgePointIds: string[];
  difficulty: TransferQuestionDifficulty;
  claims: TransferQuestionCandidateClaim[];
}

export interface TransferSingleChoiceCandidate extends TransferQuestionCandidateBase {
  type: 'single_choice';
  options: TransferQuestionOption[];
  expectedAnswer: { correctOptionId: string };
}

export interface TransferMultipleChoiceCandidate extends TransferQuestionCandidateBase {
  type: 'multiple_choice';
  options: TransferQuestionOption[];
  expectedAnswer: { correctOptionIds: string[] };
}

export interface TransferNumericCandidate extends TransferQuestionCandidateBase {
  type: 'numeric';
  expectedAnswer: { expectedNumericValue: number };
}

export interface TransferExactShortAnswerCandidate extends TransferQuestionCandidateBase {
  type: 'exact_short_answer';
  expectedAnswer: { acceptedAnswers: string[] };
}

export type TransferQuestionCandidate =
  | TransferSingleChoiceCandidate
  | TransferMultipleChoiceCandidate
  | TransferNumericCandidate
  | TransferExactShortAnswerCandidate;

export type TransferShortAnswerCaseMode = 'case_sensitive' | 'ascii_case_insensitive';

export type TransferQuestionGradingSpec =
  | {
      schemaVersion: 1;
      type: 'single_choice';
      optionIds: string[];
      correctOptionId: string;
    }
  | {
      schemaVersion: 1;
      type: 'multiple_choice';
      optionIds: string[];
      correctOptionIds: string[];
    }
  | {
      schemaVersion: 1;
      type: 'numeric';
      expectedNumericValue: number;
      tolerance: 0;
    }
  | {
      schemaVersion: 1;
      type: 'exact_short_answer';
      acceptedAnswers: string[];
      caseMode: TransferShortAnswerCaseMode;
    };

const GradingOptionIdsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 128, pattern: IDENTIFIER_PATTERN }),
  {
    minItems: TRANSFER_QUESTION_OPTION_MIN_ITEMS,
    maxItems: TRANSFER_QUESTION_OPTION_MAX_ITEMS,
  },
);

export const TRANSFER_QUESTION_GRADING_SPEC_SCHEMA = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      type: Type.Literal('single_choice'),
      optionIds: GradingOptionIdsSchema,
      correctOptionId: Type.String({ minLength: 1, maxLength: 128, pattern: IDENTIFIER_PATTERN }),
    },
    CLOSED,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      type: Type.Literal('multiple_choice'),
      optionIds: GradingOptionIdsSchema,
      correctOptionIds: Type.Array(
        Type.String({ minLength: 1, maxLength: 128, pattern: IDENTIFIER_PATTERN }),
        { minItems: 1, maxItems: TRANSFER_QUESTION_OPTION_MAX_ITEMS - 1 },
      ),
    },
    CLOSED,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      type: Type.Literal('numeric'),
      expectedNumericValue: Type.Number(),
      tolerance: Type.Literal(0),
    },
    CLOSED,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      type: Type.Literal('exact_short_answer'),
      acceptedAnswers: Type.Array(
        Type.String({ minLength: 1, maxLength: EXACT_ANSWER_MAX_LENGTH }),
        { minItems: 1, maxItems: EXACT_ANSWER_MAX_ITEMS },
      ),
      caseMode: Type.Union([
        Type.Literal('case_sensitive'),
        Type.Literal('ascii_case_insensitive'),
      ]),
    },
    CLOSED,
  ),
]);

export type TransferCandidateValidationReason =
  | 'SCHEMA_INVALID'
  | 'QUESTION_TYPE_UNSUPPORTED'
  | 'KNOWLEDGE_POINT_DUPLICATE'
  | 'KNOWLEDGE_POINT_UNAUTHORIZED'
  | 'DIFFICULTY_NOT_ALLOWED'
  | 'CLAIM_DUPLICATE'
  | 'OPTION_ID_DUPLICATE'
  | 'OPTION_TEXT_DUPLICATE'
  | 'ANSWER_KEY_INVALID'
  | 'ANSWER_KEY_DUPLICATE'
  | 'ALL_OPTIONS_CORRECT'
  | 'NUMERIC_ANSWER_INVALID'
  | 'SHORT_ANSWER_DUPLICATE';

export type TransferCandidateValidationResult =
  | {
      ok: true;
      candidate: TransferQuestionCandidate;
      gradingSpec: TransferQuestionGradingSpec;
    }
  | {
      ok: false;
      code: 'TRANSFER_QUESTION_INVALID' | 'TRANSFER_QUESTION_TYPE_UNSUPPORTED';
      reason: TransferCandidateValidationReason;
    };

export interface TransferCandidateValidationPolicy {
  allowedKnowledgePointIds: readonly string[];
  allowedDifficulties?: readonly TransferQuestionDifficulty[];
  subjectId?: string;
  shortAnswerCaseMode?: TransferShortAnswerCaseMode;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function canonicalOptionId(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

function optionIdsAreCanonical(optionIds: readonly string[]): boolean {
  return optionIds.every((optionId, index) => optionId === canonicalOptionId(index));
}

function canonicalDisplayText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

export function normalizeTransferExactAnswer(
  value: string,
  caseMode: TransferShortAnswerCaseMode,
): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return caseMode === 'ascii_case_insensitive'
    ? normalized.replace(/[A-Z]/gu, (character) => character.toLowerCase())
    : normalized;
}

function caseModeForPolicy(policy: TransferCandidateValidationPolicy): TransferShortAnswerCaseMode {
  if (policy.shortAnswerCaseMode) return policy.shortAnswerCaseMode;
  return policy.subjectId === 'english' ? 'ascii_case_insensitive' : 'case_sensitive';
}

function canonicalCandidate(value: TransferQuestionCandidate): TransferQuestionCandidate {
  const base = {
    schemaVersion: 1 as const,
    type: value.type,
    question: canonicalDisplayText(value.question),
    knowledgePointIds: [...value.knowledgePointIds].sort(),
    difficulty: value.difficulty,
    claims: value.claims.map((claim) => ({ type: claim.type })),
  };
  if (value.type === 'single_choice') {
    return {
      ...base,
      type: value.type,
      options: value.options.map((option) => ({
        id: option.id,
        text: canonicalDisplayText(option.text),
      })),
      expectedAnswer: { correctOptionId: value.expectedAnswer.correctOptionId },
    };
  }
  if (value.type === 'multiple_choice') {
    return {
      ...base,
      type: value.type,
      options: value.options.map((option) => ({
        id: option.id,
        text: canonicalDisplayText(option.text),
      })),
      expectedAnswer: { correctOptionIds: [...value.expectedAnswer.correctOptionIds] },
    };
  }
  if (value.type === 'numeric') {
    return {
      ...base,
      type: value.type,
      expectedAnswer: { expectedNumericValue: value.expectedAnswer.expectedNumericValue },
    };
  }
  return {
    ...base,
    type: value.type,
    expectedAnswer: {
      acceptedAnswers: value.expectedAnswer.acceptedAnswers.map(canonicalDisplayText),
    },
  };
}

function canonicalizeChoiceCandidate(
  candidate: TransferSingleChoiceCandidate | TransferMultipleChoiceCandidate,
): TransferSingleChoiceCandidate | TransferMultipleChoiceCandidate {
  const sourceToCanonicalId = new Map(
    candidate.options.map((option, index) => [option.id, canonicalOptionId(index)]),
  );
  const options = candidate.options.map((option, index) => ({
    id: canonicalOptionId(index),
    text: option.text,
  }));
  if (candidate.type === 'single_choice') {
    return {
      ...candidate,
      options,
      expectedAnswer: {
        correctOptionId: sourceToCanonicalId.get(candidate.expectedAnswer.correctOptionId)!,
      },
    };
  }

  const remappedCorrectIds = new Set(
    candidate.expectedAnswer.correctOptionIds.map((id) => sourceToCanonicalId.get(id)!),
  );
  return {
    ...candidate,
    options,
    expectedAnswer: {
      correctOptionIds: options
        .map((option) => option.id)
        .filter((id) => remappedCorrectIds.has(id)),
    },
  };
}

function failure(
  reason: TransferCandidateValidationReason,
  code:
    | 'TRANSFER_QUESTION_INVALID'
    | 'TRANSFER_QUESTION_TYPE_UNSUPPORTED' = 'TRANSFER_QUESTION_INVALID',
): TransferCandidateValidationResult {
  return { ok: false, code, reason };
}

export function validateTransferQuestionCandidate(
  value: unknown,
  policy: TransferCandidateValidationPolicy,
): TransferCandidateValidationResult {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'type') &&
    !isTransferQuestionType((value as { type?: unknown }).type)
  ) {
    return failure('QUESTION_TYPE_UNSUPPORTED', 'TRANSFER_QUESTION_TYPE_UNSUPPORTED');
  }
  if (!Value.Check(TRANSFER_QUESTION_CANDIDATE_SCHEMA, value)) {
    return failure('SCHEMA_INVALID');
  }

  const candidate = canonicalCandidate(value as TransferQuestionCandidate);
  if (!unique(candidate.knowledgePointIds)) return failure('KNOWLEDGE_POINT_DUPLICATE');
  const allowedKnowledgePointIds = new Set(policy.allowedKnowledgePointIds);
  if (
    allowedKnowledgePointIds.size === 0 ||
    candidate.knowledgePointIds.some((id) => !allowedKnowledgePointIds.has(id))
  ) {
    return failure('KNOWLEDGE_POINT_UNAUTHORIZED');
  }
  const allowedDifficulties = policy.allowedDifficulties ?? (['same'] as const);
  if (!allowedDifficulties.includes(candidate.difficulty)) {
    return failure('DIFFICULTY_NOT_ALLOWED');
  }
  if (!unique(candidate.claims.map((claim) => claim.type))) return failure('CLAIM_DUPLICATE');

  if (candidate.type === 'single_choice' || candidate.type === 'multiple_choice') {
    const optionIds = candidate.options.map((option) => option.id);
    if (!unique(optionIds)) return failure('OPTION_ID_DUPLICATE');
    if (!unique(candidate.options.map((option) => option.text))) {
      return failure('OPTION_TEXT_DUPLICATE');
    }
    if (candidate.type === 'single_choice') {
      const correctOptionId = candidate.expectedAnswer.correctOptionId;
      if (!optionIds.includes(correctOptionId)) return failure('ANSWER_KEY_INVALID');
      const canonical = canonicalizeChoiceCandidate(candidate) as TransferSingleChoiceCandidate;
      return {
        ok: true,
        candidate: canonical,
        gradingSpec: {
          schemaVersion: 1,
          type: 'single_choice',
          optionIds: canonical.options.map((option) => option.id),
          correctOptionId: canonical.expectedAnswer.correctOptionId,
        },
      };
    }

    const correctOptionIds = candidate.expectedAnswer.correctOptionIds;
    if (!unique(correctOptionIds)) return failure('ANSWER_KEY_DUPLICATE');
    if (correctOptionIds.some((id) => !optionIds.includes(id))) {
      return failure('ANSWER_KEY_INVALID');
    }
    if (correctOptionIds.length === optionIds.length) return failure('ALL_OPTIONS_CORRECT');
    const canonical = canonicalizeChoiceCandidate(candidate) as TransferMultipleChoiceCandidate;
    return {
      ok: true,
      candidate: canonical,
      gradingSpec: {
        schemaVersion: 1,
        type: 'multiple_choice',
        optionIds: canonical.options.map((option) => option.id),
        correctOptionIds: [...canonical.expectedAnswer.correctOptionIds],
      },
    };
  }

  if (candidate.type === 'numeric') {
    const expectedNumericValue = candidate.expectedAnswer.expectedNumericValue;
    if (
      !Number.isFinite(expectedNumericValue) ||
      (Number.isInteger(expectedNumericValue) && !Number.isSafeInteger(expectedNumericValue))
    ) {
      return failure('NUMERIC_ANSWER_INVALID');
    }
    return {
      ok: true,
      candidate,
      gradingSpec: {
        schemaVersion: 1,
        type: 'numeric',
        expectedNumericValue: candidate.expectedAnswer.expectedNumericValue,
        tolerance: 0,
      },
    };
  }

  const caseMode = caseModeForPolicy(policy);
  const acceptedAnswers = candidate.expectedAnswer.acceptedAnswers.map((answer) =>
    normalizeTransferExactAnswer(answer, caseMode),
  );
  if (!unique(acceptedAnswers)) return failure('SHORT_ANSWER_DUPLICATE');
  return {
    ok: true,
    candidate,
    gradingSpec: {
      schemaVersion: 1,
      type: 'exact_short_answer',
      acceptedAnswers,
      caseMode,
    },
  };
}

export function validateTransferQuestionGradingSpec(
  value: unknown,
): TransferQuestionGradingSpec | null {
  if (!Value.Check(TRANSFER_QUESTION_GRADING_SPEC_SCHEMA, value)) return null;
  const spec = value as TransferQuestionGradingSpec;
  if (spec.type === 'single_choice') {
    if (!optionIdsAreCanonical(spec.optionIds) || !spec.optionIds.includes(spec.correctOptionId)) {
      return null;
    }
    return { ...spec, optionIds: [...spec.optionIds] };
  }
  if (spec.type === 'multiple_choice') {
    if (
      !optionIdsAreCanonical(spec.optionIds) ||
      !unique(spec.correctOptionIds) ||
      spec.correctOptionIds.length >= spec.optionIds.length ||
      spec.correctOptionIds.some((id) => !spec.optionIds.includes(id))
    ) {
      return null;
    }
    return {
      ...spec,
      optionIds: [...spec.optionIds],
      correctOptionIds: [...spec.correctOptionIds],
    };
  }
  if (spec.type === 'numeric') {
    if (!Number.isFinite(spec.expectedNumericValue) || spec.tolerance !== 0) return null;
    return { ...spec };
  }
  const canonical = spec.acceptedAnswers.map((answer) =>
    normalizeTransferExactAnswer(answer, spec.caseMode),
  );
  if (
    !unique(canonical) ||
    canonical.some((answer, index) => answer !== spec.acceptedAnswers[index])
  ) {
    return null;
  }
  return { ...spec, acceptedAnswers: [...spec.acceptedAnswers] };
}

export function transferQuestionPublicFromCandidate(
  candidate: TransferQuestionCandidate,
  transferQuestionId: string,
): TransferQuestionPublic | null {
  const base = {
    schemaVersion: TRANSFER_QUESTION_SCHEMA_VERSION,
    transferQuestionId,
    type: candidate.type,
    question: candidate.question,
    knowledgePointIds: [...candidate.knowledgePointIds],
    difficulty: candidate.difficulty,
  } as const;
  const value =
    candidate.type === 'single_choice' || candidate.type === 'multiple_choice'
      ? {
          ...base,
          type: candidate.type,
          options: candidate.options.map((option) => ({ id: option.id, text: option.text })),
        }
      : { ...base, type: candidate.type };
  return validateTransferQuestionPublic(value);
}

export const TRANSFER_VERIFICATION_CHECK_NAMES = [
  'sameKnowledgePoint',
  'selfContained',
  'answerConsistent',
  'answerNotLeaked',
  'singleAnswerOrExactSet',
  'middleSchoolScope',
  'meaningfullyDifferent',
] as const;

export type TransferVerificationCheckName = (typeof TRANSFER_VERIFICATION_CHECK_NAMES)[number];
export type TransferVerificationChecks = Record<TransferVerificationCheckName, boolean>;

export const TRANSFER_VERIFICATION_REASON_CODES = [
  'KNOWLEDGE_POINT_MISMATCH',
  'NOT_SELF_CONTAINED',
  'ANSWER_INCONSISTENT',
  'ANSWER_LEAKED',
  'ANSWER_SET_AMBIGUOUS',
  'OUT_OF_SCOPE',
  'NOT_MEANINGFULLY_DIFFERENT',
  'OTHER_CHECK_FAILED',
] as const;

export type TransferVerificationReasonCode = (typeof TRANSFER_VERIFICATION_REASON_CODES)[number];

const VerificationChecksSchema = Type.Object(
  {
    sameKnowledgePoint: Type.Boolean(),
    selfContained: Type.Boolean(),
    answerConsistent: Type.Boolean(),
    answerNotLeaked: Type.Boolean(),
    singleAnswerOrExactSet: Type.Boolean(),
    middleSchoolScope: Type.Boolean(),
    meaningfullyDifferent: Type.Boolean(),
  },
  CLOSED,
);

export const TRANSFER_QUESTION_VERIFICATION_OUTPUT_SCHEMA = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      verdict: Type.Literal('accept'),
      checks: VerificationChecksSchema,
    },
    CLOSED,
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      verdict: Type.Literal('reject'),
      checks: VerificationChecksSchema,
      reasonCode: Type.Union(
        TRANSFER_VERIFICATION_REASON_CODES.map((reason) => Type.Literal(reason)),
      ),
    },
    CLOSED,
  ),
]);

export type TransferQuestionVerificationOutput =
  | { schemaVersion: 1; verdict: 'accept'; checks: TransferVerificationChecks }
  | {
      schemaVersion: 1;
      verdict: 'reject';
      checks: TransferVerificationChecks;
      reasonCode: TransferVerificationReasonCode;
    };

export function validateTransferQuestionVerificationOutput(
  value: unknown,
): TransferQuestionVerificationOutput | null {
  if (!Value.Check(TRANSFER_QUESTION_VERIFICATION_OUTPUT_SCHEMA, value)) return null;
  const output = value as TransferQuestionVerificationOutput;
  const checks = Object.fromEntries(
    TRANSFER_VERIFICATION_CHECK_NAMES.map((name) => [name, output.checks[name]]),
  ) as TransferVerificationChecks;
  return output.verdict === 'accept'
    ? { schemaVersion: 1, verdict: 'accept', checks }
    : { schemaVersion: 1, verdict: 'reject', checks, reasonCode: output.reasonCode };
}

export function transferVerificationAccepted(output: TransferQuestionVerificationOutput): boolean {
  return (
    output.verdict === 'accept' &&
    TRANSFER_VERIFICATION_CHECK_NAMES.every((name) => output.checks[name] === true)
  );
}

export interface TransferQuestionVerificationMetadata {
  schemaVersion: 1;
  status: 'verified';
  candidateFingerprint: string;
  verifierVersion: 1;
  checks: TransferVerificationChecks;
}

export interface VerifiedTransferQuestion {
  validationStatus: 'verified';
  validationRef: string;
  publicQuestion: TransferQuestionPublic;
  gradingSpec: TransferQuestionGradingSpec;
  verification: TransferQuestionVerificationMetadata;
}

export function isTransferQuestionDifficulty(value: unknown): value is TransferQuestionDifficulty {
  return (TRANSFER_QUESTION_DIFFICULTIES as readonly unknown[]).includes(value);
}

export const TRANSFER_EXACT_ANSWER_LIMITS = {
  maxLength: EXACT_ANSWER_MAX_LENGTH,
  maxItems: EXACT_ANSWER_MAX_ITEMS,
} as const;
