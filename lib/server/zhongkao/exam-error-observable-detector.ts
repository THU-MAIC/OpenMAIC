import {
  EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS,
  EXAM_ERROR_OBSERVABLE_RULES_VERSION,
  parseExamErrorSuggestionQuestionDraft,
  type ExamErrorSuggestionDraftV1,
  type ExamErrorSuggestionEvidenceV1,
  type ExamErrorSuggestionKind,
  type ExamErrorSuggestionQuestionDraftV1,
} from '@/lib/zhongkao/exam-error-suggestions';
import {
  validateConfirmedExamReviewFacts,
  type ConfirmedExamReviewFactsV1,
  type ConfirmedStudentResponseV1,
} from '@/lib/zhongkao/exam-human-review';

import {
  validateAuthoritativeExamAnswerKeyArtifact,
  validateExamQuestionAssessment,
  validateExamQuestionAssessmentsArtifact,
  validatePrivateExamGradingSpec,
  type AuthoritativeExamAnswerKeyArtifactV1,
  type ExamQuestionAssessmentV1,
  type ExamQuestionAssessmentsArtifactV1,
  type PrivateExamGradingSpecV1,
} from './exam-grading-private';
import {
  canonicalizeTransferDecimal,
  parseTransferAnswer,
  type ParsedTransferAnswer,
} from './transfer-answer-evaluator';
import type { TransferQuestionGradingSpec } from './transfer-question-private';

export { EXAM_ERROR_OBSERVABLE_RULES_VERSION };

export class ExamErrorObservableDetectorError extends Error {
  override readonly name = 'ExamErrorObservableDetectorError';
  readonly code = 'EXAM_ERROR_SUGGESTION_SOURCE_INVALID' as const;

  constructor() {
    super('EXAM_ERROR_SUGGESTION_SOURCE_INVALID');
  }
}

export interface DetectExamObservableErrorSuggestionForQuestionInput {
  assessment: ExamQuestionAssessmentV1;
  response?: ConfirmedStudentResponseV1;
  gradingSpec?: PrivateExamGradingSpecV1;
}

export interface DetectExamObservableErrorSuggestionsInput {
  assessments: ExamQuestionAssessmentsArtifactV1;
  confirmedReview: ConfirmedExamReviewFactsV1;
  answerKey: AuthoritativeExamAnswerKeyArtifactV1;
}

function sourceInvalid(): never {
  throw new ExamErrorObservableDetectorError();
}

function deterministicCandidate(
  kind: ExamErrorSuggestionKind,
  evidence: ExamErrorSuggestionEvidenceV1,
): ExamErrorSuggestionDraftV1 {
  return {
    kind,
    generationSource: 'deterministic_candidate',
    candidateStatus: EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS,
    confidenceBand: 'high',
    evidence: [evidence],
  };
}

function questionDraft(
  confirmedQuestionId: string,
  suggestions: ExamErrorSuggestionDraftV1[],
): ExamErrorSuggestionQuestionDraftV1 {
  return parseExamErrorSuggestionQuestionDraft({
    confirmedQuestionId,
    assessmentOutcome: 'incorrect',
    generationStatus: suggestions.length === 0 ? 'no_suggestion' : 'generated',
    suggestions,
  });
}

function transferSpecFromPrivate(
  spec: PrivateExamGradingSpecV1,
): TransferQuestionGradingSpec | null {
  if (spec.type === 'single_choice') {
    return {
      schemaVersion: 1,
      type: spec.type,
      optionIds: [...spec.optionIds],
      correctOptionId: spec.correctOptionId,
    };
  }
  if (spec.type === 'multiple_choice') {
    return {
      schemaVersion: 1,
      type: spec.type,
      optionIds: [...spec.optionIds],
      correctOptionIds: [...spec.correctOptionIds],
    };
  }
  if (spec.type === 'numeric') {
    return {
      schemaVersion: 1,
      type: spec.type,
      expectedNumericValue: spec.expectedNumericValue,
      tolerance: 0,
    };
  }
  if (spec.type === 'exact_short_answer') {
    return {
      schemaVersion: 1,
      type: spec.type,
      acceptedAnswers: [...spec.acceptedAnswers],
      caseMode: spec.caseMode,
    };
  }
  return null;
}

/** Match the compact A-F adapter used by objective Exam grading before the shared parser. */
export function prepareExamObjectiveResponseForParsing(
  gradingType: Exclude<PrivateExamGradingSpecV1['type'], 'unassessed'>,
  rawAnswerText: string,
): string {
  if (gradingType !== 'multiple_choice') return rawAnswerText;
  const normalized = rawAnswerText.normalize('NFKC').trim();
  return /^[A-Fa-f]{1,6}$/u.test(normalized) ? [...normalized].join(',') : rawAnswerText;
}

