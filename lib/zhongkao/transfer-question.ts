import { Type } from 'typebox';
import { Value } from 'typebox/value';

const CLOSED = { additionalProperties: false } as const;
const CANONICAL_TEXT_PATTERN = '^(?:\\S|\\S[\\s\\S]*\\S)$';
const IDENTIFIER_PATTERN = '^[^\\s\\u0000-\\u001f\\u007f]{1,128}$';

export const TRANSFER_QUESTION_SCHEMA_VERSION = 1 as const;
export const TRANSFER_QUESTION_TEXT_MAX_LENGTH = 4_000;
export const TRANSFER_QUESTION_OPTION_TEXT_MAX_LENGTH = 1_000;
export const TRANSFER_QUESTION_OPTION_MIN_ITEMS = 3;
export const TRANSFER_QUESTION_OPTION_MAX_ITEMS = 6;

export const TRANSFER_QUESTION_TYPES = [
  'single_choice',
  'multiple_choice',
  'numeric',
  'exact_short_answer',
] as const;

export type TransferQuestionType = (typeof TRANSFER_QUESTION_TYPES)[number];

export const TRANSFER_QUESTION_DIFFICULTIES = [
  'same',
  'slightly_easier',
  'slightly_harder',
] as const;

export type TransferQuestionDifficulty = (typeof TRANSFER_QUESTION_DIFFICULTIES)[number];

export const TRANSFER_QUESTION_DIFFICULTY_SCHEMA = Type.Union(
  TRANSFER_QUESTION_DIFFICULTIES.map((difficulty) => Type.Literal(difficulty)),
);

export const TRANSFER_QUESTION_OPTION_SCHEMA = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128, pattern: IDENTIFIER_PATTERN }),
    text: Type.String({
      minLength: 1,
      maxLength: TRANSFER_QUESTION_OPTION_TEXT_MAX_LENGTH,
      pattern: CANONICAL_TEXT_PATTERN,
    }),
  },
  CLOSED,
);

const TransferQuestionOptionsSchema = Type.Array(TRANSFER_QUESTION_OPTION_SCHEMA, {
  minItems: TRANSFER_QUESTION_OPTION_MIN_ITEMS,
  maxItems: TRANSFER_QUESTION_OPTION_MAX_ITEMS,
});

const KnowledgePointIdsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 128, pattern: IDENTIFIER_PATTERN }),
  { minItems: 1, maxItems: 32 },
);

const PublicBase = {
  schemaVersion: Type.Literal(TRANSFER_QUESTION_SCHEMA_VERSION),
  transferQuestionId: Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: IDENTIFIER_PATTERN,
  }),
  question: Type.String({
    minLength: 1,
    maxLength: TRANSFER_QUESTION_TEXT_MAX_LENGTH,
    pattern: CANONICAL_TEXT_PATTERN,
  }),
  knowledgePointIds: KnowledgePointIdsSchema,
  difficulty: TRANSFER_QUESTION_DIFFICULTY_SCHEMA,
};

export const TRANSFER_SINGLE_CHOICE_PUBLIC_SCHEMA = Type.Object(
  {
    ...PublicBase,
    type: Type.Literal('single_choice'),
    options: TransferQuestionOptionsSchema,
  },
  CLOSED,
);

export const TRANSFER_MULTIPLE_CHOICE_PUBLIC_SCHEMA = Type.Object(
  {
    ...PublicBase,
    type: Type.Literal('multiple_choice'),
    options: TransferQuestionOptionsSchema,
  },
  CLOSED,
);

export const TRANSFER_NUMERIC_PUBLIC_SCHEMA = Type.Object(
  {
    ...PublicBase,
    type: Type.Literal('numeric'),
  },
  CLOSED,
);

export const TRANSFER_EXACT_SHORT_ANSWER_PUBLIC_SCHEMA = Type.Object(
  {
    ...PublicBase,
    type: Type.Literal('exact_short_answer'),
  },
  CLOSED,
);

/** Closed, answer-free payload allowed to cross a student-visible boundary. */
export const TRANSFER_QUESTION_PUBLIC_SCHEMA = Type.Union([
  TRANSFER_SINGLE_CHOICE_PUBLIC_SCHEMA,
  TRANSFER_MULTIPLE_CHOICE_PUBLIC_SCHEMA,
  TRANSFER_NUMERIC_PUBLIC_SCHEMA,
  TRANSFER_EXACT_SHORT_ANSWER_PUBLIC_SCHEMA,
]);

export interface TransferQuestionOption {
  id: string;
  text: string;
}

interface TransferQuestionPublicBase {
  schemaVersion: 1;
  transferQuestionId: string;
  question: string;
  knowledgePointIds: string[];
  difficulty: TransferQuestionDifficulty;
}

export interface TransferSingleChoicePublic extends TransferQuestionPublicBase {
  type: 'single_choice';
  options: TransferQuestionOption[];
}

export interface TransferMultipleChoicePublic extends TransferQuestionPublicBase {
  type: 'multiple_choice';
  options: TransferQuestionOption[];
}

export interface TransferNumericPublic extends TransferQuestionPublicBase {
  type: 'numeric';
}

export interface TransferExactShortAnswerPublic extends TransferQuestionPublicBase {
  type: 'exact_short_answer';
}

export type TransferQuestionPublic =
  | TransferSingleChoicePublic
  | TransferMultipleChoicePublic
  | TransferNumericPublic
  | TransferExactShortAnswerPublic;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function optionIdsAreCanonical(options: readonly TransferQuestionOption[]): boolean {
  return options.every(
    (option, index) => option.id === String.fromCharCode('A'.charCodeAt(0) + index),
  );
}

function choiceSemanticsAreValid(
  value: TransferSingleChoicePublic | TransferMultipleChoicePublic,
): boolean {
  if (!optionIdsAreCanonical(value.options)) return false;
  const normalizedText = value.options.map((option) =>
    option.text.normalize('NFKC').trim().replace(/\s+/gu, ' '),
  );
  return unique(normalizedText);
}

/** Runtime-check and copy a public question before persistence or presentation. */
export function validateTransferQuestionPublic(value: unknown): TransferQuestionPublic | null {
  if (!Value.Check(TRANSFER_QUESTION_PUBLIC_SCHEMA, value)) return null;
  const question = value as TransferQuestionPublic;
  if (!unique(question.knowledgePointIds)) return null;
  if (
    (question.type === 'single_choice' || question.type === 'multiple_choice') &&
    !choiceSemanticsAreValid(question)
  ) {
    return null;
  }

  const base = {
    schemaVersion: TRANSFER_QUESTION_SCHEMA_VERSION,
    transferQuestionId: question.transferQuestionId,
    type: question.type,
    question: question.question,
    knowledgePointIds: [...question.knowledgePointIds],
    difficulty: question.difficulty,
  } as const;
  if (question.type === 'single_choice' || question.type === 'multiple_choice') {
    return {
      ...base,
      type: question.type,
      options: question.options.map((option) => ({ id: option.id, text: option.text })),
    } as TransferQuestionPublic;
  }
  return { ...base, type: question.type } as TransferQuestionPublic;
}

export function isTransferQuestionType(value: unknown): value is TransferQuestionType {
  return (TRANSFER_QUESTION_TYPES as readonly unknown[]).includes(value);
}
