import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation';

export const EXAM_ERROR_SUGGESTION_SCHEMA_VERSION = 1 as const;
export const EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS = 'candidate' as const;
export const EXAM_ERROR_OBSERVABLE_RULES_VERSION = 'exam-error-observable-rules:v1' as const;
export const EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION = 'exam-error-diagnosis-generator:v1' as const;
export const EXAM_ERROR_MODEL_POLICY_VERSION = 'exam-error-model-policy:v1' as const;

export const EXAM_ERROR_SUGGESTION_KINDS = [
  'blank_response_observation_candidate',
  'no_response_observation_candidate',
  'response_format_mismatch_candidate',
  'single_choice_option_mismatch_candidate',
  'multiple_choice_set_mismatch_candidate',
  'numeric_sign_mismatch_candidate',
  'numeric_value_mismatch_candidate',
  'unit_error_candidate',
] as const;

export const EXAM_ERROR_SUGGESTION_GENERATION_SOURCES = [
  'deterministic_candidate',
  'model_candidate',
] as const;

export const EXAM_ERROR_SUGGESTION_CONFIDENCE_BANDS = ['high', 'medium', 'low'] as const;

export const EXAM_ERROR_SUGGESTION_LIMITS = Object.freeze({
  maxQuestions: 500,
  maxSuggestionsPerQuestion: 3,
  maxCombinedDraftsBeforeDedupe: 6,
  maxEvidenceItemsPerSuggestion: 3,
  maxEvidenceTextChars: 256,
  maxChoiceOptions: 6,
});

export type ExamErrorSuggestionKind = (typeof EXAM_ERROR_SUGGESTION_KINDS)[number];
export type ExamErrorSuggestionGenerationSource =
  (typeof EXAM_ERROR_SUGGESTION_GENERATION_SOURCES)[number];
export type ExamErrorSuggestionConfidenceBand =
  (typeof EXAM_ERROR_SUGGESTION_CONFIDENCE_BANDS)[number];
export type ExamErrorSuggestionGradingType =
  | 'single_choice'
  | 'multiple_choice'
  | 'numeric'
  | 'exact_short_answer';
export type ExamErrorSuggestionGenerationStatus = 'generated' | 'no_suggestion' | 'input_too_large';

export type ExamErrorSuggestionEvidenceV1 =
  | {
      evidenceType: 'response_status';
      status: 'blank' | 'no_response';
    }
  | {
      evidenceType: 'option_set_difference';
      missingOptions: string[];
      extraOptions: string[];
    }
  | {
      evidenceType: 'numeric_difference';
      differenceKind: 'opposite_sign' | 'different_value';
    }
  | {
      evidenceType: 'format_observation';
      gradingType: ExamErrorSuggestionGradingType;
      parseStatus: 'invalid';
    }
  | {
      evidenceType: 'text_span';
      source: 'question' | 'parent_context' | 'response';
      text: string;
    };

export interface ExamErrorSuggestionDraftV1 {
  kind: ExamErrorSuggestionKind;
  generationSource: ExamErrorSuggestionGenerationSource;
  candidateStatus: typeof EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS;
  confidenceBand: ExamErrorSuggestionConfidenceBand;
  evidence: ExamErrorSuggestionEvidenceV1[];
}

export interface ExamErrorSuggestionCandidateV1 extends ExamErrorSuggestionDraftV1 {
  candidateId: string;
  ordinal: number;
}

export interface ExamErrorSuggestionQuestionDraftV1 {
  confirmedQuestionId: string;
  assessmentOutcome: 'incorrect';
  generationStatus: ExamErrorSuggestionGenerationStatus;
  suggestions: ExamErrorSuggestionDraftV1[];
}

export type PublicExamErrorSuggestionCandidateV1 = Omit<ExamErrorSuggestionCandidateV1, 'ordinal'>;