function optionDifference(
  expected: readonly string[],
  actual: readonly string[],
): Extract<ExamErrorSuggestionEvidenceV1, { evidenceType: 'option_set_difference' }> {
  return {
    evidenceType: 'option_set_difference',
    missingOptions: expected.filter((option) => !actual.includes(option)),
    extraOptions: actual.filter((option) => !expected.includes(option)),
  };
}

function canonicalMagnitude(value: string): { negative: boolean; magnitude: string } {
  return value.startsWith('-')
    ? { negative: true, magnitude: value.slice(1) }
    : { negative: false, magnitude: value };
}

function parsedTextResponse(
  spec: Exclude<PrivateExamGradingSpecV1, { type: 'unassessed' }>,
  rawAnswerText: string,
): { parsed: ParsedTransferAnswer | null; prepared: string } {
  const transferSpec = transferSpecFromPrivate(spec);
  if (!transferSpec) sourceInvalid();
  const prepared = prepareExamObjectiveResponseForParsing(spec.type, rawAnswerText);
  const parsed = parseTransferAnswer(transferSpec, prepared);
  return { prepared, parsed: parsed.ok ? parsed.answer : null };
}

function formatMismatch(
  gradingType: Exclude<PrivateExamGradingSpecV1['type'], 'unassessed'>,
): ExamErrorSuggestionDraftV1 {
  return deterministicCandidate('response_format_mismatch_candidate', {
    evidenceType: 'format_observation',
    gradingType,
    parseStatus: 'invalid',
  });
}

function assertResponseSource(
  assessment: Extract<ExamQuestionAssessmentV1, { status: 'evaluated' }>,
  response: ConfirmedStudentResponseV1,
  spec: PrivateExamGradingSpecV1,
): asserts spec is Exclude<PrivateExamGradingSpecV1, { type: 'unassessed' }> {
  if (
    !validatePrivateExamGradingSpec(spec).valid ||
    spec.type === 'unassessed' ||
    response.confirmedQuestionId !== assessment.confirmedQuestionId ||
    response.confirmedResponseId !== assessment.responseRef ||
    spec.confirmedQuestionId !== assessment.confirmedQuestionId ||
    spec.gradingSpecRef !== assessment.gradingSpecRef ||
    spec.answerKeyRef !== assessment.answerKeyRef ||
    spec.type !== assessment.gradingType ||
    (response.answerStatus === 'text' && typeof response.rawAnswerText !== 'string') ||
    (response.answerStatus !== 'text' && response.rawAnswerText !== undefined)
  ) {
    sourceInvalid();
  }
}

function detectParsedMismatch(
  spec: Exclude<PrivateExamGradingSpecV1, { type: 'unassessed' }>,
  parsed: ParsedTransferAnswer,
  rawAnswerText: string,
): ExamErrorSuggestionDraftV1[] {
  if (spec.type === 'single_choice' && parsed.type === 'single_choice') {
    if (parsed.optionId === spec.correctOptionId) sourceInvalid();
    return [
      deterministicCandidate(
        'single_choice_option_mismatch_candidate',
        optionDifference([spec.correctOptionId], [parsed.optionId]),
      ),
    ];
  }
  if (spec.type === 'multiple_choice' && parsed.type === 'multiple_choice') {
    const difference = optionDifference(spec.correctOptionIds, parsed.optionIds);
    if (difference.missingOptions.length + difference.extraOptions.length === 0) sourceInvalid();
    return [deterministicCandidate('multiple_choice_set_mismatch_candidate', difference)];
  }
  if (spec.type === 'numeric' && parsed.type === 'numeric') {
    const actual = canonicalizeTransferDecimal(rawAnswerText);
    if (!actual || actual.canonicalValue === spec.expectedValue) sourceInvalid();
    const expectedParts = canonicalMagnitude(spec.expectedValue);
    const actualParts = canonicalMagnitude(actual.canonicalValue);
    const oppositeSign =
      expectedParts.magnitude !== '0' &&
      actualParts.magnitude !== '0' &&
      expectedParts.magnitude === actualParts.magnitude &&
      expectedParts.negative !== actualParts.negative;
    return [
      deterministicCandidate(
        oppositeSign ? 'numeric_sign_mismatch_candidate' : 'numeric_value_mismatch_candidate',
        {
          evidenceType: 'numeric_difference',
          differenceKind: oppositeSign ? 'opposite_sign' : 'different_value',
        },
      ),
    ];
  }
  if (spec.type === 'exact_short_answer' && parsed.type === 'exact_short_answer') {
    if (spec.acceptedAnswers.includes(parsed.normalizedAnswer)) sourceInvalid();
    return [];
  }
  sourceInvalid();
}

