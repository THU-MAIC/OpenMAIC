import { describe, expect, it } from 'vitest';

import {
  EXAM_ERROR_PATTERN_AUTHORITY_SOURCE,
  EXAM_ERROR_REVIEW_ARTIFACT_VERSION,
  EXAM_ERROR_REVIEW_LIMITS,
  EXAM_ERROR_REVIEW_SCHEMA_VERSION,
  EXAM_ERROR_REVIEW_VERSION,
  ExamErrorReviewValidationError,
  canonicalizeExamErrorReviewQuestions,
  createExamErrorReviewDecisionSemanticFingerprint,
  deriveConfirmedExamErrorPatternObservationId,
  parseConfirmedExamErrorPatternObservation,
  parseExamErrorReviewRequest,
  validateConfirmedExamErrorPatternObservation,
  validateExamErrorReviewRequest,
  type ConfirmedExamErrorPatternObservationV1,
  type ExamErrorReviewRequestV1,
} from '@/lib/zhongkao/exam-error-review';

const SOURCE_ARTIFACT_REF = `exam-error-suggestions:v1:${'a'.repeat(64)}`;
const SOURCE_ARTIFACT_SHA = 'b'.repeat(64);
const SOURCE_SEMANTIC_SHA = 'c'.repeat(64);
const EXAM_SESSION_ID = `exam:v1:${'d'.repeat(64)}`;
const QUESTION_1 = `exam-confirmed-question:v1:${'1'.repeat(64)}`;
const QUESTION_2 = `exam-confirmed-question:v1:${'2'.repeat(64)}`;
const CANDIDATE_1 = `exam-error-suggestion:v1:${'3'.repeat(64)}`;
const CANDIDATE_2 = `exam-error-suggestion:v1:${'4'.repeat(64)}`;

function request(): ExamErrorReviewRequestV1 {
  return {
    schemaVersion: 1,
    questions: [
      {
        confirmedQuestionId: QUESTION_2,
        candidateDecisions: [],
      },
      {
        confirmedQuestionId: QUESTION_1,
        candidateDecisions: [
          { candidateId: CANDIDATE_2, decision: 'reject' },
          { candidateId: CANDIDATE_1, decision: 'accept' },
        ],
      },
    ],
  };
}

function fingerprint(value: unknown = request()): string {
  return createExamErrorReviewDecisionSemanticFingerprint({
    sourceCandidateArtifactRef: SOURCE_ARTIFACT_REF,
    sourceCandidateArtifactFingerprint: SOURCE_ARTIFACT_SHA,
    sourceCandidateSemanticFingerprint: SOURCE_SEMANTIC_SHA,
    reviewVersion: EXAM_ERROR_REVIEW_VERSION,
    request: value,
  });
}

function observation(
  overrides: Partial<ConfirmedExamErrorPatternObservationV1> = {},
): ConfirmedExamErrorPatternObservationV1 {
  return {
    schemaVersion: 1,
    observationId: deriveConfirmedExamErrorPatternObservationId({
      examSessionId: EXAM_SESSION_ID,
      sourceCandidateId: CANDIDATE_1,
      sourceCandidateArtifactFingerprint: SOURCE_ARTIFACT_SHA,
      sourceCandidateSemanticFingerprint: SOURCE_SEMANTIC_SHA,
      errorReviewVersion: EXAM_ERROR_REVIEW_VERSION,
    }),
    confirmedQuestionId: QUESTION_1,
    sourceCandidateId: CANDIDATE_1,
    patternKind: 'numeric_sign_mismatch_candidate',
    candidateGenerationSource: 'deterministic_candidate',
    evidence: [{ evidenceType: 'numeric_difference', differenceKind: 'opposite_sign' }],
    authoritySource: EXAM_ERROR_PATTERN_AUTHORITY_SOURCE,
    ...overrides,
  };
}