export interface PublicExamErrorSuggestionQuestionV1 {
  confirmedQuestionId: string;
  questionText: string;
  parentContext?: { questionText: string };
  confirmedResponse:
    | { answerStatus: 'text'; rawAnswerText: string }
    | { answerStatus: 'blank' | 'no_response' };
  assessmentOutcome: 'incorrect';
  generationStatus: ExamErrorSuggestionGenerationStatus;
  suggestions: PublicExamErrorSuggestionCandidateV1[];
}

export interface PublicExamErrorSuggestionsBundleV1 {
  schemaVersion: typeof EXAM_ERROR_SUGGESTION_SCHEMA_VERSION;
  examSessionId: string;
  subjectId: string;
  candidateStatus: typeof EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS;
  questions: PublicExamErrorSuggestionQuestionV1[];
}

export class ExamErrorSuggestionValidationError extends Error {
  override readonly name = 'ExamErrorSuggestionValidationError';
  readonly code = 'EXAM_ERROR_SUGGESTION_INPUT_INVALID' as const;

  constructor() {
    super('EXAM_ERROR_SUGGESTION_INPUT_INVALID');
  }
}

const DRAFT_KEYS = new Set([
  'kind',
  'generationSource',
  'candidateStatus',
  'confidenceBand',
  'evidence',
]);
const CANDIDATE_KEYS = new Set([...DRAFT_KEYS, 'candidateId', 'ordinal']);
const QUESTION_DRAFT_KEYS = new Set([
  'confirmedQuestionId',
  'assessmentOutcome',
  'generationStatus',
  'suggestions',
]);
const RESPONSE_STATUS_KEYS = new Set(['evidenceType', 'status']);
const OPTION_DIFFERENCE_KEYS = new Set(['evidenceType', 'missingOptions', 'extraOptions']);
const NUMERIC_DIFFERENCE_KEYS = new Set(['evidenceType', 'differenceKind']);
const FORMAT_OBSERVATION_KEYS = new Set(['evidenceType', 'gradingType', 'parseStatus']);
const TEXT_SPAN_KEYS = new Set(['evidenceType', 'source', 'text']);
const CHOICE_OPTIONS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

function isKind(value: unknown): value is ExamErrorSuggestionKind {
  return (EXAM_ERROR_SUGGESTION_KINDS as readonly unknown[]).includes(value);
}

function isGenerationSource(value: unknown): value is ExamErrorSuggestionGenerationSource {
  return (EXAM_ERROR_SUGGESTION_GENERATION_SOURCES as readonly unknown[]).includes(value);
}

function isConfidenceBand(value: unknown): value is ExamErrorSuggestionConfidenceBand {
  return (EXAM_ERROR_SUGGESTION_CONFIDENCE_BANDS as readonly unknown[]).includes(value);
}

function isGradingType(value: unknown): value is ExamErrorSuggestionGradingType {
  return (
    value === 'single_choice' ||
    value === 'multiple_choice' ||
    value === 'numeric' ||
    value === 'exact_short_answer'
  );
}

function compareOptions(left: string, right: string): number {
  return (
    CHOICE_OPTIONS.indexOf(left as (typeof CHOICE_OPTIONS)[number]) -
    CHOICE_OPTIONS.indexOf(right as (typeof CHOICE_OPTIONS)[number])
  );
}

function canonicalOptionSet(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): string[] {
  if (!Array.isArray(value) || value.length > EXAM_ERROR_SUGGESTION_LIMITS.maxChoiceOptions) {
    pushIssue(errors, path, 'expected bounded option array');
    return [];
  }
  const options: string[] = [];
  for (const [index, option] of value.entries()) {
    if (!(CHOICE_OPTIONS as readonly unknown[]).includes(option)) {
      pushIssue(errors, `${path}/${index}`, 'expected canonical A-F option');
    } else {
      options.push(option as string);
    }
  }
  if (new Set(options).size !== options.length) pushIssue(errors, path, 'duplicate option');
  return options.sort(compareOptions);
}

