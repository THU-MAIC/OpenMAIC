import {
  normalizeTransferExactAnswer,
  validateTransferQuestionGradingSpec,
  type TransferQuestionGradingSpec,
} from './transfer-question-private';
import { CoachError } from '@/lib/zhongkao/coach-errors';

export const TRANSFER_ANSWER_MAX_LENGTH = 4_000;

export type ParsedTransferAnswer =
  | { type: 'single_choice'; optionId: string }
  | { type: 'multiple_choice'; optionIds: string[] }
  | { type: 'numeric'; numericValue: number }
  | { type: 'exact_short_answer'; normalizedAnswer: string };

export type TransferAnswerParseResult =
  | { ok: true; answer: ParsedTransferAnswer }
  | { ok: false; code: 'TRANSFER_ANSWER_INVALID' };

export interface TransferAnswerEvaluation {
  outcome: 'correct' | 'incorrect';
  parseStatus: 'valid' | 'invalid';
}

const INVALID: TransferAnswerParseResult = {
  ok: false,
  code: 'TRANSFER_ANSWER_INVALID',
};

function normalizedInput(value: string): string | null {
  if (typeof value !== 'string' || value.length > TRANSFER_ANSWER_MAX_LENGTH) return null;
  const normalized = value.normalize('NFKC').trim();
  return normalized.length > 0 ? normalized : null;
}

function displayLabel(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

/** Resolve an exact option id or one unambiguous server-rendered A/B/C label. */
function resolveChoiceToken(token: string, optionIds: readonly string[]): string | null {
  const matches = new Set<string>();
  if (optionIds.includes(token)) matches.add(token);

  if (/^[A-Za-z]$/u.test(token)) {
    const index = token.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
    if (index >= 0 && index < optionIds.length && displayLabel(index) === token.toUpperCase()) {
      matches.add(optionIds[index]!);
    }
  }

  return matches.size === 1 ? [...matches][0]! : null;
}

function parseSingleChoice(
  spec: Extract<TransferQuestionGradingSpec, { type: 'single_choice' }>,
  rawAnswer: string,
): TransferAnswerParseResult {
  const input = normalizedInput(rawAnswer);
  if (!input || /\s/u.test(input)) return INVALID;
  const optionId = resolveChoiceToken(input, spec.optionIds);
  return optionId ? { ok: true, answer: { type: 'single_choice', optionId } } : INVALID;
}

function parseMultipleChoice(
  spec: Extract<TransferQuestionGradingSpec, { type: 'multiple_choice' }>,
  rawAnswer: string,
): TransferAnswerParseResult {
  const input = normalizedInput(rawAnswer);
  if (!input) return INVALID;
  const tokens = input.split(/[\s,，;；、]+/u).filter(Boolean);
  if (tokens.length === 0) return INVALID;

  const optionIds = new Set<string>();
  for (const token of tokens) {
    const optionId = resolveChoiceToken(token, spec.optionIds);
    if (!optionId) return INVALID;
    optionIds.add(optionId);
  }
  const ordered = spec.optionIds.filter((optionId) => optionIds.has(optionId));
  return { ok: true, answer: { type: 'multiple_choice', optionIds: ordered } };
}

const DECIMAL_NUMBER = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u;

interface CanonicalDecimal {
  numericValue: number;
  canonicalValue: string;
}

function canonicalDecimal(rawAnswer: string): CanonicalDecimal | null {
  const input = normalizedInput(rawAnswer);
  if (!input || input.length > 128) return null;
  const match = DECIMAL_NUMBER.exec(input);
  if (!match) return null;

  const numericValue = Number(input);
  if (!Number.isFinite(numericValue)) return null;

  const integerDigits = match[2] ?? '';
  const fractionDigits = match[2] === undefined ? match[4]! : (match[3] ?? '');
  let digits = `${integerDigits}${fractionDigits}`.replace(/^0+/u, '');
  if (!digits) return { numericValue: 0, canonicalValue: '0' };

  let exponent = BigInt(match[5] ?? '0') - BigInt(fractionDigits.length);
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent += BigInt(1);
  }
  const sign = match[1] === '-' ? '-' : '';
  return {
    numericValue: Object.is(numericValue, -0) ? 0 : numericValue,
    canonicalValue: `${sign}${digits}e${exponent}`,
  };
}

function parseNumeric(rawAnswer: string): TransferAnswerParseResult {
  const parsed = canonicalDecimal(rawAnswer);
  if (!parsed) return INVALID;
  return {
    ok: true,
    answer: { type: 'numeric', numericValue: parsed.numericValue },
  };
}

function parseExactShortAnswer(
  spec: Extract<TransferQuestionGradingSpec, { type: 'exact_short_answer' }>,
  rawAnswer: string,
): TransferAnswerParseResult {
  const input = normalizedInput(rawAnswer);
  if (!input) return INVALID;
  const normalizedAnswer = normalizeTransferExactAnswer(input, spec.caseMode);
  if (!normalizedAnswer || normalizedAnswer.length > 256) return INVALID;
  return { ok: true, answer: { type: 'exact_short_answer', normalizedAnswer } };
}

/** Parse only the four explicitly supported formats. No expression or model evaluation occurs. */
export function parseTransferAnswer(
  gradingSpec: TransferQuestionGradingSpec,
  rawAnswer: string,
): TransferAnswerParseResult {
  const spec = validateTransferQuestionGradingSpec(gradingSpec);
  if (!spec) return INVALID;
  if (spec.type === 'single_choice') return parseSingleChoice(spec, rawAnswer);
  if (spec.type === 'multiple_choice') return parseMultipleChoice(spec, rawAnswer);
  if (spec.type === 'numeric') return parseNumeric(rawAnswer);
  return parseExactShortAnswer(spec, rawAnswer);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}

/** Invalid syntax is a deterministic incorrect outcome, preserving the one-submit lifecycle. */
export function evaluateTransferAnswer(
  gradingSpec: TransferQuestionGradingSpec,
  rawAnswer: string,
): TransferAnswerEvaluation {
  const spec = validateTransferQuestionGradingSpec(gradingSpec);
  if (!spec) throw new CoachError('TRANSFER_EVALUATION_FAILED');
  const parsed = parseTransferAnswer(spec, rawAnswer);
  if (!parsed.ok) return { outcome: 'incorrect', parseStatus: 'invalid' };

  let correct = false;
  if (spec.type === 'single_choice' && parsed.answer.type === 'single_choice') {
    correct = parsed.answer.optionId === spec.correctOptionId;
  } else if (spec.type === 'multiple_choice' && parsed.answer.type === 'multiple_choice') {
    correct = sameStringSet(parsed.answer.optionIds, spec.correctOptionIds);
  } else if (spec.type === 'numeric' && parsed.answer.type === 'numeric') {
    const submitted = canonicalDecimal(rawAnswer);
    const expected = canonicalDecimal(spec.expectedNumericValue.toString());
    correct =
      submitted !== null &&
      expected !== null &&
      submitted.canonicalValue === expected.canonicalValue;
  } else if (spec.type === 'exact_short_answer' && parsed.answer.type === 'exact_short_answer') {
    correct = spec.acceptedAnswers.includes(parsed.answer.normalizedAnswer);
  }

  return { outcome: correct ? 'correct' : 'incorrect', parseStatus: 'valid' };
}
