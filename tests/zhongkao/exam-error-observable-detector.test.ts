import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ExamErrorObservableDetectorError,
  detectExamObservableErrorSuggestionForQuestion,
  detectExamObservableErrorSuggestions,
  prepareExamObjectiveResponseForParsing,
  type DetectExamObservableErrorSuggestionForQuestionInput,
} from '@/lib/server/zhongkao/exam-error-observable-detector';
import {
  EXAM_ANSWER_KEY_AUTHORITY_SOURCE,
  EXAM_ANSWER_KEY_SCHEMA_VERSION,
  EXAM_ANSWER_KEY_VERSION,
  EXAM_ASSESSMENT_SCHEMA_VERSION,
  EXAM_ASSESSMENT_VERSION,
  EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
  buildAuthoritativeExamAnswerKeyArtifact,
  buildExamQuestionAssessmentsArtifact,
  deriveExamAnswerKeyRef,
  deriveExamAssessmentRef,
  deriveExamQuestionAssessmentId,
  derivePrivateExamGradingSpecRef,
  type ExamConfirmedReviewSourceV1,
  type ExamQuestionAssessmentV1,
  type PrivateExamGradingSpecV1,
} from '@/lib/server/zhongkao/exam-grading-private';
import {
  buildConfirmedExamReviewFacts,
  serializeConfirmedExamReviewFacts,
  type ConfirmedStudentResponseV1,
  type ExamHumanReviewDecision,
} from '@/lib/zhongkao/exam-human-review';
import {
  segmentExamQuestionCandidates,
  serializeExamQuestionCandidatesArtifact,
} from '@/lib/zhongkao/exam-question-candidate';
import {
  buildExamQuestionResponseMatchesArtifact,
  buildStudentResponseCandidatesArtifact,
  serializeExamQuestionResponseMatchesArtifact,
  serializeStudentResponseCandidatesArtifact,
} from '@/lib/zhongkao/exam-student-response';

const EXAM_SESSION_ID = 'exam-error-detector-fixture';
const ANSWER_KEY_FINGERPRINT = 'b'.repeat(64);
const SOURCE_REVIEW: ExamConfirmedReviewSourceV1 = {
  reviewRef: 'exam-review-v1',
  reviewArtifactRef: 'exam-review-artifact-v1',
  reviewArtifactSha256: 'a'.repeat(64),
  reviewVersion: 1,
  reviewArtifactVersion: 1,
  decisionSemanticFingerprint: 'c'.repeat(64),
};
const ANSWER_KEY_REF = deriveExamAnswerKeyRef({
  examSessionId: EXAM_SESSION_ID,
  sourceReview: SOURCE_REVIEW,
});

function response(
  confirmedQuestionId: string,
  answer: string | 'blank' | 'no_response',
): ConfirmedStudentResponseV1 {
  const base = {
    confirmedResponseId: `response-${confirmedQuestionId}`,
    confirmedQuestionId,
  };
  if (answer === 'blank') {
    return { ...base, answerStatus: 'blank', answerSource: 'owner_corrected' };
  }
  if (answer === 'no_response') {
    return { ...base, answerStatus: 'no_response', answerSource: 'owner_no_response' };
  }
  return {
    ...base,
    answerStatus: 'text',
    rawAnswerText: answer,
    answerSource: 'owner_corrected',
  };
}

function specBase(confirmedQuestionId: string) {
  return {
    schemaVersion: EXAM_ANSWER_KEY_SCHEMA_VERSION,
    answerKeyVersion: EXAM_ANSWER_KEY_VERSION,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
    examSessionId: EXAM_SESSION_ID,
    confirmedQuestionId,
    answerKeyRef: ANSWER_KEY_REF,
    gradingSpecRef: derivePrivateExamGradingSpecRef(ANSWER_KEY_REF, confirmedQuestionId),
    sourceReview: SOURCE_REVIEW,
    authoritySource: EXAM_ANSWER_KEY_AUTHORITY_SOURCE,
  } as const;
}