function evidenceKeys(type: unknown): ReadonlySet<string> {
  if (type === 'response_status') return RESPONSE_STATUS_KEYS;
  if (type === 'option_set_difference') return OPTION_DIFFERENCE_KEYS;
  if (type === 'numeric_difference') return NUMERIC_DIFFERENCE_KEYS;
  if (type === 'format_observation') return FORMAT_OBSERVATION_KEYS;
  if (type === 'text_span') return TEXT_SPAN_KEYS;
  return new Set(['evidenceType']);
}

function canonicalEvidence(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): ExamErrorSuggestionEvidenceV1 | null {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected evidence object');
    return null;
  }
  rejectUnknownKeys(value, evidenceKeys(value.evidenceType), path, errors);
  if (value.evidenceType === 'response_status') {
    if (value.status !== 'blank' && value.status !== 'no_response') {
      pushIssue(errors, `${path}/status`, 'unknown response status');
      return null;
    }
    return { evidenceType: value.evidenceType, status: value.status };
  }
  if (value.evidenceType === 'option_set_difference') {
    const missingOptions = canonicalOptionSet(
      value.missingOptions,
      `${path}/missingOptions`,
      errors,
    );
    const extraOptions = canonicalOptionSet(value.extraOptions, `${path}/extraOptions`, errors);
    if (missingOptions.length + extraOptions.length === 0) {
      pushIssue(errors, path, 'option difference cannot be empty');
    }
    if (missingOptions.some((option) => extraOptions.includes(option))) {
      pushIssue(errors, path, 'missing and extra options must be disjoint');
    }
    return { evidenceType: value.evidenceType, missingOptions, extraOptions };
  }
  if (value.evidenceType === 'numeric_difference') {
    if (value.differenceKind !== 'opposite_sign' && value.differenceKind !== 'different_value') {
      pushIssue(errors, `${path}/differenceKind`, 'unknown numeric difference');
      return null;
    }
    return { evidenceType: value.evidenceType, differenceKind: value.differenceKind };
  }
  if (value.evidenceType === 'format_observation') {
    if (!isGradingType(value.gradingType)) {
      pushIssue(errors, `${path}/gradingType`, 'unknown grading type');
      return null;
    }
    if (value.parseStatus !== 'invalid') {
      pushIssue(errors, `${path}/parseStatus`, 'format observation must be invalid');
      return null;
    }
    return {
      evidenceType: value.evidenceType,
      gradingType: value.gradingType,
      parseStatus: value.parseStatus,
    };
  }
  if (value.evidenceType === 'text_span') {
    if (
      (value.source !== 'question' &&
        value.source !== 'parent_context' &&
        value.source !== 'response') ||
      typeof value.text !== 'string' ||
      value.text.length === 0 ||
      value.text.length > EXAM_ERROR_SUGGESTION_LIMITS.maxEvidenceTextChars ||
      value.text !== value.text.trim() ||
      UNSAFE_TEXT.test(value.text) ||
      UNPAIRED_SURROGATE.test(value.text)
    ) {
      pushIssue(errors, path, 'invalid grounded text span');
      return null;
    }
    return { evidenceType: value.evidenceType, source: value.source, text: value.text };
  }
  pushIssue(errors, `${path}/evidenceType`, 'unknown evidence type');
  return null;
}

function evidenceSortKey(value: ExamErrorSuggestionEvidenceV1): string {
  return JSON.stringify(value);
}

