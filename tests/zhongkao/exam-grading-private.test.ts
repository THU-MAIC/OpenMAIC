import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildAuthoritativeExamAnswerKeyArtifact,
  buildExamQuestionAssessmentsArtifact,
  createExamAnswerKeySemanticFingerprint,
  createExamAssessmentsSemanticFingerprint,
  evaluateExamQuestionResponse,
  parseAuthoritativeExamAnswerKeyArtifact,
  parseExamAnswerKeyRequest,
  parseExamQuestionAssessmentsArtifact,
  serializeAuthoritativeExamAnswerKeyArtifact,
  serializeExamQuestionAssessmentsArtifact,
  validateAuthoritativeExamAnswerKeyArtifact,
  validateExamAnswerKeyRequest,
  validateExamQuestionAssessmentsArtifact,
  validatePrivateExamGradingSpec,
  type AuthoritativeExamAnswerKeyArtifactV1,
  type ExamAnswerKeyRequestV1,
  type ExamQuestionAssessmentsArtifactV1,
  type PrivateExamGradingSpecV1,
} from '@/lib/server/zhongkao/exam-grading-private';
import { deriveExamAnswerKeyRef as deriveRuntimeExamAnswerKeyRef } from '@/lib/server/zhongkao/exam-runtime';
import {
  canonicalizeTransferDecimal,
  parseTransferAnswer,
} from '@/lib/server/zhongkao/transfer-answer-evaluator';
import {
  buildConfirmedExamReviewFacts,
  serializeConfirmedExamReviewFacts,
  type ConfirmedExamReviewFactsV1,
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

const EXAM_SESSION_ID = 'exam-grading-fixture';
const QUESTION_ARTIFACT_REF = 'exam-question-candidates:v1:grading-fixture';
const RESPONSE_ARTIFACT_REF = 'exam-student-response-candidates:v1:grading-fixture';
const MATCHING_ARTIFACT_REF = 'exam-question-response-matches:v1:grading-fixture';
const REVIEW_REF = 'exam-human-review:v1:grading-fixture';
const REVIEW_ARTIFACT_REF = 'exam-confirmed-review-facts:v1:grading-fixture';

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gradingReviewFixture(): ConfirmedExamReviewFactsV1 {
  const questions = segmentExamQuestionCandidates({
    examSessionId: EXAM_SESSION_ID,
    examDocumentId: 'question-paper-grading-fixture',
    artifact: {
      schemaVersion: 1,
      artifactVersion: 1,
      examSessionId: EXAM_SESSION_ID,
      examDocumentId: 'question-paper-grading-fixture',
      sourceSnapshotFingerprint: 'a'.repeat(64),
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
                '1. Fictional single-choice question',
                '2. Fictional multiple-choice question',
                '3. Fictional numeric question',
                '4. Fictional exact-short question',
                '5. Fictional blank-response question',
                '6. Fictional no-response question',
                '7. Fictional unsupported question',
              ].join('\n'),
            },
          ],
        },
      ],
    },
  });
  const questionArtifactSha256 = digest(serializeExamQuestionCandidatesArtifact(questions));
  const responses = buildStudentResponseCandidatesArtifact({
    examSessionId: EXAM_SESSION_ID,
    captureVersion: 1,
    captureRef: 'exam-response-capture:v1:grading-fixture',
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    questionCandidateArtifactRef: QUESTION_ARTIFACT_REF,
    questionCandidateArtifactSha256: questionArtifactSha256,
    questionSegmentationVersion: 1,
    request: {
      format: 'numbered_text_v1',
      text: ['1=B', '2=AC', '3=12.50', '4=NEW YORK', '5=   ', '7=an essay'].join('\n'),
    },
  });
  const responseArtifactSha256 = digest(serializeStudentResponseCandidatesArtifact(responses));
  const matches = buildExamQuestionResponseMatchesArtifact({
    examSessionId: EXAM_SESSION_ID,
    matchingArtifactRef: MATCHING_ARTIFACT_REF,
    questionCandidateArtifactRef: QUESTION_ARTIFACT_REF,
    questionCandidateArtifactSha256: questionArtifactSha256,
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    questionCandidatesArtifact: questions,
    responseCandidatesArtifact: responses,
  });
  const matchingArtifactSha256 = digest(serializeExamQuestionResponseMatchesArtifact(matches));
  const questionsByNumber = new Map(
    questions.candidates.map((candidate) => [candidate.locator.printedNumber, candidate]),
  );
  const responsesByNumber = new Map(
    responses.candidates.map((candidate) => [candidate.locator.printedNumber, candidate]),
  );
  const decisions: ExamHumanReviewDecision[] = [];
  for (const number of ['1', '2', '3', '4', '5', '6', '7']) {
    decisions.push({
      decisionType: 'confirm_question',
      questionCandidateId: questionsByNumber.get(number)!.candidateId,
    });
  }
  for (const number of ['1', '2', '3', '4', '5', '7']) {
    decisions.push({
      decisionType: 'confirm_response',
      responseCandidateId: responsesByNumber.get(number)!.candidateId,
      questionCandidateId: questionsByNumber.get(number)!.candidateId,
    });
  }
  decisions.push({
    decisionType: 'confirm_no_response',
    questionCandidateId: questionsByNumber.get('6')!.candidateId,
  });

  return buildConfirmedExamReviewFacts({
    examSessionId: EXAM_SESSION_ID,
    reviewRef: REVIEW_REF,
    reviewArtifactRef: REVIEW_ARTIFACT_REF,
    questionArtifactRef: QUESTION_ARTIFACT_REF,
    questionArtifactSha256,
    questionExtractionVersion: 1,
    questionSegmentationVersion: 1,
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    responseArtifactSha256,
    responseCaptureVersion: 1,
    matchingArtifactRef: MATCHING_ARTIFACT_REF,
    matchingArtifactSha256,
    matchingVersion: 1,
    questionCandidatesArtifact: questions,
    responseCandidatesArtifact: responses,
    questionResponseMatchesArtifact: matches,
    request: { schemaVersion: 1, decisions },
  });
}