/**
 * Derive only mechanically observable candidates after authoritative grading has already fixed
 * the outcome. Correct and unassessed questions short-circuit without reading response/spec fields.
 */
export function detectExamObservableErrorSuggestionForQuestion(
  input: DetectExamObservableErrorSuggestionForQuestionInput,
): ExamErrorSuggestionQuestionDraftV1 | null {
  const assessment = input.assessment;
  if (!validateExamQuestionAssessment(assessment).valid) sourceInvalid();
  if (assessment.status !== 'evaluated' || assessment.outcome !== 'incorrect') return null;

  const response = input.response;
  const spec = input.gradingSpec;
  if (!response || !spec) sourceInvalid();
  assertResponseSource(assessment, response, spec);

  if (response.answerStatus === 'blank') {
    return questionDraft(assessment.confirmedQuestionId, [
      deterministicCandidate('blank_response_observation_candidate', {
        evidenceType: 'response_status',
        status: 'blank',
      }),
    ]);
  }
  if (response.answerStatus === 'no_response') {
    return questionDraft(assessment.confirmedQuestionId, [
      deterministicCandidate('no_response_observation_candidate', {
        evidenceType: 'response_status',
        status: 'no_response',
      }),
    ]);
  }
  if (response.answerStatus !== 'text' || typeof response.rawAnswerText !== 'string') {
    sourceInvalid();
  }

  const { parsed, prepared } = parsedTextResponse(spec, response.rawAnswerText);
  if (!parsed) {
    return questionDraft(assessment.confirmedQuestionId, [formatMismatch(spec.type)]);
  }
  return questionDraft(
    assessment.confirmedQuestionId,
    detectParsedMismatch(spec, parsed, prepared),
  );
}

function sourcesMatch(
  review: ConfirmedExamReviewFactsV1,
  assessments: ExamQuestionAssessmentsArtifactV1,
  answerKey: AuthoritativeExamAnswerKeyArtifactV1,
): boolean {
  return (
    review.examSessionId === assessments.examSessionId &&
    review.examSessionId === answerKey.examSessionId &&
    assessments.answerKeyRef === answerKey.answerKeyRef &&
    assessments.answerKeySemanticFingerprint === answerKey.semanticFingerprint &&
    assessments.sourceReview.reviewRef === review.reviewRef &&
    assessments.sourceReview.reviewArtifactRef === review.reviewArtifactRef &&
    assessments.sourceReview.decisionSemanticFingerprint === review.decisionSemanticFingerprint &&
    answerKey.sourceReview.reviewRef === review.reviewRef &&
    answerKey.sourceReview.reviewArtifactRef === review.reviewArtifactRef &&
    answerKey.sourceReview.decisionSemanticFingerprint === review.decisionSemanticFingerprint
  );
}

/** Return one canonical row for each eligible authoritative incorrect assessment, and no others. */
export function detectExamObservableErrorSuggestions(
  input: DetectExamObservableErrorSuggestionsInput,
): ExamErrorSuggestionQuestionDraftV1[] {
  const assessments = input.assessments;
  if (!validateExamQuestionAssessmentsArtifact(assessments).valid) sourceInvalid();
  const eligible = assessments.assessments.filter(
    (assessment): assessment is Extract<ExamQuestionAssessmentV1, { status: 'evaluated' }> =>
      assessment.status === 'evaluated' && assessment.outcome === 'incorrect',
  );
  if (eligible.length === 0) return [];

  const review = input.confirmedReview;
  const answerKey = input.answerKey;
  if (
    !validateConfirmedExamReviewFacts(review).valid ||
    !validateAuthoritativeExamAnswerKeyArtifact(answerKey).valid ||
    !sourcesMatch(review, assessments, answerKey)
  ) {
    sourceInvalid();
  }

  return eligible
    .map((assessment) => {
      const response = review.confirmedResponses.find(
        (item) => item.confirmedQuestionId === assessment.confirmedQuestionId,
      );
      const gradingSpec = answerKey.entries.find(
        (item) => item.confirmedQuestionId === assessment.confirmedQuestionId,
      );
      return detectExamObservableErrorSuggestionForQuestion({
        assessment,
        response,
        gradingSpec,
      });
    })
    .filter((draft): draft is ExamErrorSuggestionQuestionDraftV1 => draft !== null)
    .sort((left, right) => left.confirmedQuestionId.localeCompare(right.confirmedQuestionId, 'en'));
}