function singleSpec(confirmedQuestionId = 'question-1'): PrivateExamGradingSpecV1 {
  return {
    ...specBase(confirmedQuestionId),
    type: 'single_choice',
    optionIds: ['A', 'B', 'C', 'D', 'E', 'F'],
    correctOptionId: 'B',
  };
}

function multipleSpec(confirmedQuestionId = 'question-1'): PrivateExamGradingSpecV1 {
  return {
    ...specBase(confirmedQuestionId),
    type: 'multiple_choice',
    optionIds: ['A', 'B', 'C', 'D', 'E', 'F'],
    correctOptionIds: ['A', 'C'],
  };
}

function numericSpec(
  confirmedQuestionId = 'question-1',
  expectedValue = '-2e0',
  expectedNumericValue = -2,
): PrivateExamGradingSpecV1 {
  return {
    ...specBase(confirmedQuestionId),
    type: 'numeric',
    expectedValue,
    expectedNumericValue,
    tolerance: 0,
  };
}

function exactSpec(confirmedQuestionId = 'question-1'): PrivateExamGradingSpecV1 {
  return {
    ...specBase(confirmedQuestionId),
    type: 'exact_short_answer',
    acceptedAnswers: ['oxygen'],
    caseMode: 'ascii_case_insensitive',
  };
}

function assessment(
  gradingSpec: PrivateExamGradingSpecV1,
  confirmedResponse: ConfirmedStudentResponseV1,
  outcome: 'correct' | 'incorrect' = 'incorrect',
): ExamQuestionAssessmentV1 {
  const assessmentRef = deriveExamAssessmentRef({
    examSessionId: EXAM_SESSION_ID,
    sourceReviewSemanticFingerprint: SOURCE_REVIEW.decisionSemanticFingerprint,
    answerKeySemanticFingerprint: ANSWER_KEY_FINGERPRINT,
  });
  const base = {
    schemaVersion: EXAM_ASSESSMENT_SCHEMA_VERSION,
    assessmentVersion: EXAM_ASSESSMENT_VERSION,
    assessmentRef,
    assessmentId: deriveExamQuestionAssessmentId({
      assessmentRef,
      confirmedQuestionId: gradingSpec.confirmedQuestionId,
      responseRef: confirmedResponse.confirmedResponseId,
    }),
    examSessionId: EXAM_SESSION_ID,
    confirmedQuestionId: gradingSpec.confirmedQuestionId,
    responseRef: confirmedResponse.confirmedResponseId,
    sourceReviewRef: SOURCE_REVIEW.reviewRef,
    answerKeyRef: ANSWER_KEY_REF,
    answerKeySemanticFingerprint: ANSWER_KEY_FINGERPRINT,
    gradingSpecRef: gradingSpec.gradingSpecRef,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
  } as const;
  if (gradingSpec.type === 'unassessed') {
    return { ...base, status: 'unassessed', reason: gradingSpec.reason };
  }
  return { ...base, status: 'evaluated', outcome, gradingType: gradingSpec.type };
}