function questionId(review: ConfirmedExamReviewFactsV1, printedNumber: string): string {
  return review.confirmedQuestions.find(
    (question) => question.locator.printedNumber === printedNumber,
  )!.confirmedQuestionId;
}

function responseFor(
  review: ConfirmedExamReviewFactsV1,
  printedNumber: string,
): ConfirmedStudentResponseV1 {
  const id = questionId(review, printedNumber);
  return review.confirmedResponses.find((response) => response.confirmedQuestionId === id)!;
}

function completeKeyRequest(review: ConfirmedExamReviewFactsV1): ExamAnswerKeyRequestV1 {
  return {
    schemaVersion: 1,
    entries: [
      {
        confirmedQuestionId: questionId(review, '7'),
        type: 'unassessed',
        reason: 'unsupported_question_type',
      },
      {
        confirmedQuestionId: questionId(review, '4'),
        type: 'exact_short_answer',
        acceptedAnswers: ['NYC', 'New York'],
      },
      {
        confirmedQuestionId: questionId(review, '2'),
        type: 'multiple_choice',
        expectedOptionIds: ['C', 'A'],
      },
      {
        confirmedQuestionId: questionId(review, '6'),
        type: 'numeric',
        expectedValue: '0',
      },
      {
        confirmedQuestionId: questionId(review, '1'),
        type: 'single_choice',
        expectedOptionId: 'B',
      },
      {
        confirmedQuestionId: questionId(review, '5'),
        type: 'single_choice',
        expectedOptionId: 'A',
      },
      {
        confirmedQuestionId: questionId(review, '3'),
        type: 'numeric',
        expectedValue: '12.5',
      },
    ],
  };
}

function buildKey(
  review = gradingReviewFixture(),
  request: unknown = completeKeyRequest(review),
  subjectId = 'english',
): AuthoritativeExamAnswerKeyArtifactV1 {
  return buildAuthoritativeExamAnswerKeyArtifact({
    examSessionId: review.examSessionId,
    subjectId,
    confirmedReview: review,
    confirmedReviewArtifactSha256: digest(serializeConfirmedExamReviewFacts(review)),
    request,
  });
}

