import { createHash } from 'node:crypto';

import {
  EXAM_MAX_KNOWLEDGE_SUGGESTION_ARTIFACT_BYTES,
  EXAM_MAX_KNOWLEDGE_SUGGESTIONS_PER_QUESTION,
  EXAM_MAX_QUESTION_CANDIDATES,
} from '@/lib/zhongkao/exam';
import {
  serializeConfirmedExamReviewFacts,
  validateConfirmedExamReviewFacts,
  type ConfirmedExamQuestionV1,
  type ConfirmedExamReviewFactsV1,
} from '@/lib/zhongkao/exam-human-review';
import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  type DomainValidationIssue,
  type DomainValidationResult,
} from '@/lib/zhongkao/validation';

import {
  createExamKnowledgeCandidatePoolFingerprint,
  parseExamKnowledgeCandidatePool,
  validateExamKnowledgeCandidatePool,
  type ExamKnowledgeCandidatePoolV1,
} from './exam-knowledge-candidate-pool';
import type { ExamConfirmedReviewSourceV1 } from './exam-grading-private';
import {
  deriveExamKnowledgeSuggestionsArtifactRef as deriveRuntimeKnowledgeSuggestionsArtifactRef,
  deriveExamKnowledgeSuggestionsGenerationRef as deriveRuntimeKnowledgeSuggestionsGenerationRef,
  type ExamKnowledgeSuggestionsGenerationRefInput,
} from './exam-runtime';

export const EXAM_KNOWLEDGE_SUGGESTION_SCHEMA_VERSION = 1 as const;
export const EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_VERSION = 1 as const;
export const EXAM_KNOWLEDGE_SUGGESTION_GENERATION_VERSION = 1 as const;
export const EXAM_KNOWLEDGE_SUGGESTION_GENERATION_SOURCE = 'model_candidate' as const;
export const EXAM_KNOWLEDGE_SUGGESTION_CANDIDATE_STATUS = 'candidate' as const;

export const EXAM_KNOWLEDGE_SUGGESTION_LIMITS = Object.freeze({
  maxQuestions: EXAM_MAX_QUESTION_CANDIDATES,
  maxSuggestionsPerQuestion: EXAM_MAX_KNOWLEDGE_SUGGESTIONS_PER_QUESTION,
  maxEvidencePhrasesPerSuggestion: 3,
  maxProposedLabelLength: 128,
  maxEvidencePhraseLength: 256,
  maxArtifactBytes: EXAM_MAX_KNOWLEDGE_SUGGESTION_ARTIFACT_BYTES,
});

export type ExamKnowledgeSuggestionGenerationStatus =
  | 'generated'
  | 'no_suggestion'
  | 'input_too_large';
export type ExamKnowledgeSuggestionConfidenceBand = 'high' | 'medium' | 'low';

export type ExamKnowledgeSuggestionDraftV1 =
  | {
      kind: 'existing_knowledge_point';
      knowledgePointId: string;
      confidenceBand: ExamKnowledgeSuggestionConfidenceBand;
      evidencePhrases: string[];
    }
  | {
      kind: 'proposed_label';
      proposedLabel: string;
      confidenceBand: ExamKnowledgeSuggestionConfidenceBand;
      evidencePhrases: string[];
    };

export interface ExamKnowledgeSuggestionQuestionDraftV1 {
  confirmedQuestionId: string;
  questionText: string;
  parentContext?: { questionText: string };
  generationStatus: ExamKnowledgeSuggestionGenerationStatus;
  suggestions: ExamKnowledgeSuggestionDraftV1[];
}

export type ExamKnowledgeSuggestionCandidateV1 =
  | (Extract<ExamKnowledgeSuggestionDraftV1, { kind: 'existing_knowledge_point' }> & {
      candidateId: string;
      ordinal: number;
    })
  | (Extract<ExamKnowledgeSuggestionDraftV1, { kind: 'proposed_label' }> & {
      candidateId: string;
      ordinal: number;
    });

export interface ExamKnowledgeSuggestionQuestionV1 {
  confirmedQuestionId: string;
  generationStatus: ExamKnowledgeSuggestionGenerationStatus;
  suggestions: ExamKnowledgeSuggestionCandidateV1[];
}

export interface ExamKnowledgeSuggestionGeneratorV1 {
  generatorVersion: string;
  candidateSchemaVersion: number;
}

export interface ExamKnowledgeSuggestionsArtifactV1 {
  schemaVersion: typeof EXAM_KNOWLEDGE_SUGGESTION_SCHEMA_VERSION;
  artifactVersion: typeof EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_VERSION;
  generationVersion: typeof EXAM_KNOWLEDGE_SUGGESTION_GENERATION_VERSION;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  generationRef: string;
  suggestionArtifactRef: string;
  generationSource: typeof EXAM_KNOWLEDGE_SUGGESTION_GENERATION_SOURCE;
  candidateStatus: typeof EXAM_KNOWLEDGE_SUGGESTION_CANDIDATE_STATUS;
  sourceReview: ExamConfirmedReviewSourceV1;
  pool: ExamKnowledgeCandidatePoolV1;
  generator: ExamKnowledgeSuggestionGeneratorV1;
  semanticFingerprint: string;
  questionCount: number;
  generatedQuestionCount: number;
  noSuggestionQuestionCount: number;
  inputTooLargeQuestionCount: number;
  suggestionCount: number;
  questions: ExamKnowledgeSuggestionQuestionV1[];
}

export type ExamKnowledgeSuggestionArtifactV1 = ExamKnowledgeSuggestionsArtifactV1;

export type PublicExamKnowledgeSuggestionCandidateV1 = Omit<
  ExamKnowledgeSuggestionCandidateV1,
  'ordinal'
>;

export interface PublicExamKnowledgeSuggestionQuestionV1 {
  confirmedQuestionId: string;
  questionText: string;
  parentContext?: { questionText: string };
  generationStatus: ExamKnowledgeSuggestionGenerationStatus;
  suggestions: PublicExamKnowledgeSuggestionCandidateV1[];
}