function detect(
  gradingSpec: PrivateExamGradingSpecV1,
  confirmedResponse: ConfirmedStudentResponseV1,
  outcome: 'correct' | 'incorrect' = 'incorrect',
) {
  return detectExamObservableErrorSuggestionForQuestion({
    assessment: assessment(gradingSpec, confirmedResponse, outcome),
    response: confirmedResponse,
    gradingSpec,
  });
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function aggregateFixture() {
  const questionArtifactRef = 'exam-question-candidates:v1:error-detector';
  const responseArtifactRef = 'exam-response-candidates:v1:error-detector';
  const matchingArtifactRef = 'exam-response-matches:v1:error-detector';
  const reviewRef = 'exam-human-review:v1:error-detector';
  const questions = segmentExamQuestionCandidates({
    examSessionId: EXAM_SESSION_ID,
    examDocumentId: 'question-paper-error-detector',
    artifact: {
      schemaVersion: 1,
      artifactVersion: 1,
      examSessionId: EXAM_SESSION_ID,
      examDocumentId: 'question-paper-error-detector',
      sourceSnapshotFingerprint: 'd'.repeat(64),
      mimeType: 'application/pdf',
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          blocks: [
            {
              blockIndex: 0,
              kind: 'text',
              text: [
                '1. Fictional incorrect choice question',
                '2. Fictional correct numeric question',
                '3. Fictional unsupported open question',
              ].join('\n'),
            },
          ],
        },
      ],
    },
  });
  const questionSha = digest(serializeExamQuestionCandidatesArtifact(questions));
  const responses = buildStudentResponseCandidatesArtifact({
    examSessionId: EXAM_SESSION_ID,
    captureVersion: 1,
    captureRef: 'exam-response-capture:v1:error-detector',
    responseArtifactRef,
    questionCandidateArtifactRef: questionArtifactRef,
    questionCandidateArtifactSha256: questionSha,
    questionSegmentationVersion: 1,
    request: { format: 'numbered_text_v1', text: ['1=C', '2=2', '3=essay'].join('\n') },
  });
  const responseSha = digest(serializeStudentResponseCandidatesArtifact(responses));
  const matches = buildExamQuestionResponseMatchesArtifact({
    examSessionId: EXAM_SESSION_ID,
    matchingArtifactRef,
    questionCandidateArtifactRef: questionArtifactRef,
    questionCandidateArtifactSha256: questionSha,
    responseArtifactRef,
    questionCandidatesArtifact: questions,
    responseCandidatesArtifact: responses,
  });
  const questionByNumber = new Map(
    questions.candidates.map((candidate) => [candidate.locator.printedNumber, candidate]),
  );
  const responseByNumber = new Map(
    responses.candidates.map((candidate) => [candidate.locator.printedNumber, candidate]),
  );
  const decisions: ExamHumanReviewDecision[] = [];
  for (const number of ['1', '2', '3']) {
    decisions.push({
      decisionType: 'confirm_question',
      questionCandidateId: questionByNumber.get(number)!.candidateId,
    });
    decisions.push({
      decisionType: 'confirm_response',
      responseCandidateId: responseByNumber.get(number)!.candidateId,
      questionCandidateId: questionByNumber.get(number)!.candidateId,
    });
  }
  const review = buildConfirmedExamReviewFacts({
    examSessionId: EXAM_SESSION_ID,
    reviewRef,
    reviewArtifactRef: 'exam-confirmed-review-facts:v1:error-detector',
    questionArtifactRef,
    questionArtifactSha256: questionSha,
    questionExtractionVersion: 1,
    questionSegmentationVersion: 1,
    responseArtifactRef,
    responseArtifactSha256: responseSha,
    responseCaptureVersion: 1,
    matchingArtifactRef,
    matchingArtifactSha256: digest(serializeExamQuestionResponseMatchesArtifact(matches)),
    matchingVersion: 1,
    questionCandidatesArtifact: questions,
    responseCandidatesArtifact: responses,
    questionResponseMatchesArtifact: matches,
    request: { schemaVersion: 1, decisions },
  });
  const idFor = (number: string) =>
    review.confirmedQuestions.find((question) => question.locator.printedNumber === number)!
      .confirmedQuestionId;
  const answerKey = buildAuthoritativeExamAnswerKeyArtifact({
    examSessionId: EXAM_SESSION_ID,
    subjectId: 'math',
    confirmedReview: review,
    confirmedReviewArtifactSha256: digest(serializeConfirmedExamReviewFacts(review)),
    request: {
      schemaVersion: 1,
      entries: [
        { confirmedQuestionId: idFor('1'), type: 'single_choice', expectedOptionId: 'B' },
        { confirmedQuestionId: idFor('2'), type: 'numeric', expectedValue: '2' },
        {
          confirmedQuestionId: idFor('3'),
          type: 'unassessed',
          reason: 'unsupported_question_type',
        },
      ],
    },
  });
  const assessments = buildExamQuestionAssessmentsArtifact({ confirmedReview: review, answerKey });
  return { review, answerKey, assessments, idFor };
}