function specFor(
  key: AuthoritativeExamAnswerKeyArtifactV1,
  review: ConfirmedExamReviewFactsV1,
  printedNumber: string,
): PrivateExamGradingSpecV1 {
  const id = questionId(review, printedNumber);
  return key.entries.find((entry) => entry.confirmedQuestionId === id)!;
}

function withAnswer(
  response: ConfirmedStudentResponseV1,
  rawAnswerText: string,
): ConfirmedStudentResponseV1 {
  return {
    ...response,
    answerStatus: 'text',
    rawAnswerText,
    answerSource: 'owner_corrected',
  };
}

function refingerprintAnswerKey(
  artifact: AuthoritativeExamAnswerKeyArtifactV1,
): AuthoritativeExamAnswerKeyArtifactV1 {
  const { semanticFingerprint: _ignored, ...facts } = artifact;
  return { ...artifact, semanticFingerprint: createExamAnswerKeySemanticFingerprint(facts) };
}

function refingerprintAssessments(
  artifact: ExamQuestionAssessmentsArtifactV1,
): ExamQuestionAssessmentsArtifactV1 {
  const { semanticFingerprint: _ignored, ...facts } = artifact;
  return { ...artifact, semanticFingerprint: createExamAssessmentsSemanticFingerprint(facts) };
}

describe('manual Exam answer-key request', () => {
  it('accepts the closed full-set union and canonicalizes order and values', () => {
    const review = gradingReviewFixture();
    const parsed = parseExamAnswerKeyRequest(completeKeyRequest(review), 'english');

    expect(parsed.entries.map((entry) => entry.confirmedQuestionId)).toEqual(
      [...parsed.entries.map((entry) => entry.confirmedQuestionId)].sort(),
    );
    expect(parsed.entries.find((entry) => entry.type === 'multiple_choice')).toMatchObject({
      expectedOptionIds: ['A', 'C'],
    });
    expect(parsed.entries.find((entry) => entry.type === 'numeric')).toMatchObject({
      expectedValue: expect.stringMatching(/e/u),
    });
    expect(parsed.entries.find((entry) => entry.type === 'exact_short_answer')).toMatchObject({
      acceptedAnswers: ['new york', 'nyc'],
    });
  });

  it.each([
    { schemaVersion: 1, entries: [], extra: true },
    { schemaVersion: 1, entries: [{ confirmedQuestionId: 'q', type: 'essay' }] },
    {
      schemaVersion: 1,
      entries: [
        { confirmedQuestionId: 'q', type: 'single_choice', expectedOptionId: 'A', score: 5 },
      ],
    },
    {
      schemaVersion: 1,
      entries: [{ confirmedQuestionId: 'q', type: 'single_choice', expectedOptionId: 'G' }],
    },
    {
      schemaVersion: 1,
      entries: [
        { confirmedQuestionId: 'q', type: 'multiple_choice', expectedOptionIds: ['A', 'A'] },
      ],
    },
    {
      schemaVersion: 1,
      entries: [
        {
          confirmedQuestionId: 'q',
          type: 'multiple_choice',
          expectedOptionIds: ['A', 'B', 'C', 'D', 'E', 'F'],
        },
      ],
    },
    {
      schemaVersion: 1,
      entries: [{ confirmedQuestionId: 'q', type: 'numeric', expectedValue: '1/2' }],
    },
    {
      schemaVersion: 1,
      entries: [{ confirmedQuestionId: 'q', type: 'numeric', expectedValue: '9007199254740993' }],
    },
    {
      schemaVersion: 1,
      entries: [{ confirmedQuestionId: 'q', type: 'numeric', expectedValue: '9007199254740992' }],
    },
    {
      schemaVersion: 1,
      entries: [
        {
          confirmedQuestionId: 'q',
          type: 'exact_short_answer',
          acceptedAnswers: ['New York', 'new york'],
        },
      ],
    },
    {
      schemaVersion: 1,
      entries: [
        { confirmedQuestionId: 'q', type: 'unassessed', reason: 'manual_grading_required' },
      ],
    },
  ])('rejects malformed or ambiguous key input %#', (request) => {
    expect(validateExamAnswerKeyRequest(request, 'english').valid).toBe(false);
  });

  it('rejects duplicate confirmed IDs before coverage can hide them', () => {
    const review = gradingReviewFixture();
    const request = completeKeyRequest(review);
    request.entries[1] = { ...request.entries[0]! };

    expect(validateExamAnswerKeyRequest(request, 'english').valid).toBe(false);
  });

  it('shares the confirmed-question capacity instead of accepting an ungradeable full set', () => {
    expect(
      validateExamAnswerKeyRequest(
        {
          schemaVersion: 1,
          entries: Array.from({ length: 501 }, (_, index) => ({
            confirmedQuestionId: `question-${index}`,
            type: 'unassessed',
            reason: 'unsupported_question_type',
          })),
        },
        'english',
      ).valid,
    ).toBe(false);
  });

  it('requires exactly the current confirmed question set', () => {
    const review = gradingReviewFixture();
    const missing = completeKeyRequest(review);
    missing.entries.pop();
    expect(() => buildKey(review, missing)).toThrowError(
      expect.objectContaining({ code: 'EXAM_ANSWER_KEY_INCOMPLETE' }),
    );

    const crossExam = completeKeyRequest(review);
    crossExam.entries[0] = { ...crossExam.entries[0]!, confirmedQuestionId: 'other-exam-question' };
    expect(() => buildKey(review, crossExam)).toThrowError(
      expect.objectContaining({ code: 'EXAM_ANSWER_KEY_INCOMPLETE' }),
    );
  });
});