export interface PublicExamKnowledgeSuggestionsBundleV1 {
  schemaVersion: typeof EXAM_KNOWLEDGE_SUGGESTION_SCHEMA_VERSION;
  examSessionId: string;
  subjectId: string;
  candidateStatus: typeof EXAM_KNOWLEDGE_SUGGESTION_CANDIDATE_STATUS;
  questions: PublicExamKnowledgeSuggestionQuestionV1[];
}

export type ExamKnowledgeSuggestionsPrivateErrorCode =
  | 'EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID'
  | 'EXAM_KNOWLEDGE_SUGGESTION_INCOMPLETE'
  | 'EXAM_KNOWLEDGE_SUGGESTION_SOURCE_INVALID'
  | 'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT';

export class ExamKnowledgeSuggestionsPrivateError extends Error {
  override readonly name = 'ExamKnowledgeSuggestionsPrivateError';

  constructor(readonly code: ExamKnowledgeSuggestionsPrivateErrorCode) {
    super(code);
  }
}

export const ExamKnowledgeSuggestionPrivateError = ExamKnowledgeSuggestionsPrivateError;
export type ExamKnowledgeSuggestionPrivateErrorCode = ExamKnowledgeSuggestionsPrivateErrorCode;

const SHA256 = /^[a-f0-9]{64}$/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const UNSAFE_SUGGESTION_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MARKUP_PATTERNS: readonly RegExp[] = [
  /<\/?[a-z][^>]*>/iu,
  /!?\[[^\]\r\n]*\]\([^\)\r\n]*\)/u,
  /`{1,3}|~~~/u,
  /(?:^|\n)\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/u,
  /\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~/u,
];
const UNSUPPORTED_PROVENANCE_PATTERNS: readonly RegExp[] = [
  /(?:出版社|人教版|苏教版|北师大版|沪教版|鲁教版|粤教版|浙教版|教材|教科书|课本)/iu,
  /第\s*[\p{Number}一二三四五六七八九十百]+\s*(?:册|章|节|页)/iu,
  /(?:官方|权威发布|课程标准|考试大纲|考纲|考试政策)/iu,
  /(?:[\p{Script=Han}]{1,12}(?:省|市|区|县)|地区|区域)\s*(?:中考|考纲|教材|考试|命题)/iu,
  /(?:中考|初中学业水平考试)(?:考纲|大纲|范围|政策|真题|原题|试题|第\s*\d+\s*题)?/iu,
  /(?:本题\s*)?(?:选自|来自|改编自|摘自)/iu,
  /\b(?:official|authentic|publisher|textbook|syllabus)\b/iu,
  /\b(?:regional|district|provincial|municipal)\s+(?:exam|curriculum|syllabus|policy)\b/iu,
  /\b(?:chapter|page)\s*(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/iu,
];
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const REVIEW_SOURCE_KEYS = new Set([
  'reviewRef',
  'reviewArtifactRef',
  'reviewArtifactSha256',
  'reviewVersion',
  'reviewArtifactVersion',
  'decisionSemanticFingerprint',
]);
const GENERATOR_KEYS = new Set(['generatorVersion', 'candidateSchemaVersion']);
const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactVersion',
  'generationVersion',
  'examSessionId',
  'profileId',
  'subjectId',
  'generationRef',
  'suggestionArtifactRef',
  'generationSource',
  'candidateStatus',
  'sourceReview',
  'pool',
  'generator',
  'semanticFingerprint',
  'questionCount',
  'generatedQuestionCount',
  'noSuggestionQuestionCount',
  'inputTooLargeQuestionCount',
  'suggestionCount',
  'questions',
]);
const DRAFT_QUESTION_KEYS = new Set([
  'confirmedQuestionId',
  'questionText',
  'parentContext',
  'generationStatus',
  'suggestions',
]);
const ARTIFACT_QUESTION_KEYS = new Set(['confirmedQuestionId', 'generationStatus', 'suggestions']);
const PARENT_CONTEXT_KEYS = new Set(['questionText']);
const EXISTING_SUGGESTION_KEYS = new Set([
  'candidateId',
  'ordinal',
  'kind',
  'knowledgePointId',
  'confidenceBand',
  'evidencePhrases',
]);
const PROPOSED_SUGGESTION_KEYS = new Set([
  'candidateId',
  'ordinal',
  'kind',
  'proposedLabel',
  'confidenceBand',
  'evidencePhrases',
]);
const EXISTING_DRAFT_KEYS = new Set([
  'kind',
  'knowledgePointId',
  'confidenceBand',
  'evidencePhrases',
]);
const PROPOSED_DRAFT_KEYS = new Set(['kind', 'proposedLabel', 'confidenceBand', 'evidencePhrases']);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function fingerprint(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareQuestionId(
  left: { confirmedQuestionId: string },
  right: { confirmedQuestionId: string },
): number {
  return left.confirmedQuestionId < right.confirmedQuestionId
    ? -1
    : left.confirmedQuestionId > right.confirmedQuestionId
      ? 1
      : 0;
}

function validCount(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

export function normalizeExamKnowledgeSuggestionText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function hasUnsafeExamKnowledgeSuggestionText(value: string): boolean {
  return UNSAFE_SUGGESTION_TEXT.test(value) || UNPAIRED_SURROGATE.test(value);
}

export function examKnowledgeSuggestionTextContainsMarkup(value: string): boolean {
  return MARKUP_PATTERNS.some((pattern) => pattern.test(value));
}

export function examKnowledgeSuggestionLabelHasUnsupportedProvenance(value: string): boolean {
  return UNSUPPORTED_PROVENANCE_PATTERNS.some((pattern) => pattern.test(value));
}

export function isSafeExamKnowledgeSuggestionProposedLabel(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return (
    value.length > 0 &&
    value === normalizeExamKnowledgeSuggestionText(value) &&
    value.length <= EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxProposedLabelLength &&
    !hasUnsafeExamKnowledgeSuggestionText(value) &&
    !examKnowledgeSuggestionTextContainsMarkup(value) &&
    !examKnowledgeSuggestionLabelHasUnsupportedProvenance(value)
  );
}

export function isSafeExamKnowledgeSuggestionEvidencePhrase(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return (
    value.trim().length > 0 &&
    value === value.trim() &&
    value.length <= EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxEvidencePhraseLength &&
    !hasUnsafeExamKnowledgeSuggestionText(value) &&
    !examKnowledgeSuggestionTextContainsMarkup(value)
  );
}

function reviewSourceFromFacts(
  review: ConfirmedExamReviewFactsV1,
  reviewArtifactSha256: string,
): ExamConfirmedReviewSourceV1 {
  return {
    reviewRef: review.reviewRef,
    reviewArtifactRef: review.reviewArtifactRef,
    reviewArtifactSha256,
    reviewVersion: review.reviewVersion,
    reviewArtifactVersion: review.artifactVersion,
    decisionSemanticFingerprint: review.decisionSemanticFingerprint,
  };
}

function cloneReviewSource(source: ExamConfirmedReviewSourceV1): ExamConfirmedReviewSourceV1 {
  return { ...source };
}

function validateReviewSource(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamConfirmedReviewSourceV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected confirmed review source object');
    return false;
  }
  rejectUnknownKeys(value, REVIEW_SOURCE_KEYS, path, errors);
  validateIdentifier(value.reviewRef, `${path}/reviewRef`, errors);
  validateIdentifier(value.reviewArtifactRef, `${path}/reviewArtifactRef`, errors);
  if (!validSha256(value.reviewArtifactSha256)) {
    pushIssue(errors, `${path}/reviewArtifactSha256`, 'expected lowercase SHA-256');
  }
  for (const field of ['reviewVersion', 'reviewArtifactVersion'] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 1) {
      pushIssue(errors, `${path}/${field}`, 'expected positive safe integer');
    }
  }
  if (!validSha256(value.decisionSemanticFingerprint)) {
    pushIssue(errors, `${path}/decisionSemanticFingerprint`, 'expected lowercase SHA-256');
  }
  return errors.length === before;
}

function validateGenerator(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is ExamKnowledgeSuggestionGeneratorV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected generator version object');
    return false;
  }
  rejectUnknownKeys(value, GENERATOR_KEYS, path, errors);
  validateIdentifier(value.generatorVersion, `${path}/generatorVersion`, errors);
  if (
    typeof value.candidateSchemaVersion !== 'number' ||
    !Number.isSafeInteger(value.candidateSchemaVersion) ||
    value.candidateSchemaVersion < 1
  ) {
    pushIssue(errors, `${path}/candidateSchemaVersion`, 'expected positive safe integer');
  }
  return errors.length === before;
}

function expectedParentContext(
  question: ConfirmedExamQuestionV1,
): { questionText: string } | undefined {
  return question.parentContext ? { questionText: question.parentContext.questionText } : undefined;
}

function parentContextEqual(
  left: { questionText: string } | undefined,
  right: { questionText: string } | undefined,
): boolean {
  return left?.questionText === right?.questionText && Boolean(left) === Boolean(right);
}

function canonicalizeDraftSuggestion(value: unknown): ExamKnowledgeSuggestionDraftV1 | undefined {
  if (!isPlainRecord(value)) return undefined;
  const allowedKeys =
    value.kind === 'existing_knowledge_point'
      ? EXISTING_DRAFT_KEYS
      : value.kind === 'proposed_label'
        ? PROPOSED_DRAFT_KEYS
        : undefined;
  if (!allowedKeys || Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined;
  if (
    value.confidenceBand !== 'high' &&
    value.confidenceBand !== 'medium' &&
    value.confidenceBand !== 'low'
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.evidencePhrases) ||
    value.evidencePhrases.length > EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxEvidencePhrasesPerSuggestion
  ) {
    return undefined;
  }
  const evidencePhrases = [...value.evidencePhrases].sort();
  if (!evidencePhrases.every(isSafeExamKnowledgeSuggestionEvidencePhrase)) return undefined;
  if (new Set(evidencePhrases).size !== evidencePhrases.length) return undefined;
  if (value.kind === 'existing_knowledge_point') {
    const errors: DomainValidationIssue[] = [];
    if (!validateIdentifier(value.knowledgePointId, '/knowledgePointId', errors)) return undefined;
    return {
      kind: 'existing_knowledge_point',
      knowledgePointId: value.knowledgePointId,
      confidenceBand: value.confidenceBand,
      evidencePhrases,
    };
  }
  if (
    typeof value.proposedLabel !== 'string' ||
    hasUnsafeExamKnowledgeSuggestionText(value.proposedLabel)
  ) {
    return undefined;
  }
  const proposedLabel = normalizeExamKnowledgeSuggestionText(value.proposedLabel);
  if (!isSafeExamKnowledgeSuggestionProposedLabel(proposedLabel)) return undefined;
  return {
    kind: 'proposed_label',
    proposedLabel,
    confidenceBand: value.confidenceBand,
    evidencePhrases,
  };
}

function suggestionTargetKey(suggestion: ExamKnowledgeSuggestionDraftV1): string {
  return suggestion.kind === 'existing_knowledge_point'
    ? `0:${suggestion.knowledgePointId}`
    : `1:${suggestion.proposedLabel.toLocaleLowerCase('en-US')}`;
}

function canonicalizeQuestionDraft(
  value: unknown,
  sourceQuestion: ConfirmedExamQuestionV1,
  pool: ExamKnowledgeCandidatePoolV1,
): ExamKnowledgeSuggestionQuestionDraftV1 | undefined {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !DRAFT_QUESTION_KEYS.has(key))) {
    return undefined;
  }
  if (
    value.confirmedQuestionId !== sourceQuestion.confirmedQuestionId ||
    value.questionText !== sourceQuestion.questionText ||
    (value.generationStatus !== 'generated' &&
      value.generationStatus !== 'no_suggestion' &&
      value.generationStatus !== 'input_too_large') ||
    !Array.isArray(value.suggestions) ||
    value.suggestions.length > EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxSuggestionsPerQuestion
  ) {
    return undefined;
  }
  const parentContext = isPlainRecord(value.parentContext)
    ? { questionText: value.parentContext.questionText }
    : undefined;
  if (
    Object.hasOwn(value, 'parentContext') !== Boolean(parentContext) ||
    (parentContext &&
      (Object.keys(value.parentContext as Record<string, unknown>).some(
        (key) => !PARENT_CONTEXT_KEYS.has(key),
      ) ||
        typeof parentContext.questionText !== 'string')) ||
    !parentContextEqual(
      parentContext as { questionText: string } | undefined,
      expectedParentContext(sourceQuestion),
    )
  ) {
    return undefined;
  }
  if (
    (value.generationStatus === 'generated' && value.suggestions.length === 0) ||
    (value.generationStatus !== 'generated' && value.suggestions.length !== 0)
  ) {
    return undefined;
  }
  const suggestions = value.suggestions.map(canonicalizeDraftSuggestion);
  if (suggestions.some((suggestion) => !suggestion)) return undefined;
  const canonicalSuggestions = suggestions as ExamKnowledgeSuggestionDraftV1[];
  const sourceTexts = [
    sourceQuestion.questionText,
    sourceQuestion.parentContext?.questionText,
  ].filter((text): text is string => typeof text === 'string');
  if (
    canonicalSuggestions.some((suggestion) =>
      suggestion.evidencePhrases.some(
        (phrase) => !sourceTexts.some((sourceText) => sourceText.includes(phrase)),
      ),
    )
  ) {
    return undefined;
  }
  const targets = canonicalSuggestions.map(suggestionTargetKey);
  if (new Set(targets).size !== targets.length) return undefined;
  const allowedIds = new Set(pool.knowledgePointIds);
  if (
    canonicalSuggestions.some(
      (suggestion) =>
        suggestion.kind === 'existing_knowledge_point' &&
        (pool.mode !== 'observed_existing_ids' || !allowedIds.has(suggestion.knowledgePointId)),
    )
  ) {
    return undefined;
  }
  canonicalSuggestions.sort((left, right) => {
    const leftTarget = suggestionTargetKey(left);
    const rightTarget = suggestionTargetKey(right);
    return leftTarget < rightTarget ? -1 : leftTarget > rightTarget ? 1 : 0;
  });
  return {
    confirmedQuestionId: sourceQuestion.confirmedQuestionId,
    questionText: sourceQuestion.questionText,
    ...(parentContext ? { parentContext: parentContext as { questionText: string } } : {}),
    generationStatus: value.generationStatus,
    suggestions: canonicalSuggestions,
  };
}

export function deriveExamKnowledgeSuggestionsGenerationRef(
  input: ExamKnowledgeSuggestionsGenerationRefInput,
): string {
  return deriveRuntimeKnowledgeSuggestionsGenerationRef(input);
}

export const deriveExamKnowledgeSuggestionGenerationRef =
  deriveExamKnowledgeSuggestionsGenerationRef;

export function deriveExamKnowledgeSuggestionsArtifactRef(generationRef: string): string {
  return deriveRuntimeKnowledgeSuggestionsArtifactRef(generationRef);
}

export const deriveExamKnowledgeSuggestionArtifactRef = deriveExamKnowledgeSuggestionsArtifactRef;

export function deriveExamKnowledgeSuggestionCandidateId(input: {
  generationRef: string;
  confirmedQuestionId: string;
  suggestion: ExamKnowledgeSuggestionDraftV1;
  ordinal: number;
}): string {
  return `exam-knowledge-suggestion:v1:${fingerprint(
    'openmaic:zhongkao-exam-knowledge-suggestion-candidate:v1',
    {
      generationRef: input.generationRef,
      confirmedQuestionId: input.confirmedQuestionId,
      suggestion: input.suggestion,
      ordinal: input.ordinal,
    },
  )}`;
}

export function createExamKnowledgeSuggestionsSemanticFingerprint(
  artifact: Omit<ExamKnowledgeSuggestionsArtifactV1, 'semanticFingerprint'>,
): string {
  return fingerprint('openmaic:zhongkao-exam-knowledge-suggestions-semantic:v1', artifact);
}

export const createExamKnowledgeSuggestionSemanticFingerprint =
  createExamKnowledgeSuggestionsSemanticFingerprint;

export interface BuildExamKnowledgeSuggestionsArtifactInput {
  examSessionId: string;
  profileId: string;
  subjectId: string;
  confirmedReview: ConfirmedExamReviewFactsV1;
  confirmedReviewArtifactSha256: string;
  pool: ExamKnowledgeCandidatePoolV1;
  generator: ExamKnowledgeSuggestionGeneratorV1;
  questionDrafts: readonly ExamKnowledgeSuggestionQuestionDraftV1[];
  generationRef?: string;
  suggestionArtifactRef?: string;
}

function assertBuildSources(input: BuildExamKnowledgeSuggestionsArtifactInput): void {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(input.examSessionId, '/examSessionId', errors);
  validateIdentifier(input.profileId, '/profileId', errors);
  validateIdentifier(input.subjectId, '/subjectId', errors);
  validateGenerator(input.generator, '/generator', errors);
  if (
    errors.length > 0 ||
    !validateConfirmedExamReviewFacts(input.confirmedReview).valid ||
    input.confirmedReview.examSessionId !== input.examSessionId ||
    !validSha256(input.confirmedReviewArtifactSha256) ||
    sha256(serializeConfirmedExamReviewFacts(input.confirmedReview)) !==
      input.confirmedReviewArtifactSha256 ||
    !validateExamKnowledgeCandidatePool(input.pool).valid ||
    input.pool.subjectId !== input.subjectId
  ) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_INVALID');
  }
}

export function buildExamKnowledgeSuggestionsArtifact(
  input: BuildExamKnowledgeSuggestionsArtifactInput,
): ExamKnowledgeSuggestionsArtifactV1 {
  assertBuildSources(input);
  if (
    !Array.isArray(input.questionDrafts) ||
    input.questionDrafts.length > EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxQuestions
  ) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID');
  }
  const reviewQuestions = [...input.confirmedReview.confirmedQuestions].sort(compareQuestionId);
  if (reviewQuestions.length !== input.questionDrafts.length) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_INCOMPLETE');
  }
  const sourceById = new Map(
    reviewQuestions.map((question) => [question.confirmedQuestionId, question]),
  );
  const canonicalDrafts: ExamKnowledgeSuggestionQuestionDraftV1[] = [];
  const seenQuestionIds = new Set<string>();
  for (const rawDraft of input.questionDrafts) {
    if (!isPlainRecord(rawDraft) || typeof rawDraft.confirmedQuestionId !== 'string') {
      throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID');
    }
    const sourceQuestion = sourceById.get(rawDraft.confirmedQuestionId);
    if (!sourceQuestion || seenQuestionIds.has(rawDraft.confirmedQuestionId)) {
      throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_INCOMPLETE');
    }
    const draft = canonicalizeQuestionDraft(rawDraft, sourceQuestion, input.pool);
    if (!draft) {
      throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID');
    }
    seenQuestionIds.add(draft.confirmedQuestionId);
    canonicalDrafts.push(draft);
  }
  if (seenQuestionIds.size !== reviewQuestions.length) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_INCOMPLETE');
  }
  canonicalDrafts.sort(compareQuestionId);

  const sourceReview = reviewSourceFromFacts(
    input.confirmedReview,
    input.confirmedReviewArtifactSha256,
  );
  const pool = parseExamKnowledgeCandidatePool(input.pool);
  const generationRef = deriveExamKnowledgeSuggestionsGenerationRef({
    generationVersion: EXAM_KNOWLEDGE_SUGGESTION_GENERATION_VERSION,
    examSessionId: input.examSessionId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    reviewVersion: sourceReview.reviewVersion,
    reviewArtifactRef: sourceReview.reviewArtifactRef,
    sourceReviewArtifactFingerprint: sourceReview.reviewArtifactSha256,
    sourceReviewSemanticFingerprint: sourceReview.decisionSemanticFingerprint,
    generatorVersion: input.generator.generatorVersion,
    candidateSchemaVersion: input.generator.candidateSchemaVersion,
    candidatePoolMode: pool.mode,
    candidatePoolFingerprint: pool.fingerprint,
  });
  if (input.generationRef !== undefined && input.generationRef !== generationRef) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_INVALID');
  }
  const suggestionArtifactRef = deriveExamKnowledgeSuggestionsArtifactRef(generationRef);
  if (
    input.suggestionArtifactRef !== undefined &&
    input.suggestionArtifactRef !== suggestionArtifactRef
  ) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_INVALID');
  }
  const questions = canonicalDrafts.map(
    (draft): ExamKnowledgeSuggestionQuestionV1 => ({
      confirmedQuestionId: draft.confirmedQuestionId,
      generationStatus: draft.generationStatus,
      suggestions: draft.suggestions.map((suggestion, ordinal) => ({
        candidateId: deriveExamKnowledgeSuggestionCandidateId({
          generationRef,
          confirmedQuestionId: draft.confirmedQuestionId,
          suggestion,
          ordinal,
        }),
        ordinal,
        ...suggestion,
        evidencePhrases: [...suggestion.evidencePhrases],
      })),
    }),
  );
  const withoutFingerprint: Omit<ExamKnowledgeSuggestionsArtifactV1, 'semanticFingerprint'> = {
    schemaVersion: EXAM_KNOWLEDGE_SUGGESTION_SCHEMA_VERSION,
    artifactVersion: EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_VERSION,
    generationVersion: EXAM_KNOWLEDGE_SUGGESTION_GENERATION_VERSION,
    examSessionId: input.examSessionId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    generationRef,
    suggestionArtifactRef,
    generationSource: EXAM_KNOWLEDGE_SUGGESTION_GENERATION_SOURCE,
    candidateStatus: EXAM_KNOWLEDGE_SUGGESTION_CANDIDATE_STATUS,
    sourceReview,
    pool,
    generator: { ...input.generator },
    questionCount: questions.length,
    generatedQuestionCount: questions.filter(
      (question) => question.generationStatus === 'generated',
    ).length,
    noSuggestionQuestionCount: questions.filter(
      (question) => question.generationStatus === 'no_suggestion',
    ).length,
    inputTooLargeQuestionCount: questions.filter(
      (question) => question.generationStatus === 'input_too_large',
    ).length,
    suggestionCount: questions.reduce((count, question) => count + question.suggestions.length, 0),
    questions,
  };
  const artifact: ExamKnowledgeSuggestionsArtifactV1 = {
    ...withoutFingerprint,
    semanticFingerprint: createExamKnowledgeSuggestionsSemanticFingerprint(withoutFingerprint),
  };
  if (!validateExamKnowledgeSuggestionsArtifact(artifact).valid) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT');
  }
  return artifact;
}

function validateQuestion(
  value: unknown,
  path: string,
  generationRef: string,
  pool: ExamKnowledgeCandidatePoolV1,
  errors: DomainValidationIssue[],
): value is ExamKnowledgeSuggestionQuestionV1 {
  const before = errors.length;
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected knowledge suggestion question object');
    return false;
  }
  rejectUnknownKeys(value, ARTIFACT_QUESTION_KEYS, path, errors);
  validateIdentifier(value.confirmedQuestionId, `${path}/confirmedQuestionId`, errors);
  if (
    value.generationStatus !== 'generated' &&
    value.generationStatus !== 'no_suggestion' &&
    value.generationStatus !== 'input_too_large'
  ) {
    pushIssue(errors, `${path}/generationStatus`, 'unexpected generation status');
  }
  if (
    !Array.isArray(value.suggestions) ||
    value.suggestions.length > EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxSuggestionsPerQuestion
  ) {
    pushIssue(errors, `${path}/suggestions`, 'expected bounded suggestion array');
    return false;
  }
  if (
    (value.generationStatus === 'generated' && value.suggestions.length === 0) ||
    (value.generationStatus !== 'generated' && value.suggestions.length !== 0)
  ) {
    pushIssue(errors, `${path}/suggestions`, 'suggestions do not match generation status');
  }
  const allowedIds = new Set(pool.knowledgePointIds);
  const targetKeys: string[] = [];
  value.suggestions.forEach((rawSuggestion, ordinal) => {
    const suggestionPath = `${path}/suggestions/${ordinal}`;
    if (!isPlainRecord(rawSuggestion)) {
      pushIssue(errors, suggestionPath, 'expected suggestion object');
      return;
    }
    const allowedKeys =
      rawSuggestion.kind === 'existing_knowledge_point'
        ? EXISTING_SUGGESTION_KEYS
        : rawSuggestion.kind === 'proposed_label'
          ? PROPOSED_SUGGESTION_KEYS
          : undefined;
    if (!allowedKeys) {
      pushIssue(errors, `${suggestionPath}/kind`, 'unexpected suggestion kind');
      return;
    }
    rejectUnknownKeys(rawSuggestion, allowedKeys, suggestionPath, errors);
    validateIdentifier(rawSuggestion.candidateId, `${suggestionPath}/candidateId`, errors);
    if (rawSuggestion.ordinal !== ordinal) {
      pushIssue(errors, `${suggestionPath}/ordinal`, 'suggestion ordinal mismatch');
    }
    if (
      rawSuggestion.confidenceBand !== 'high' &&
      rawSuggestion.confidenceBand !== 'medium' &&
      rawSuggestion.confidenceBand !== 'low'
    ) {
      pushIssue(errors, `${suggestionPath}/confidenceBand`, 'unexpected confidence band');
    }
    const evidencePhrases = rawSuggestion.evidencePhrases;
    if (
      !Array.isArray(evidencePhrases) ||
      evidencePhrases.length > EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxEvidencePhrasesPerSuggestion ||
      !evidencePhrases.every(isSafeExamKnowledgeSuggestionEvidencePhrase) ||
      new Set(evidencePhrases).size !== evidencePhrases.length ||
      evidencePhrases.some((phrase, index) => index > 0 && evidencePhrases[index - 1] >= phrase)
    ) {
      pushIssue(errors, `${suggestionPath}/evidencePhrases`, 'invalid evidence phrases');
    }
    let draft: ExamKnowledgeSuggestionDraftV1 | undefined;
    if (rawSuggestion.kind === 'existing_knowledge_point') {
      const idErrors: DomainValidationIssue[] = [];
      if (!validateIdentifier(rawSuggestion.knowledgePointId, '', idErrors)) {
        pushIssue(errors, `${suggestionPath}/knowledgePointId`, 'invalid knowledge point id');
      } else if (
        pool.mode !== 'observed_existing_ids' ||
        !allowedIds.has(rawSuggestion.knowledgePointId)
      ) {
        pushIssue(
          errors,
          `${suggestionPath}/knowledgePointId`,
          'knowledge point id is not in pool',
        );
      } else if (
        (rawSuggestion.confidenceBand === 'high' ||
          rawSuggestion.confidenceBand === 'medium' ||
          rawSuggestion.confidenceBand === 'low') &&
        Array.isArray(evidencePhrases)
      ) {
        const existingDraft: ExamKnowledgeSuggestionDraftV1 = {
          kind: 'existing_knowledge_point',
          knowledgePointId: rawSuggestion.knowledgePointId,
          confidenceBand: rawSuggestion.confidenceBand,
          evidencePhrases: evidencePhrases as string[],
        };
        draft = existingDraft;
        targetKeys.push(suggestionTargetKey(existingDraft));
      }
    } else if (!isSafeExamKnowledgeSuggestionProposedLabel(rawSuggestion.proposedLabel)) {
      pushIssue(errors, `${suggestionPath}/proposedLabel`, 'invalid proposed label');
    } else if (
      (rawSuggestion.confidenceBand === 'high' ||
        rawSuggestion.confidenceBand === 'medium' ||
        rawSuggestion.confidenceBand === 'low') &&
      Array.isArray(evidencePhrases)
    ) {
      const proposedDraft: ExamKnowledgeSuggestionDraftV1 = {
        kind: 'proposed_label',
        proposedLabel: rawSuggestion.proposedLabel,
        confidenceBand: rawSuggestion.confidenceBand,
        evidencePhrases: evidencePhrases as string[],
      };
      draft = proposedDraft;
      targetKeys.push(suggestionTargetKey(proposedDraft));
    }
    if (
      draft &&
      typeof value.confirmedQuestionId === 'string' &&
      rawSuggestion.candidateId !==
        deriveExamKnowledgeSuggestionCandidateId({
          generationRef,
          confirmedQuestionId: value.confirmedQuestionId,
          suggestion: draft,
          ordinal,
        })
    ) {
      pushIssue(errors, `${suggestionPath}/candidateId`, 'suggestion candidate id mismatch');
    }
  });
  if (new Set(targetKeys).size !== targetKeys.length) {
    pushIssue(errors, `${path}/suggestions`, 'duplicate suggestion target');
  }
  if (targetKeys.some((target, index) => index > 0 && targetKeys[index - 1]! >= target)) {
    pushIssue(errors, `${path}/suggestions`, 'suggestions are not canonically sorted');
  }
  return errors.length === before;
}

export function validateExamKnowledgeSuggestionsArtifact(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected knowledge suggestions artifact object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, ARTIFACT_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_KNOWLEDGE_SUGGESTION_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected suggestion schema version');
  }
  if (value.artifactVersion !== EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_VERSION) {
    pushIssue(errors, '/artifactVersion', 'unexpected suggestion artifact version');
  }
  if (value.generationVersion !== EXAM_KNOWLEDGE_SUGGESTION_GENERATION_VERSION) {
    pushIssue(errors, '/generationVersion', 'unexpected suggestion generation version');
  }
  for (const field of [
    'examSessionId',
    'profileId',
    'subjectId',
    'generationRef',
    'suggestionArtifactRef',
  ] as const) {
    validateIdentifier(value[field], `/${field}`, errors);
  }
  if (value.generationSource !== EXAM_KNOWLEDGE_SUGGESTION_GENERATION_SOURCE) {
    pushIssue(errors, '/generationSource', 'unexpected suggestion generation source');
  }
  if (value.candidateStatus !== EXAM_KNOWLEDGE_SUGGESTION_CANDIDATE_STATUS) {
    pushIssue(errors, '/candidateStatus', 'unexpected suggestion candidate status');
  }
  const reviewValid = validateReviewSource(value.sourceReview, '/sourceReview', errors);
  const poolValid = validateExamKnowledgeCandidatePool(value.pool).valid;
  if (!poolValid) pushIssue(errors, '/pool', 'invalid knowledge candidate pool');
  const generatorValid = validateGenerator(value.generator, '/generator', errors);
  if (!validSha256(value.semanticFingerprint)) {
    pushIssue(errors, '/semanticFingerprint', 'expected lowercase SHA-256');
  }
  if (
    poolValid &&
    isPlainRecord(value.pool) &&
    typeof value.subjectId === 'string' &&
    value.pool.subjectId !== value.subjectId
  ) {
    pushIssue(errors, '/pool/subjectId', 'candidate pool subject mismatch');
  }
  if (
    reviewValid &&
    poolValid &&
    generatorValid &&
    typeof value.examSessionId === 'string' &&
    typeof value.profileId === 'string' &&
    typeof value.subjectId === 'string'
  ) {
    const expectedGenerationRef = deriveExamKnowledgeSuggestionsGenerationRef({
      generationVersion: EXAM_KNOWLEDGE_SUGGESTION_GENERATION_VERSION,
      examSessionId: value.examSessionId,
      profileId: value.profileId,
      subjectId: value.subjectId,
      reviewVersion: (value.sourceReview as ExamConfirmedReviewSourceV1).reviewVersion,
      reviewArtifactRef: (value.sourceReview as ExamConfirmedReviewSourceV1).reviewArtifactRef,
      sourceReviewArtifactFingerprint: (value.sourceReview as ExamConfirmedReviewSourceV1)
        .reviewArtifactSha256,
      sourceReviewSemanticFingerprint: (value.sourceReview as ExamConfirmedReviewSourceV1)
        .decisionSemanticFingerprint,
      generatorVersion: (value.generator as ExamKnowledgeSuggestionGeneratorV1).generatorVersion,
      candidateSchemaVersion: (value.generator as ExamKnowledgeSuggestionGeneratorV1)
        .candidateSchemaVersion,
      candidatePoolMode: (value.pool as ExamKnowledgeCandidatePoolV1).mode,
      candidatePoolFingerprint: (value.pool as ExamKnowledgeCandidatePoolV1).fingerprint,
    });
    if (value.generationRef !== expectedGenerationRef) {
      pushIssue(errors, '/generationRef', 'suggestion generation reference mismatch');
    }
    if (
      value.suggestionArtifactRef !==
      deriveExamKnowledgeSuggestionsArtifactRef(expectedGenerationRef)
    ) {
      pushIssue(errors, '/suggestionArtifactRef', 'suggestion artifact reference mismatch');
    }
  }
  if (
    !Array.isArray(value.questions) ||
    value.questions.length > EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxQuestions
  ) {
    pushIssue(errors, '/questions', 'expected bounded suggestion question array');
    return finishValidation(errors);
  }
  const pool = poolValid ? (value.pool as ExamKnowledgeCandidatePoolV1) : undefined;
  value.questions.forEach((question, index) => {
    if (pool && typeof value.generationRef === 'string') {
      validateQuestion(question, `/questions/${index}`, value.generationRef, pool, errors);
    }
  });
  const typedQuestions = value.questions.filter(
    (question): question is ExamKnowledgeSuggestionQuestionV1 => isPlainRecord(question),
  );
  if (
    typedQuestions.some(
      (question, index) =>
        index > 0 && typedQuestions[index - 1]!.confirmedQuestionId >= question.confirmedQuestionId,
    )
  ) {
    pushIssue(errors, '/questions', 'questions are not uniquely and canonically sorted');
  }
  const generatedQuestionCount = typedQuestions.filter(
    (question) => question.generationStatus === 'generated',
  ).length;
  const noSuggestionQuestionCount = typedQuestions.filter(
    (question) => question.generationStatus === 'no_suggestion',
  ).length;
  const inputTooLargeQuestionCount = typedQuestions.filter(
    (question) => question.generationStatus === 'input_too_large',
  ).length;
  const suggestionCount = typedQuestions.reduce(
    (count, question) =>
      count + (Array.isArray(question.suggestions) ? question.suggestions.length : 0),
    0,
  );
  for (const [field, expected, max] of [
    ['questionCount', typedQuestions.length, EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxQuestions],
    [
      'generatedQuestionCount',
      generatedQuestionCount,
      EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxQuestions,
    ],
    [
      'noSuggestionQuestionCount',
      noSuggestionQuestionCount,
      EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxQuestions,
    ],
    [
      'inputTooLargeQuestionCount',
      inputTooLargeQuestionCount,
      EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxQuestions,
    ],
    [
      'suggestionCount',
      suggestionCount,
      EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxQuestions *
        EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxSuggestionsPerQuestion,
    ],
  ] as const) {
    if (!validCount(value[field], max) || value[field] !== expected) {
      pushIssue(errors, `/${field}`, 'suggestion count mismatch');
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(canonicalize(value)), 'utf8') >
    EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxArtifactBytes
  ) {
    pushIssue(errors, '', 'suggestion artifact exceeds byte limit');
  }
  if (errors.length === 0) {
    const artifact = value as unknown as ExamKnowledgeSuggestionsArtifactV1;
    const { semanticFingerprint: _ignored, ...withoutFingerprint } = artifact;
    if (
      createExamKnowledgeSuggestionsSemanticFingerprint(withoutFingerprint) !==
      artifact.semanticFingerprint
    ) {
      pushIssue(errors, '/semanticFingerprint', 'suggestion semantic fingerprint mismatch');
    }
  }
  return finishValidation(errors);
}

function canonicalArtifact(
  artifact: ExamKnowledgeSuggestionsArtifactV1,
): ExamKnowledgeSuggestionsArtifactV1 {
  return {
    schemaVersion: EXAM_KNOWLEDGE_SUGGESTION_SCHEMA_VERSION,
    artifactVersion: EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_VERSION,
    generationVersion: EXAM_KNOWLEDGE_SUGGESTION_GENERATION_VERSION,
    examSessionId: artifact.examSessionId,
    profileId: artifact.profileId,
    subjectId: artifact.subjectId,
    generationRef: artifact.generationRef,
    suggestionArtifactRef: artifact.suggestionArtifactRef,
    generationSource: EXAM_KNOWLEDGE_SUGGESTION_GENERATION_SOURCE,
    candidateStatus: EXAM_KNOWLEDGE_SUGGESTION_CANDIDATE_STATUS,
    sourceReview: cloneReviewSource(artifact.sourceReview),
    pool: parseExamKnowledgeCandidatePool(artifact.pool),
    generator: { ...artifact.generator },
    semanticFingerprint: artifact.semanticFingerprint,
    questionCount: artifact.questionCount,
    generatedQuestionCount: artifact.generatedQuestionCount,
    noSuggestionQuestionCount: artifact.noSuggestionQuestionCount,
    inputTooLargeQuestionCount: artifact.inputTooLargeQuestionCount,
    suggestionCount: artifact.suggestionCount,
    questions: artifact.questions.map((question) => ({
      confirmedQuestionId: question.confirmedQuestionId,
      generationStatus: question.generationStatus,
      suggestions: question.suggestions.map((suggestion) => ({
        ...suggestion,
        evidencePhrases: [...suggestion.evidencePhrases],
      })),
    })),
  };
}

function decodeArtifact(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength > EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxArtifactBytes) {
      throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT');
    }
    try {
      return JSON.parse(UTF8_DECODER.decode(value)) as unknown;
    } catch {
      throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT');
    }
  }
  return value;
}

export function parseExamKnowledgeSuggestionsArtifact(
  value: unknown,
): ExamKnowledgeSuggestionsArtifactV1 {
  const decoded = decodeArtifact(value);
  if (!validateExamKnowledgeSuggestionsArtifact(decoded).valid) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT');
  }
  return canonicalArtifact(decoded as ExamKnowledgeSuggestionsArtifactV1);
}

export const parseExamKnowledgeSuggestionArtifact = parseExamKnowledgeSuggestionsArtifact;

export function serializeExamKnowledgeSuggestionsArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(parseExamKnowledgeSuggestionsArtifact(value)), 'utf8');
  if (bytes.byteLength > EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxArtifactBytes) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT');
  }
  return bytes;
}

export const serializeExamKnowledgeSuggestionArtifact = serializeExamKnowledgeSuggestionsArtifact;

function reviewQuestionsForArtifact(
  artifact: ExamKnowledgeSuggestionsArtifactV1,
  confirmedReview: ConfirmedExamReviewFactsV1,
): Map<string, ConfirmedExamQuestionV1> {
  let reviewBytes: Buffer;
  try {
    reviewBytes = serializeConfirmedExamReviewFacts(confirmedReview);
  } catch {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_INVALID');
  }
  if (
    confirmedReview.examSessionId !== artifact.examSessionId ||
    confirmedReview.reviewRef !== artifact.sourceReview.reviewRef ||
    confirmedReview.reviewArtifactRef !== artifact.sourceReview.reviewArtifactRef ||
    confirmedReview.reviewVersion !== artifact.sourceReview.reviewVersion ||
    confirmedReview.artifactVersion !== artifact.sourceReview.reviewArtifactVersion ||
    confirmedReview.decisionSemanticFingerprint !==
      artifact.sourceReview.decisionSemanticFingerprint ||
    sha256(reviewBytes) !== artifact.sourceReview.reviewArtifactSha256
  ) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_INVALID');
  }
  const questions = new Map(
    confirmedReview.confirmedQuestions.map((question) => [question.confirmedQuestionId, question]),
  );
  if (
    questions.size !== confirmedReview.confirmedQuestions.length ||
    questions.size !== artifact.questions.length ||
    artifact.questions.some((question) => !questions.has(question.confirmedQuestionId))
  ) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_INVALID');
  }
  return questions;
}

export function toPublicExamKnowledgeSuggestionsBundle(
  value: unknown,
  confirmedReview: ConfirmedExamReviewFactsV1,
): PublicExamKnowledgeSuggestionsBundleV1 {
  const artifact = parseExamKnowledgeSuggestionsArtifact(value);
  const reviewQuestions = reviewQuestionsForArtifact(artifact, confirmedReview);
  return {
    schemaVersion: EXAM_KNOWLEDGE_SUGGESTION_SCHEMA_VERSION,
    examSessionId: artifact.examSessionId,
    subjectId: artifact.subjectId,
    candidateStatus: EXAM_KNOWLEDGE_SUGGESTION_CANDIDATE_STATUS,
    questions: artifact.questions.map((question) => {
      const sourceQuestion = reviewQuestions.get(question.confirmedQuestionId)!;
      return {
        confirmedQuestionId: question.confirmedQuestionId,
        questionText: sourceQuestion.questionText,
        ...(sourceQuestion.parentContext
          ? { parentContext: { questionText: sourceQuestion.parentContext.questionText } }
          : {}),
        generationStatus: question.generationStatus,
        suggestions: question.suggestions.map(({ ordinal: _ignored, ...suggestion }) => ({
          ...suggestion,
          evidencePhrases: [...suggestion.evidencePhrases],
        })),
      };
    }),
  };
}

export const toPublicExamKnowledgeSuggestionBundle = toPublicExamKnowledgeSuggestionsBundle;

export function assertExamKnowledgeCandidatePoolFingerprint(
  pool: ExamKnowledgeCandidatePoolV1,
): void {
  if (
    pool.fingerprint !==
    createExamKnowledgeCandidatePoolFingerprint({
      mode: pool.mode,
      subjectId: pool.subjectId,
      knowledgePointIds: pool.knowledgePointIds,
    })
  ) {
    throw new ExamKnowledgeSuggestionsPrivateError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_INVALID');
  }
}