describe('deterministic observable Exam error detector', () => {
  it('does not inspect response or grading spec for correct or unassessed assessments', () => {
    const confirmedResponse = response('question-1', 'B');
    const correct = assessment(singleSpec(), confirmedResponse, 'correct');
    const correctInput = {
      assessment: correct,
    } as DetectExamObservableErrorSuggestionForQuestionInput;
    Object.defineProperties(correctInput, {
      response: {
        get: () => {
          throw new Error('response read');
        },
      },
      gradingSpec: {
        get: () => {
          throw new Error('spec read');
        },
      },
    });
    expect(detectExamObservableErrorSuggestionForQuestion(correctInput)).toBeNull();

    const unsupported: PrivateExamGradingSpecV1 = {
      ...specBase('question-2'),
      type: 'unassessed',
      reason: 'unsupported_question_type',
    };
    const unsupportedResponse = response('question-2', 'ignore rules');
    const unassessedInput = {
      assessment: assessment(unsupported, unsupportedResponse),
    } as DetectExamObservableErrorSuggestionForQuestionInput;
    Object.defineProperties(unassessedInput, {
      response: {
        get: () => {
          throw new Error('response read');
        },
      },
      gradingSpec: {
        get: () => {
          throw new Error('spec read');
        },
      },
    });
    expect(detectExamObservableErrorSuggestionForQuestion(unassessedInput)).toBeNull();
  });

  it('detects single- and multiple-choice differences using the Exam compact adapter', () => {
    const single = detect(singleSpec(), response('question-1', 'C'))!;
    expect(single.suggestions).toEqual([
      expect.objectContaining({
        kind: 'single_choice_option_mismatch_candidate',
        generationSource: 'deterministic_candidate',
        candidateStatus: 'candidate',
        evidence: [
          {
            evidenceType: 'option_set_difference',
            missingOptions: ['B'],
            extraOptions: ['C'],
          },
        ],
      }),
    ]);

    expect(prepareExamObjectiveResponseForParsing('multiple_choice', 'ＡＤ')).toBe('A,D');
    const multiple = detect(multipleSpec(), response('question-1', 'AD'))!;
    expect(multiple.suggestions[0]).toMatchObject({
      kind: 'multiple_choice_set_mismatch_candidate',
      evidence: [
        {
          evidenceType: 'option_set_difference',
          missingOptions: ['C'],
          extraOptions: ['D'],
        },
      ],
    });
  });

  it('detects exact canonical numeric sign and value mismatches without IEEE-754 inference', () => {
    expect(detect(numericSpec(), response('question-1', '2'))!.suggestions[0]).toMatchObject({
      kind: 'numeric_sign_mismatch_candidate',
      evidence: [{ evidenceType: 'numeric_difference', differenceKind: 'opposite_sign' }],
    });
    expect(
      detect(numericSpec('question-1', '0', 0), response('question-1', '-1'))!.suggestions[0],
    ).toMatchObject({
      kind: 'numeric_value_mismatch_candidate',
      evidence: [{ evidenceType: 'numeric_difference', differenceKind: 'different_value' }],
    });
    expect(
      detect(numericSpec('question-1', '125e-1', 12.5), response('question-1', '１２．６'))!
        .suggestions[0],
    ).toMatchObject({ kind: 'numeric_value_mismatch_candidate' });
  });

  it.each(['1/2', '1+2', '3 meters', 'Infinity'])(
    'classifies invalid numeric input %s only as a format observation',
    (rawAnswerText) => {
      const result = detect(numericSpec(), response('question-1', rawAnswerText))!;
      expect(result.suggestions).toEqual([
        expect.objectContaining({
          kind: 'response_format_mismatch_candidate',
          evidence: [
            {
              evidenceType: 'format_observation',
              gradingType: 'numeric',
              parseStatus: 'invalid',
            },
          ],
        }),
      ]);
      expect(JSON.stringify(result)).not.toMatch(/arithmetic|unit_error|concept|careless/iu);
    },
  );

  it('preserves blank and no-response as distinct neutral observations', () => {
    expect(detect(singleSpec(), response('question-1', 'blank'))!.suggestions[0]).toMatchObject({
      kind: 'blank_response_observation_candidate',
      evidence: [{ evidenceType: 'response_status', status: 'blank' }],
    });
    expect(
      detect(singleSpec(), response('question-1', 'no_response'))!.suggestions[0],
    ).toMatchObject({
      kind: 'no_response_observation_candidate',
      evidence: [{ evidenceType: 'response_status', status: 'no_response' }],
    });
  });

  it('returns no suggestion for a valid exact-short mismatch and never infers concept error', () => {
    for (const answer of ['O2', 'oxygen.', 'concept_error']) {
      const result = detect(exactSpec(), response('question-1', answer))!;
      expect(result).toMatchObject({ generationStatus: 'no_suggestion', suggestions: [] });
    }
  });

  it('never emits the model-only unit candidate', () => {
    const results = [
      detect(numericSpec(), response('question-1', '3 meters'))!,
      detect(singleSpec(), response('question-1', 'C'))!,
      detect(exactSpec(), response('question-1', 'oxygen.'))!,
    ];
    expect(JSON.stringify(results)).not.toContain('unit_error_candidate');
  });

  it('fails closed when an incorrect assessment contradicts its bound deterministic facts', () => {
    expect(() => detect(singleSpec(), response('question-1', 'B'))).toThrowError(
      ExamErrorObservableDetectorError,
    );
    expect(() => detect(multipleSpec(), response('question-1', 'AC'))).toThrowError(
      ExamErrorObservableDetectorError,
    );
    expect(() => detect(numericSpec(), response('question-1', '-2'))).toThrowError(
      ExamErrorObservableDetectorError,
    );
    expect(() => detect(exactSpec(), response('question-1', 'oxygen'))).toThrowError(
      ExamErrorObservableDetectorError,
    );
  });

  it('rejects detached response and grading-spec references', () => {
    const gradingSpec = singleSpec();
    const confirmedResponse = response('question-1', 'C');
    const authoritativeAssessment = assessment(gradingSpec, confirmedResponse);
    expect(() =>
      detectExamObservableErrorSuggestionForQuestion({
        assessment: authoritativeAssessment,
        response: { ...confirmedResponse, confirmedResponseId: 'detached-response' },
        gradingSpec,
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXAM_ERROR_SUGGESTION_SOURCE_INVALID' }));
    expect(() =>
      detectExamObservableErrorSuggestionForQuestion({
        assessment: authoritativeAssessment,
        response: confirmedResponse,
        gradingSpec: singleSpec('detached-question'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXAM_ERROR_SUGGESTION_SOURCE_INVALID' }));
  });

  it('returns only authoritative incorrect rows from complete bound source artifacts', () => {
    const fixture = aggregateFixture();
    const result = detectExamObservableErrorSuggestions({
      confirmedReview: fixture.review,
      assessments: fixture.assessments,
      answerKey: fixture.answerKey,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      confirmedQuestionId: fixture.idFor('1'),
      assessmentOutcome: 'incorrect',
      generationStatus: 'generated',
      suggestions: [expect.objectContaining({ kind: 'single_choice_option_mismatch_candidate' })],
    });
  });

  it('short-circuits aggregate source reads when no assessment is eligible', () => {
    const fixture = aggregateFixture();
    const noIncorrect = buildExamQuestionAssessmentsArtifact({
      confirmedReview: fixture.review,
      answerKey: buildAuthoritativeExamAnswerKeyArtifact({
        examSessionId: EXAM_SESSION_ID,
        subjectId: 'math',
        confirmedReview: fixture.review,
        confirmedReviewArtifactSha256: digest(serializeConfirmedExamReviewFacts(fixture.review)),
        request: {
          schemaVersion: 1,
          entries: fixture.review.confirmedQuestions.map((question) => ({
            confirmedQuestionId: question.confirmedQuestionId,
            type: 'unassessed' as const,
            reason: 'unsupported_question_type' as const,
          })),
        },
      }),
    });
    const input = { assessments: noIncorrect } as Parameters<
      typeof detectExamObservableErrorSuggestions
    >[0];
    Object.defineProperties(input, {
      confirmedReview: {
        get: () => {
          throw new Error('review read');
        },
      },
      answerKey: {
        get: () => {
          throw new Error('answer key read');
        },
      },
    });
    expect(detectExamObservableErrorSuggestions(input)).toEqual([]);
  });
});