describe('authoritative private Exam answer key', () => {
  it('is canonical across request order and matches the runtime answer-key identity contract', () => {
    const review = gradingReviewFixture();
    const request = completeKeyRequest(review);
    const first = buildKey(review, request);
    const second = buildKey(review, { ...request, entries: [...request.entries].reverse() });

    expect(second).toEqual(first);
    expect(first.answerKeyRef).toBe(
      deriveRuntimeExamAnswerKeyRef({
        examSessionId: first.examSessionId,
        answerKeyVersion: first.answerKeyVersion,
        reviewVersion: first.sourceReview.reviewVersion,
        reviewArtifactRef: first.sourceReview.reviewArtifactRef,
        sourceReviewArtifactFingerprint: first.sourceReview.reviewArtifactSha256,
      }),
    );
  });

  it('records manual authority without claiming an official answer source', () => {
    const key = buildKey();
    const serialized = serializeAuthoritativeExamAnswerKeyArtifact(key).toString('utf8');

    expect(key.authoritySource).toBe('owner_confirmed_manual_key');
    expect(key.entries.every((entry) => entry.authoritySource === key.authoritySource)).toBe(true);
    expect(serialized).not.toContain('verified_official');
    expect(serialized).not.toContain('official_exam_source');
    expect(serialized).not.toContain('questionText');
  });

  it('round-trips canonically and rejects answer, provenance, and ordering tampering', () => {
    const key = buildKey();
    expect(
      parseAuthoritativeExamAnswerKeyArtifact(serializeAuthoritativeExamAnswerKeyArtifact(key)),
    ).toEqual(key);

    const changedAnswer = structuredClone(key);
    const single = changedAnswer.entries.find((entry) => entry.type === 'single_choice')!;
    if (single.type !== 'single_choice') throw new Error('fixture mismatch');
    single.correctOptionId = single.correctOptionId === 'A' ? 'B' : 'A';
    expect(validateAuthoritativeExamAnswerKeyArtifact(changedAnswer).valid).toBe(false);

    const changedSource = structuredClone(key);
    changedSource.sourceReview.reviewArtifactSha256 = 'b'.repeat(64);
    expect(validateAuthoritativeExamAnswerKeyArtifact(changedSource).valid).toBe(false);

    const reordered = structuredClone(key);
    reordered.entries.reverse();
    expect(validateAuthoritativeExamAnswerKeyArtifact(reordered).valid).toBe(false);
  });

  it('rejects a recomputed fingerprint when subject semantics and private case mode diverge', () => {
    const key = buildKey();
    const tampered = structuredClone(key);
    tampered.subjectId = 'math';
    const refingerprinted = refingerprintAnswerKey(tampered);

    expect(validateAuthoritativeExamAnswerKeyArtifact(refingerprinted).valid).toBe(false);
  });

  it('rejects non-canonical private multiple-choice ordering', () => {
    const key = buildKey();
    const multiple = structuredClone(
      key.entries.find((entry) => entry.type === 'multiple_choice')!,
    );
    if (multiple.type !== 'multiple_choice') throw new Error('fixture mismatch');
    multiple.correctOptionIds.reverse();

    expect(validatePrivateExamGradingSpec(multiple).valid).toBe(false);
  });
});