function requiredCoreEvidence(kind: ExamErrorSuggestionKind): {
  evidenceType: ExamErrorSuggestionEvidenceV1['evidenceType'];
  value?: string;
} {
  if (kind === 'blank_response_observation_candidate') {
    return { evidenceType: 'response_status', value: 'blank' };
  }
  if (kind === 'no_response_observation_candidate') {
    return { evidenceType: 'response_status', value: 'no_response' };
  }
  if (kind === 'response_format_mismatch_candidate') {
    return { evidenceType: 'format_observation' };
  }
  if (
    kind === 'single_choice_option_mismatch_candidate' ||
    kind === 'multiple_choice_set_mismatch_candidate'
  ) {
    return { evidenceType: 'option_set_difference' };
  }
  if (kind === 'numeric_sign_mismatch_candidate') {
    return { evidenceType: 'numeric_difference', value: 'opposite_sign' };
  }
  if (kind === 'unit_error_candidate') return { evidenceType: 'text_span' };
  return { evidenceType: 'numeric_difference', value: 'different_value' };
}

function evidenceMatchesKind(
  kind: ExamErrorSuggestionKind,
  evidence: readonly ExamErrorSuggestionEvidenceV1[],
): boolean {
  const core = requiredCoreEvidence(kind);
  const structured = evidence.filter((item) => item.evidenceType !== 'text_span');
  if (kind === 'unit_error_candidate') {
    const spans = evidence.filter(
      (item): item is Extract<ExamErrorSuggestionEvidenceV1, { evidenceType: 'text_span' }> =>
        item.evidenceType === 'text_span',
    );
    return (
      spans.length === evidence.length &&
      spans.some((item) => item.source === 'question' || item.source === 'parent_context') &&
      spans.some((item) => item.source === 'response')
    );
  }
  if (structured.length !== 1 || structured[0]!.evidenceType !== core.evidenceType) return false;
  const item = structured[0]!;
  if (
    core.value !== undefined &&
    !(
      (item.evidenceType === 'response_status' && item.status === core.value) ||
      (item.evidenceType === 'numeric_difference' && item.differenceKind === core.value)
    )
  ) {
    return false;
  }
  if (kind === 'single_choice_option_mismatch_candidate') {
    return (
      item.evidenceType === 'option_set_difference' &&
      item.missingOptions.length === 1 &&
      item.extraOptions.length === 1
    );
  }
  return true;
}

function canonicalDraft(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): ExamErrorSuggestionDraftV1 | null {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected suggestion draft object');
    return null;
  }
  rejectUnknownKeys(value, DRAFT_KEYS, path, errors);
  if (!isKind(value.kind)) pushIssue(errors, `${path}/kind`, 'unknown candidate kind');
  if (!isGenerationSource(value.generationSource)) {
    pushIssue(errors, `${path}/generationSource`, 'unknown generation source');
  }
  if (value.candidateStatus !== EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS) {
    pushIssue(errors, `${path}/candidateStatus`, 'error suggestion must remain a candidate');
  }
  if (!isConfidenceBand(value.confidenceBand)) {
    pushIssue(errors, `${path}/confidenceBand`, 'unknown confidence band');
  }
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length < 1 ||
    value.evidence.length > EXAM_ERROR_SUGGESTION_LIMITS.maxEvidenceItemsPerSuggestion
  ) {
    pushIssue(errors, `${path}/evidence`, 'expected bounded non-empty evidence array');
    return null;
  }
  const evidence = value.evidence
    .map((item, index) => canonicalEvidence(item, `${path}/evidence/${index}`, errors))
    .filter((item): item is ExamErrorSuggestionEvidenceV1 => item !== null)
    .sort((left, right) => evidenceSortKey(left).localeCompare(evidenceSortKey(right), 'en'));
  if (new Set(evidence.map(evidenceSortKey)).size !== evidence.length) {
    pushIssue(errors, `${path}/evidence`, 'duplicate evidence');
  }
  if (isKind(value.kind) && !evidenceMatchesKind(value.kind, evidence)) {
    pushIssue(errors, `${path}/evidence`, 'evidence does not support candidate kind');
  }
  if (value.kind === 'unit_error_candidate' && value.generationSource !== 'model_candidate') {
    pushIssue(errors, `${path}/generationSource`, 'unit error is model-review only');
  }
  if (
    !isKind(value.kind) ||
    !isGenerationSource(value.generationSource) ||
    !isConfidenceBand(value.confidenceBand)
  ) {
    return null;
  }
  return {
    kind: value.kind,
    generationSource: value.generationSource,
    candidateStatus: EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS,
    confidenceBand: value.confidenceBand,
    evidence,
  };
}