describe('Exam error pattern review domain', () => {
  it('freezes the immutable v1 contract and bounded resource policy', () => {
    expect(EXAM_ERROR_REVIEW_SCHEMA_VERSION).toBe(1);
    expect(EXAM_ERROR_REVIEW_ARTIFACT_VERSION).toBe(1);
    expect(EXAM_ERROR_REVIEW_VERSION).toBe(1);
    expect(EXAM_ERROR_PATTERN_AUTHORITY_SOURCE).toBe('owner_confirmed_error_pattern');
    expect(EXAM_ERROR_REVIEW_LIMITS).toEqual({
      maxQuestions: 500,
      maxCandidateDecisions: 1_500,
      maxRequestBytes: 2 * 1024 * 1024,
      maxArtifactBytes: 4 * 1024 * 1024,
    });
  });

  it('parses a full question set, preserves zero-candidate review, and canonicalizes order', () => {
    expect(validateExamErrorReviewRequest(request())).toEqual({ valid: true });
    expect(parseExamErrorReviewRequest(request())).toEqual({
      schemaVersion: 1,
      questions: [
        {
          confirmedQuestionId: QUESTION_1,
          candidateDecisions: [
            { candidateId: CANDIDATE_1, decision: 'accept' },
            { candidateId: CANDIDATE_2, decision: 'reject' },
          ],
        },
        { confirmedQuestionId: QUESTION_2, candidateDecisions: [] },
      ],
    });
    expect(canonicalizeExamErrorReviewQuestions(request().questions)).toEqual(
      parseExamErrorReviewRequest(request()).questions,
    );
  });

  it('accepts an empty full-set request for a source bundle with no eligible questions', () => {
    expect(parseExamErrorReviewRequest({ schemaVersion: 1, questions: [] })).toEqual({
      schemaVersion: 1,
      questions: [],
    });
  });

  it('rejects unknown fields, schema versions, decisions, and client-supplied facts', () => {
    const invalid = [
      { ...request(), profileId: 'profile-1' },
      { ...request(), schemaVersion: 2 },
      {
        schemaVersion: 1,
        questions: [{ confirmedQuestionId: QUESTION_1, candidateDecisions: [], noError: true }],
      },
      {
        schemaVersion: 1,
        questions: [
          {
            confirmedQuestionId: QUESTION_1,
            candidateDecisions: [{ candidateId: CANDIDATE_1, decision: 'skip' }],
          },
        ],
      },
      {
        schemaVersion: 1,
        questions: [
          {
            confirmedQuestionId: QUESTION_1,
            candidateDecisions: [
              {
                candidateId: CANDIDATE_1,
                decision: 'accept',
                patternKind: 'numeric_sign_mismatch_candidate',
              },
            ],
          },
        ],
      },
      {
        schemaVersion: 1,
        questions: [
          {
            confirmedQuestionId: QUESTION_1,
            candidateDecisions: [{ candidateId: CANDIDATE_1, decision: 'accept', evidence: [] }],
          },
        ],
      },
      {
        schemaVersion: 1,
        questions: [
          {
            confirmedQuestionId: QUESTION_1,
            candidateDecisions: [
              {
                candidateId: CANDIDATE_1,
                decision: 'accept',
                authoritySource: EXAM_ERROR_PATTERN_AUTHORITY_SOURCE,
              },
            ],
          },
        ],
      },
    ];
    for (const value of invalid) {
      expect(validateExamErrorReviewRequest(value)).toMatchObject({ valid: false });
      expect(() => parseExamErrorReviewRequest(value)).toThrow(ExamErrorReviewValidationError);
    }
  });

  it('rejects missing arrays and unsafe or empty identifiers', () => {
    const invalid = [
      { schemaVersion: 1 },
      { schemaVersion: 1, questions: {} },
      { schemaVersion: 1, questions: [{ candidateDecisions: [] }] },
      {
        schemaVersion: 1,
        questions: [{ confirmedQuestionId: '', candidateDecisions: [] }],
      },
      {
        schemaVersion: 1,
        questions: [{ confirmedQuestionId: QUESTION_1, candidateDecisions: {} }],
      },
      {
        schemaVersion: 1,
        questions: [
          {
            confirmedQuestionId: QUESTION_1,
            candidateDecisions: [{ candidateId: ' bad ', decision: 'accept' }],
          },
        ],
      },
    ];
    for (const value of invalid) {
      expect(validateExamErrorReviewRequest(value)).toMatchObject({ valid: false });
    }
  });

  it('rejects duplicate questions and duplicate candidates before canonical sorting', () => {
    const duplicateQuestion = {
      schemaVersion: 1,
      questions: [
        { confirmedQuestionId: QUESTION_1, candidateDecisions: [] },
        { confirmedQuestionId: QUESTION_1, candidateDecisions: [] },
      ],
    };
    const duplicateCandidate = {
      schemaVersion: 1,
      questions: [
        {
          confirmedQuestionId: QUESTION_1,
          candidateDecisions: [
            { candidateId: CANDIDATE_1, decision: 'accept' },
            { candidateId: CANDIDATE_1, decision: 'reject' },
          ],
        },
      ],
    };
    const candidateAcrossQuestions = {
      schemaVersion: 1,
      questions: [
        {
          confirmedQuestionId: QUESTION_1,
          candidateDecisions: [{ candidateId: CANDIDATE_1, decision: 'accept' }],
        },
        {
          confirmedQuestionId: QUESTION_2,
          candidateDecisions: [{ candidateId: CANDIDATE_1, decision: 'reject' }],
        },
      ],
    };
    for (const value of [duplicateQuestion, duplicateCandidate, candidateAcrossQuestions]) {
      expect(validateExamErrorReviewRequest(value)).toMatchObject({ valid: false });
    }
  });

  it('enforces question and total candidate-decision limits', () => {
    const tooManyQuestions = Array.from(
      { length: EXAM_ERROR_REVIEW_LIMITS.maxQuestions + 1 },
      (_, index) => ({ confirmedQuestionId: `question-${index}`, candidateDecisions: [] }),
    );
    const tooManyDecisions = Array.from(
      { length: EXAM_ERROR_REVIEW_LIMITS.maxCandidateDecisions + 1 },
      (_, index) => ({ candidateId: `candidate-${index}`, decision: 'reject' }),
    );
    expect(
      validateExamErrorReviewRequest({ schemaVersion: 1, questions: tooManyQuestions }),
    ).toMatchObject({ valid: false });
    expect(
      validateExamErrorReviewRequest({
        schemaVersion: 1,
        questions: [{ confirmedQuestionId: QUESTION_1, candidateDecisions: tooManyDecisions }],
      }),
    ).toMatchObject({ valid: false });
  });

  it('produces an order-independent, source-bound semantic fingerprint', () => {
    const canonical = parseExamErrorReviewRequest(request());
    const reordered = {
      schemaVersion: 1,
      questions: [...request().questions].reverse().map((question) => ({
        ...question,
        candidateDecisions: [...question.candidateDecisions].reverse(),
      })),
    };
    expect(fingerprint(reordered)).toBe(fingerprint(canonical));

    const base = {
      sourceCandidateArtifactRef: SOURCE_ARTIFACT_REF,
      sourceCandidateArtifactFingerprint: SOURCE_ARTIFACT_SHA,
      sourceCandidateSemanticFingerprint: SOURCE_SEMANTIC_SHA,
      reviewVersion: 1,
      request: canonical,
    };
    expect(
      createExamErrorReviewDecisionSemanticFingerprint({
        ...base,
        sourceCandidateArtifactRef: `${SOURCE_ARTIFACT_REF}-changed`,
      }),
    ).not.toBe(fingerprint(canonical));
    expect(
      createExamErrorReviewDecisionSemanticFingerprint({
        ...base,
        sourceCandidateArtifactFingerprint: 'e'.repeat(64),
      }),
    ).not.toBe(fingerprint(canonical));
    expect(
      createExamErrorReviewDecisionSemanticFingerprint({
        ...base,
        sourceCandidateSemanticFingerprint: 'f'.repeat(64),
      }),
    ).not.toBe(fingerprint(canonical));
  });

  it('rejects malformed source bindings for semantic fingerprints', () => {
    const base = {
      sourceCandidateArtifactRef: SOURCE_ARTIFACT_REF,
      sourceCandidateArtifactFingerprint: SOURCE_ARTIFACT_SHA,
      sourceCandidateSemanticFingerprint: SOURCE_SEMANTIC_SHA,
      reviewVersion: 1,
      request: request(),
    };
    const invalid = [
      { ...base, sourceCandidateArtifactRef: '' },
      { ...base, sourceCandidateArtifactFingerprint: 'B'.repeat(64) },
      { ...base, sourceCandidateSemanticFingerprint: 'c'.repeat(63) },
      { ...base, reviewVersion: 2 },
    ];
    for (const value of invalid) {
      expect(() => createExamErrorReviewDecisionSemanticFingerprint(value)).toThrow(
        ExamErrorReviewValidationError,
      );
    }
  });

  it('derives deterministic observation IDs bound to candidate source and review version', () => {
    const base = {
      examSessionId: EXAM_SESSION_ID,
      sourceCandidateId: CANDIDATE_1,
      sourceCandidateArtifactFingerprint: SOURCE_ARTIFACT_SHA,
      sourceCandidateSemanticFingerprint: SOURCE_SEMANTIC_SHA,
      errorReviewVersion: 1,
    };
    const first = deriveConfirmedExamErrorPatternObservationId(base);
    expect(first).toBe(deriveConfirmedExamErrorPatternObservationId(base));
    expect(first).toMatch(/^exam-error-pattern-observation:v1:[a-f0-9]{64}$/u);
    expect(
      deriveConfirmedExamErrorPatternObservationId({
        ...base,
        sourceCandidateId: CANDIDATE_2,
      }),
    ).not.toBe(first);
    expect(
      deriveConfirmedExamErrorPatternObservationId({
        ...base,
        sourceCandidateSemanticFingerprint: 'e'.repeat(64),
      }),
    ).not.toBe(first);
    expect(() =>
      deriveConfirmedExamErrorPatternObservationId({ ...base, errorReviewVersion: 2 }),
    ).toThrow(ExamErrorReviewValidationError);
  });

  it('validates only closed owner-confirmed observable pattern observations', () => {
    expect(validateConfirmedExamErrorPatternObservation(observation())).toEqual({ valid: true });
    expect(parseConfirmedExamErrorPatternObservation(observation())).toEqual(observation());

    const modelObservation = observation({
      patternKind: 'unit_error_candidate',
      candidateGenerationSource: 'model_candidate',
      evidence: [
        { evidenceType: 'text_span', source: 'question', text: '单位为 cm' },
        { evidenceType: 'text_span', source: 'response', text: '12 m' },
      ],
    });
    expect(validateConfirmedExamErrorPatternObservation(modelObservation)).toEqual({ valid: true });
  });

  it('rejects arbitrary, causal, noncanonical, or client-extended observation facts', () => {
    const invalid = [
      { ...observation(), authoritySource: 'deterministic_candidate' },
      { ...observation(), patternKind: 'careless' },
      { ...observation(), assessmentOutcome: 'incorrect' },
      { ...observation(), knowledgePointIds: ['algebra'] },
      { ...observation(), cause: 'time_pressure' },
      {
        ...observation(),
        patternKind: 'numeric_sign_mismatch_candidate',
        evidence: [{ evidenceType: 'numeric_difference', differenceKind: 'different_value' }],
      },
      {
        ...observation(),
        patternKind: 'unit_error_candidate',
        candidateGenerationSource: 'deterministic_candidate',
        evidence: [
          { evidenceType: 'text_span', source: 'question', text: '单位为 cm' },
          { evidenceType: 'text_span', source: 'response', text: '12 m' },
        ],
      },
      { ...observation(), observationId: `exam-error-pattern-observation:v2:${'a'.repeat(64)}` },
    ];
    for (const value of invalid) {
      expect(validateConfirmedExamErrorPatternObservation(value)).toMatchObject({ valid: false });
      expect(() => parseConfirmedExamErrorPatternObservation(value)).toThrow(
        ExamErrorReviewValidationError,
      );
    }
  });

  it('requires canonical evidence inherited from a validated source candidate', () => {
    const noncanonical = observation({
      patternKind: 'multiple_choice_set_mismatch_candidate',
      evidence: [
        {
          evidenceType: 'option_set_difference',
          missingOptions: ['C', 'A'],
          extraOptions: ['D'],
        },
      ],
    });
    expect(validateConfirmedExamErrorPatternObservation(noncanonical)).toMatchObject({
      valid: false,
    });
    expect(
      validateConfirmedExamErrorPatternObservation({
        ...noncanonical,
        evidence: [
          {
            evidenceType: 'option_set_difference',
            missingOptions: ['A', 'C'],
            extraOptions: ['D'],
          },
        ],
      }),
    ).toEqual({ valid: true });
  });
});