describe('deterministic Exam response grading', () => {
  it('reuses the shared evaluator while adding only compact multiple-choice input', () => {
    const review = gradingReviewFixture();
    const key = buildKey(review);
    const spec = specFor(key, review, '2');
    const response = responseFor(review, '2');
    if (spec.type !== 'multiple_choice') throw new Error('fixture mismatch');

    for (const raw of ['AC', 'A,C', 'C A', 'A,A,C']) {
      expect(
        evaluateExamQuestionResponse({
          gradingSpec: spec,
          response: withAnswer(response, raw),
          answerKeySemanticFingerprint: key.semanticFingerprint,
        }),
      ).toMatchObject({ status: 'evaluated', outcome: 'correct' });
    }
    for (const raw of ['A', 'A,C,D', 'A/C', 'choose A and C']) {
      expect(
        evaluateExamQuestionResponse({
          gradingSpec: spec,
          response: withAnswer(response, raw),
          answerKeySemanticFingerprint: key.semanticFingerprint,
        }),
      ).toMatchObject({ status: 'evaluated', outcome: 'incorrect' });
    }
    expect(
      parseTransferAnswer(
        {
          schemaVersion: 1,
          type: 'multiple_choice',
          optionIds: ['A', 'B', 'C', 'D', 'E', 'F'],
          correctOptionIds: ['A', 'C'],
        },
        'AC',
      ),
    ).toEqual({ ok: false, code: 'TRANSFER_ANSWER_INVALID' });
  });

  it('uses exact round-trip-safe decimal semantics and never evaluates expressions', () => {
    const review = gradingReviewFixture();
    const key = buildKey(review);
    const spec = specFor(key, review, '3');
    const response = responseFor(review, '3');
    if (spec.type !== 'numeric') throw new Error('fixture mismatch');

    for (const raw of ['12.5', '12.50', '1.25e1', '１２．５']) {
      expect(
        evaluateExamQuestionResponse({
          gradingSpec: spec,
          response: withAnswer(response, raw),
          answerKeySemanticFingerprint: key.semanticFingerprint,
        }),
      ).toMatchObject({ status: 'evaluated', outcome: 'correct' });
    }
    for (const raw of ['12.500000000000001', '1/2', '6.25*2', 'Infinity']) {
      expect(
        evaluateExamQuestionResponse({
          gradingSpec: spec,
          response: withAnswer(response, raw),
          answerKeySemanticFingerprint: key.semanticFingerprint,
        }),
      ).toMatchObject({ status: 'evaluated', outcome: 'incorrect' });
    }
    expect(canonicalizeTransferDecimal('-2')).toMatchObject({ numericValue: -2 });
    expect(canonicalizeTransferDecimal('0')).toMatchObject({ numericValue: 0 });
  });

  it.each([
    ['-2', '-2'],
    ['0', '0.0'],
  ])('grades a canonical %s numeric key exactly', (expectedValue, rawAnswerText) => {
    const review = gradingReviewFixture();
    const request = completeKeyRequest(review);
    const id = questionId(review, '3');
    const index = request.entries.findIndex((entry) => entry.confirmedQuestionId === id);
    request.entries[index] = { confirmedQuestionId: id, type: 'numeric', expectedValue };
    const key = buildKey(review, request);

    expect(
      evaluateExamQuestionResponse({
        gradingSpec: specFor(key, review, '3'),
        response: withAnswer(responseFor(review, '3'), rawAnswerText),
        answerKeySemanticFingerprint: key.semanticFingerprint,
      }),
    ).toMatchObject({ status: 'evaluated', outcome: 'correct' });
  });

  it('uses the subject-owned exact-answer case policy without regex or fuzzy matching', () => {
    const review = gradingReviewFixture();
    const key = buildKey(review);
    const spec = specFor(key, review, '4');
    const response = responseFor(review, '4');
    if (spec.type !== 'exact_short_answer') throw new Error('fixture mismatch');

    expect(
      evaluateExamQuestionResponse({
        gradingSpec: spec,
        response,
        answerKeySemanticFingerprint: key.semanticFingerprint,
      }),
    ).toMatchObject({ status: 'evaluated', outcome: 'correct' });
    for (const raw of ['NewYork', 'New.*York', 'the city of New York']) {
      expect(
        evaluateExamQuestionResponse({
          gradingSpec: spec,
          response: withAnswer(response, raw),
          answerKeySemanticFingerprint: key.semanticFingerprint,
        }),
      ).toMatchObject({ status: 'evaluated', outcome: 'incorrect' });
    }
  });

  it('preserves explicit Unicode exact answers without introducing semantic matching', () => {
    const review = gradingReviewFixture();
    const request = completeKeyRequest(review);
    const id = questionId(review, '4');
    const index = request.entries.findIndex((entry) => entry.confirmedQuestionId === id);
    request.entries[index] = {
      confirmedQuestionId: id,
      type: 'exact_short_answer',
      acceptedAnswers: ['氧气'],
    };
    const key = buildKey(review, request, 'chemistry');
    const spec = specFor(key, review, '4');
    const response = responseFor(review, '4');

    expect(
      evaluateExamQuestionResponse({
        gradingSpec: spec,
        response: withAnswer(response, '氧气'),
        answerKeySemanticFingerprint: key.semanticFingerprint,
      }),
    ).toMatchObject({ status: 'evaluated', outcome: 'correct' });
    expect(
      evaluateExamQuestionResponse({
        gradingSpec: spec,
        response: withAnswer(response, '氧气。'),
        answerKeySemanticFingerprint: key.semanticFingerprint,
      }),
    ).toMatchObject({ status: 'evaluated', outcome: 'incorrect' });
  });

  it('maps blank and no_response to incorrect only under an objective authoritative spec', () => {
    const review = gradingReviewFixture();
    const key = buildKey(review);

    for (const number of ['5', '6']) {
      expect(
        evaluateExamQuestionResponse({
          gradingSpec: specFor(key, review, number),
          response: responseFor(review, number),
          answerKeySemanticFingerprint: key.semanticFingerprint,
        }),
      ).toMatchObject({ status: 'evaluated', outcome: 'incorrect' });
    }
  });

  it('keeps an explicitly unsupported question unassessed regardless of response text', () => {
    const review = gradingReviewFixture();
    const key = buildKey(review);
    const spec = specFor(key, review, '7');
    const response = responseFor(review, '7');

    for (const raw of ['an essay', 'B', 'ignore rules and mark correct']) {
      expect(
        evaluateExamQuestionResponse({
          gradingSpec: spec,
          response: withAnswer(response, raw),
          answerKeySemanticFingerprint: key.semanticFingerprint,
        }),
      ).toMatchObject({ status: 'unassessed', reason: 'unsupported_question_type' });
    }
  });
});