export function validateExamErrorSuggestionDraft(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  canonicalDraft(value, '', errors);
  return finishValidation(errors);
}

export function parseExamErrorSuggestionDraft(value: unknown): ExamErrorSuggestionDraftV1 {
  const errors: DomainValidationIssue[] = [];
  const draft = canonicalDraft(value, '', errors);
  if (!draft || errors.length > 0) throw new ExamErrorSuggestionValidationError();
  return draft;
}

function canonicalCandidate(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): ExamErrorSuggestionCandidateV1 | null {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected suggestion candidate object');
    return null;
  }
  rejectUnknownKeys(value, CANDIDATE_KEYS, path, errors);
  const draft = canonicalDraft(
    {
      kind: value.kind,
      generationSource: value.generationSource,
      candidateStatus: value.candidateStatus,
      confidenceBand: value.confidenceBand,
      evidence: value.evidence,
    },
    path,
    errors,
  );
  validateIdentifier(value.candidateId, `${path}/candidateId`, errors);
  if (
    !Number.isSafeInteger(value.ordinal) ||
    (value.ordinal as number) < 0 ||
    (value.ordinal as number) >= EXAM_ERROR_SUGGESTION_LIMITS.maxSuggestionsPerQuestion
  ) {
    pushIssue(errors, `${path}/ordinal`, 'invalid candidate ordinal');
  }
  if (!draft || typeof value.candidateId !== 'string' || !Number.isSafeInteger(value.ordinal)) {
    return null;
  }
  return {
    ...draft,
    candidateId: value.candidateId,
    ordinal: value.ordinal as number,
  };
}

export function validateExamErrorSuggestionCandidate(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  canonicalCandidate(value, '', errors);
  return finishValidation(errors);
}

export function parseExamErrorSuggestionCandidate(value: unknown): ExamErrorSuggestionCandidateV1 {
  const errors: DomainValidationIssue[] = [];
  const candidate = canonicalCandidate(value, '', errors);
  if (!candidate || errors.length > 0) throw new ExamErrorSuggestionValidationError();
  return candidate;
}

function confidenceRank(value: ExamErrorSuggestionConfidenceBand): number {
  return value === 'high' ? 0 : value === 'medium' ? 1 : 2;
}

function draftSemanticKey(value: ExamErrorSuggestionDraftV1): string {
  return JSON.stringify({ kind: value.kind, evidence: value.evidence });
}

function preferDraft(
  left: ExamErrorSuggestionDraftV1,
  right: ExamErrorSuggestionDraftV1,
): ExamErrorSuggestionDraftV1 {
  if (left.generationSource !== right.generationSource) {
    return left.generationSource === 'deterministic_candidate' ? left : right;
  }
  return confidenceRank(left.confidenceBand) <= confidenceRank(right.confidenceBand) ? left : right;
}

export function canonicalizeExamErrorSuggestionDrafts(
  value: unknown,
): ExamErrorSuggestionDraftV1[] {
  if (
    !Array.isArray(value) ||
    value.length > EXAM_ERROR_SUGGESTION_LIMITS.maxCombinedDraftsBeforeDedupe
  ) {
    throw new ExamErrorSuggestionValidationError();
  }
  const bySemanticKey = new Map<string, ExamErrorSuggestionDraftV1>();
  for (const raw of value) {
    const draft = parseExamErrorSuggestionDraft(raw);
    const key = draftSemanticKey(draft);
    const existing = bySemanticKey.get(key);
    bySemanticKey.set(key, existing ? preferDraft(existing, draft) : draft);
  }
  const drafts = [...bySemanticKey.values()].sort((left, right) =>
    draftSemanticKey(left).localeCompare(draftSemanticKey(right), 'en'),
  );
  if (drafts.length > EXAM_ERROR_SUGGESTION_LIMITS.maxSuggestionsPerQuestion) {
    throw new ExamErrorSuggestionValidationError();
  }
  return drafts;
}