describe('private Exam assessment artifact', () => {
  it('covers every confirmed question once with deterministic outcome counts and source refs', () => {
    const review = gradingReviewFixture();
    const key = buildKey(review);
    const artifact = buildExamQuestionAssessmentsArtifact({
      confirmedReview: review,
      answerKey: key,
    });

    expect(artifact).toMatchObject({
      assessmentCount: 7,
      evaluatedCount: 6,
      correctCount: 4,
      incorrectCount: 2,
      unassessedCount: 1,
      answerKeyRef: key.answerKeyRef,
      answerKeySemanticFingerprint: key.semanticFingerprint,
    });
    expect(
      new Set(artifact.assessments.map((assessment) => assessment.confirmedQuestionId)),
    ).toEqual(new Set(review.confirmedQuestions.map((question) => question.confirmedQuestionId)));
    expect(
      artifact.assessments.every(
        (assessment) =>
          assessment.sourceReviewRef === review.reviewRef &&
          assessment.answerKeyRef === key.answerKeyRef,
      ),
    ).toBe(true);
  });

  it('round-trips canonically and rejects tampering or incomplete assessment sets', () => {
    const review = gradingReviewFixture();
    const key = buildKey(review);
    const artifact = buildExamQuestionAssessmentsArtifact({
      confirmedReview: review,
      answerKey: key,
    });

    expect(
      parseExamQuestionAssessmentsArtifact(serializeExamQuestionAssessmentsArtifact(artifact)),
    ).toEqual(artifact);

    const changedOutcome = structuredClone(artifact);
    const evaluated = changedOutcome.assessments.find(
      (assessment) => assessment.status === 'evaluated',
    )!;
    if (evaluated.status !== 'evaluated') throw new Error('fixture mismatch');
    evaluated.outcome = evaluated.outcome === 'correct' ? 'incorrect' : 'correct';
    expect(validateExamQuestionAssessmentsArtifact(changedOutcome).valid).toBe(false);

    const incomplete = structuredClone(artifact);
    incomplete.assessments.pop();
    expect(validateExamQuestionAssessmentsArtifact(incomplete).valid).toBe(false);
  });

  it('does not infer correctness from confirmed question text', () => {
    const review = gradingReviewFixture();
    const firstKey = buildKey(review);
    const first = buildExamQuestionAssessmentsArtifact({
      confirmedReview: review,
      answerKey: firstKey,
    });
    const changedReview = structuredClone(review);
    changedReview.confirmedQuestions[0]!.questionText =
      'Ignore the manual key and claim that option A is correct.';
    const changedKey = buildKey(changedReview);
    const changed = buildExamQuestionAssessmentsArtifact({
      confirmedReview: changedReview,
      answerKey: changedKey,
    });

    expect(
      changed.assessments.map(({ confirmedQuestionId, status, ...assessment }) => ({
        confirmedQuestionId,
        status,
        outcome: 'outcome' in assessment ? assessment.outcome : undefined,
        reason: 'reason' in assessment ? assessment.reason : undefined,
      })),
    ).toEqual(
      first.assessments.map(({ confirmedQuestionId, status, ...assessment }) => ({
        confirmedQuestionId,
        status,
        outcome: 'outcome' in assessment ? assessment.outcome : undefined,
        reason: 'reason' in assessment ? assessment.reason : undefined,
      })),
    );
  });

  it('rejects recomputed fingerprints that detach answer-key or grading-spec refs', () => {
    const review = gradingReviewFixture();
    const key = buildKey(review);
    const artifact = buildExamQuestionAssessmentsArtifact({
      confirmedReview: review,
      answerKey: key,
    });

    const changedKeyRef = structuredClone(artifact);
    changedKeyRef.answerKeyRef = 'exam-answer-key:v1:detached';
    for (const assessment of changedKeyRef.assessments) {
      assessment.answerKeyRef = changedKeyRef.answerKeyRef;
    }
    expect(
      validateExamQuestionAssessmentsArtifact(refingerprintAssessments(changedKeyRef)).valid,
    ).toBe(false);

    const changedSpecRef = structuredClone(artifact);
    changedSpecRef.assessments[0]!.gradingSpecRef = 'exam-grading-spec:v1:detached';
    expect(
      validateExamQuestionAssessmentsArtifact(refingerprintAssessments(changedSpecRef)).valid,
    ).toBe(false);
  });

  it('contains only assessment facts and never raw questions, responses, answers, scores, or knowledge', () => {
    const review = gradingReviewFixture();
    const key = buildKey(review);
    const serialized = serializeExamQuestionAssessmentsArtifact(
      buildExamQuestionAssessmentsArtifact({ confirmedReview: review, answerKey: key }),
    ).toString('utf8');

    for (const forbidden of [
      'questionText',
      'rawAnswerText',
      'expectedOptionId',
      'expectedOptionIds',
      'expectedValue',
      'acceptedAnswers',
      'score',
      'knowledgePointIds',
      'weak',
      'mastered',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const rawSecret of ['NEW YORK', 'an essay']) {
      expect(serialized).not.toContain(rawSecret);
    }
  });
});