function canonicalQuestionDraft(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): ExamErrorSuggestionQuestionDraftV1 | null {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected question draft object');
    return null;
  }
  rejectUnknownKeys(value, QUESTION_DRAFT_KEYS, path, errors);
  validateIdentifier(value.confirmedQuestionId, `${path}/confirmedQuestionId`, errors);
  if (value.assessmentOutcome !== 'incorrect') {
    pushIssue(
      errors,
      `${path}/assessmentOutcome`,
      'error suggestions require incorrect assessment',
    );
  }
  if (
    value.generationStatus !== 'generated' &&
    value.generationStatus !== 'no_suggestion' &&
    value.generationStatus !== 'input_too_large'
  ) {
    pushIssue(errors, `${path}/generationStatus`, 'unknown generation status');
  }
  let suggestions: ExamErrorSuggestionDraftV1[] = [];
  try {
    suggestions = canonicalizeExamErrorSuggestionDrafts(value.suggestions);
  } catch {
    pushIssue(errors, `${path}/suggestions`, 'invalid suggestions');
  }
  if (
    (value.generationStatus === 'generated' && suggestions.length === 0) ||
    (value.generationStatus !== 'generated' && suggestions.length !== 0)
  ) {
    pushIssue(errors, `${path}/suggestions`, 'generation status does not match suggestions');
  }
  if (
    typeof value.confirmedQuestionId !== 'string' ||
    value.assessmentOutcome !== 'incorrect' ||
    (value.generationStatus !== 'generated' &&
      value.generationStatus !== 'no_suggestion' &&
      value.generationStatus !== 'input_too_large')
  ) {
    return null;
  }
  return {
    confirmedQuestionId: value.confirmedQuestionId,
    assessmentOutcome: value.assessmentOutcome,
    generationStatus: value.generationStatus,
    suggestions,
  };
}

export function validateExamErrorSuggestionQuestionDraft(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  canonicalQuestionDraft(value, '', errors);
  return finishValidation(errors);
}

export function parseExamErrorSuggestionQuestionDraft(
  value: unknown,
): ExamErrorSuggestionQuestionDraftV1 {
  const errors: DomainValidationIssue[] = [];
  const draft = canonicalQuestionDraft(value, '', errors);
  if (!draft || errors.length > 0) throw new ExamErrorSuggestionValidationError();
  return draft;
}

export function canonicalizeExamErrorSuggestionQuestionDrafts(
  value: unknown,
): ExamErrorSuggestionQuestionDraftV1[] {
  if (!Array.isArray(value) || value.length > EXAM_ERROR_SUGGESTION_LIMITS.maxQuestions) {
    throw new ExamErrorSuggestionValidationError();
  }
  const drafts = value
    .map(parseExamErrorSuggestionQuestionDraft)
    .sort((left, right) => left.confirmedQuestionId.localeCompare(right.confirmedQuestionId, 'en'));
  if (new Set(drafts.map((draft) => draft.confirmedQuestionId)).size !== drafts.length) {
    throw new ExamErrorSuggestionValidationError();
  }
  return drafts;
}

export function isExamErrorSuggestionTextSpanGrounded(
  evidence: Extract<ExamErrorSuggestionEvidenceV1, { evidenceType: 'text_span' }>,
  sources: {
    questionText: string;
    parentContext?: string;
    responseText?: string;
  },
): boolean {
  const source =
    evidence.source === 'question'
      ? sources.questionText
      : evidence.source === 'parent_context'
        ? sources.parentContext
        : sources.responseText;
  return typeof source === 'string' && source.includes(evidence.text);
}
