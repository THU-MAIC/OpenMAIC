import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { detectExamObservableErrorSuggestions } from '@/lib/server/zhongkao/exam-error-observable-detector';
import {
  buildConfirmedExamErrorPatternReviewArtifact,
  createConfirmedExamErrorPatternReviewSemanticFingerprint,
  ExamErrorReviewPrivateError,
  parseConfirmedExamErrorPatternReviewArtifact,
  serializeConfirmedExamErrorPatternReviewArtifact,
  validateConfirmedExamErrorPatternReviewArtifact,
  type BuildConfirmedExamErrorPatternReviewArtifactInput,
  type ConfirmedExamErrorPatternReviewArtifactV1,
} from '@/lib/server/zhongkao/exam-error-review-private';
import {
  buildExamErrorSuggestionsArtifact,
  createExamErrorSuggestionsSemanticFingerprint,
  serializeExamErrorSuggestionsArtifact,
} from '@/lib/server/zhongkao/exam-error-suggestions-private';
import {
  buildAuthoritativeExamAnswerKeyArtifact,
  buildExamQuestionAssessmentsArtifact,
  serializeAuthoritativeExamAnswerKeyArtifact,
  serializeExamQuestionAssessmentsArtifact,
} from '@/lib/server/zhongkao/exam-grading-private';
import {
  EXAM_ERROR_PATTERN_AUTHORITY_SOURCE,
  EXAM_ERROR_REVIEW_LIMITS,
  deriveConfirmedExamErrorPatternObservationId,
  type ExamErrorReviewDecision,
  type ExamErrorReviewRequestV1,
} from '@/lib/zhongkao/exam-error-review';
import {
  EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION,
  EXAM_ERROR_MODEL_POLICY_VERSION,
  EXAM_ERROR_OBSERVABLE_RULES_VERSION,
  EXAM_ERROR_SUGGESTION_SCHEMA_VERSION,
} from '@/lib/zhongkao/exam-error-suggestions';
import {
  buildConfirmedExamReviewFacts,
  serializeConfirmedExamReviewFacts,
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

const EXAM_SESSION_ID = 'exam-error-review-fixture';
const PROFILE_ID = 'fictional-error-review-profile';
const SUBJECT_ID = 'math';
const REVIEWED_AT = '2026-09-06T10:00:00.000Z';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Build the complete upstream authority chain so eligibility and grounded evidence are real.
function sourceFixture() {
  const questionRef = 'question-candidates:error-review';
  const responseRef = 'response-candidates:error-review';
  const matchingRef = 'response-matches:error-review';
  const questions = segmentExamQuestionCandidates({
    examSessionId: EXAM_SESSION_ID,
    examDocumentId: 'question-paper-error-review',
    artifact: {
      schemaVersion: 1,
      artifactVersion: 1,
      examSessionId: EXAM_SESSION_ID,
      examDocumentId: 'question-paper-error-review',
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
                '1. Choose one fictional option.',
                '2. Give the correct number.',
                '3. Explain the fictional open question.',
                '4. Give the final length in metres.',
                '5. Name the fictional gas.',
                '6. Choose another fictional option.',
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
    captureRef: 'response-capture:error-review',
    responseArtifactRef: responseRef,
    questionCandidateArtifactRef: questionRef,
    questionCandidateArtifactSha256: questionSha,
    questionSegmentationVersion: 1,
    request: { format: 'numbered_text_v1', text: '1=C\n2=2\n3=essay\n4=5 cm\n5=O2\n6=A' },
  });
  const responseSha = digest(serializeStudentResponseCandidatesArtifact(responses));
  const matches = buildExamQuestionResponseMatchesArtifact({
    examSessionId: EXAM_SESSION_ID,
    matchingArtifactRef: matchingRef,
    questionCandidateArtifactRef: questionRef,
    questionCandidateArtifactSha256: questionSha,
    responseArtifactRef: responseRef,
    questionCandidatesArtifact: questions,
    responseCandidatesArtifact: responses,
  });
  const decisions: ExamHumanReviewDecision[] = questions.candidates.flatMap((question) => [
    { decisionType: 'confirm_question', questionCandidateId: question.candidateId },
    {
      decisionType: 'confirm_response',
      questionCandidateId: question.candidateId,
      responseCandidateId: responses.candidates.find(
        (response) => response.locator.printedNumber === question.locator.printedNumber,
      )!.candidateId,
    },
  ]);
  const review = buildConfirmedExamReviewFacts({
    examSessionId: EXAM_SESSION_ID,
    reviewRef: 'human-review:error-review',
    reviewArtifactRef: 'confirmed-review:error-review',
    questionArtifactRef: questionRef,
    questionArtifactSha256: questionSha,
    questionExtractionVersion: 1,
    questionSegmentationVersion: 1,
    responseArtifactRef: responseRef,
    responseArtifactSha256: responseSha,
    responseCaptureVersion: 1,
    matchingArtifactRef: matchingRef,
    matchingArtifactSha256: digest(serializeExamQuestionResponseMatchesArtifact(matches)),
    matchingVersion: 1,
    questionCandidatesArtifact: questions,
    responseCandidatesArtifact: responses,
    questionResponseMatchesArtifact: matches,
    request: { schemaVersion: 1, decisions },
  });
  const questionId = (number: string) =>
    review.confirmedQuestions.find((question) => question.locator.printedNumber === number)!
      .confirmedQuestionId;
  const reviewSha = digest(serializeConfirmedExamReviewFacts(review));
  const answerKey = buildAuthoritativeExamAnswerKeyArtifact({
    examSessionId: EXAM_SESSION_ID,
    subjectId: SUBJECT_ID,
    confirmedReview: review,
    confirmedReviewArtifactSha256: reviewSha,
    request: {
      schemaVersion: 1,
      entries: [
        { confirmedQuestionId: questionId('1'), type: 'single_choice', expectedOptionId: 'B' },
        { confirmedQuestionId: questionId('2'), type: 'numeric', expectedValue: '2' },
        {
          confirmedQuestionId: questionId('3'),
          type: 'unassessed',
          reason: 'unsupported_question_type',
        },
        { confirmedQuestionId: questionId('4'), type: 'numeric', expectedValue: '5' },
        {
          confirmedQuestionId: questionId('5'),
          type: 'exact_short_answer',
          acceptedAnswers: ['oxygen'],
        },
        { confirmedQuestionId: questionId('6'), type: 'single_choice', expectedOptionId: 'B' },
      ],
    },
  });
  const assessments = buildExamQuestionAssessmentsArtifact({ confirmedReview: review, answerKey });
  const drafts = detectExamObservableErrorSuggestions({
    confirmedReview: review,
    answerKey,
    assessments,
  });
  const source = buildExamErrorSuggestionsArtifact({
    examSessionId: EXAM_SESSION_ID,
    profileId: PROFILE_ID,
    subjectId: SUBJECT_ID,
    confirmedReview: review,
    confirmedReviewArtifactSha256: reviewSha,
    answerKey,
    answerKeyArtifactRef: 'answer-key:error-review',
    answerKeyArtifactSha256: digest(serializeAuthoritativeExamAnswerKeyArtifact(answerKey)),
    assessments,
    assessmentArtifactRef: 'assessments:error-review',
    assessmentArtifactSha256: digest(serializeExamQuestionAssessmentsArtifact(assessments)),
    generator: {
      generatorVersion: EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION,
      detectorVersion: EXAM_ERROR_OBSERVABLE_RULES_VERSION,
      modelPolicyVersion: EXAM_ERROR_MODEL_POLICY_VERSION,
      candidateSchemaVersion: EXAM_ERROR_SUGGESTION_SCHEMA_VERSION,
    },
    modelExecution: {
      status: 'used',
      stage: 'exam-error-suggestions',
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
    },
    questionDrafts: drafts.map((draft) =>
      draft.confirmedQuestionId !== questionId('4')
        ? draft
        : {
            ...draft,
            suggestions: [
              ...draft.suggestions,
              {
                kind: 'unit_error_candidate',
                generationSource: 'model_candidate',
                candidateStatus: 'candidate',
                confidenceBand: 'medium',
                evidence: [
                  { evidenceType: 'text_span', source: 'question', text: 'metres' },
                  { evidenceType: 'text_span', source: 'response', text: 'cm' },
                ],
              },
            ],
          },
    ),
  });
  return { source, questionId, assessments };
}

function inputFixture(decision: ExamErrorReviewDecision = 'accept') {
  const fixture = sourceFixture();
  const input: BuildConfirmedExamErrorPatternReviewArtifactInput = {
    examSessionId: EXAM_SESSION_ID,
    profileId: PROFILE_ID,
    subjectId: SUBJECT_ID,
    reviewedAt: REVIEWED_AT,
    sourceCandidates: fixture.source,
    sourceCandidateArtifactSha256: digest(serializeExamErrorSuggestionsArtifact(fixture.source)),
    request: {
      schemaVersion: 1,
      questions: fixture.source.questions.map((question) => ({
        confirmedQuestionId: question.confirmedQuestionId,
        candidateDecisions: question.suggestions.map((candidate) => ({
          candidateId: candidate.candidateId,
          decision,
        })),
      })),
    },
  };
  return { ...fixture, input };
}

function rehash(artifact: ConfirmedExamErrorPatternReviewArtifactV1) {
  const { semanticFingerprint: _ignored, ...facts } = artifact;
  return {
    ...facts,
    semanticFingerprint: createConfirmedExamErrorPatternReviewSemanticFingerprint(facts),
  };
}

function rejectsCorrupt(value: unknown) {
  expect(validateConfirmedExamErrorPatternReviewArtifact(value)).toMatchObject({ valid: false });
  expect(() => parseConfirmedExamErrorPatternReviewArtifact(value)).toThrow(
    'EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT',
  );
}

describe('Private confirmed Exam error pattern review artifact', () => {
  it('requires explicit decisions for all eligible incorrect questions including zero candidates', () => {
    const { input, source, questionId } = inputFixture();
    const artifact = buildConfirmedExamErrorPatternReviewArtifact(input);
    expect(source.eligibleQuestionCount).toBe(4);
    expect(
      source.questions.find((question) => question.confirmedQuestionId === questionId('5'))!
        .suggestions,
    ).toEqual([]);
    expect(
      artifact.questionResults.find((question) => question.confirmedQuestionId === questionId('5')),
    ).toEqual({
      confirmedQuestionId: questionId('5'),
      reviewedCandidateCount: 0,
      confirmedPatternCount: 0,
      hasConfirmedPattern: false,
    });
    expect(artifact.reviewedQuestionCount).toBe(source.eligibleQuestionCount);
    expect(artifact.reviewedCandidateCount).toBe(source.suggestionCount);
    expect(validateConfirmedExamErrorPatternReviewArtifact(artifact)).toEqual({ valid: true });
  });

  it('inherits deterministic and model pattern evidence only from the accepted candidate', () => {
    const { input, source } = inputFixture();
    const artifact = buildConfirmedExamErrorPatternReviewArtifact(input);
    expect(artifact.confirmedObservationCount).toBe(source.suggestionCount);
    expect(
      artifact.confirmedPatternObservations.some(
        (entry) => entry.candidateGenerationSource === 'model_candidate',
      ),
    ).toBe(true);
    expect(
      artifact.confirmedPatternObservations.some(
        (entry) => entry.candidateGenerationSource === 'deterministic_candidate',
      ),
    ).toBe(true);
    for (const question of source.questions)
      for (const candidate of question.suggestions) {
        expect(
          artifact.confirmedPatternObservations.find(
            (entry) => entry.sourceCandidateId === candidate.candidateId,
          ),
        ).toEqual({
          schemaVersion: 1,
          observationId: deriveConfirmedExamErrorPatternObservationId({
            examSessionId: EXAM_SESSION_ID,
            sourceCandidateId: candidate.candidateId,
            sourceCandidateArtifactFingerprint: input.sourceCandidateArtifactSha256,
            sourceCandidateSemanticFingerprint: source.semanticFingerprint,
            errorReviewVersion: 1,
          }),
          confirmedQuestionId: question.confirmedQuestionId,
          sourceCandidateId: candidate.candidateId,
          patternKind: candidate.kind,
          candidateGenerationSource: candidate.generationSource,
          evidence: candidate.evidence,
          authoritySource: EXAM_ERROR_PATTERN_AUTHORITY_SOURCE,
        });
      }
  });

  it('retains separate accepted observations for multiple patterns and repeated same-Exam patterns', () => {
    const { input, questionId } = inputFixture();
    const artifact = buildConfirmedExamErrorPatternReviewArtifact(input);
    expect(
      artifact.confirmedPatternObservations.filter(
        (entry) => entry.confirmedQuestionId === questionId('4'),
      ),
    ).toHaveLength(2);
    const repeated = artifact.confirmedPatternObservations.filter(
      (entry) => entry.patternKind === 'single_choice_option_mismatch_candidate',
    );
    expect(repeated).toHaveLength(2);
    expect(new Set(repeated.map((entry) => entry.observationId)).size).toBe(2);
  });

  it('reject-all retains full audit decisions without negative pattern or correctness facts', () => {
    const { input, source, assessments } = inputFixture('reject');
    const originalAssessments = serializeExamQuestionAssessmentsArtifact(assessments);
    const artifact = buildConfirmedExamErrorPatternReviewArtifact(input);
    expect(artifact.confirmedPatternObservations).toEqual([]);
    expect(artifact.acceptedCandidateCount).toBe(0);
    expect(artifact.rejectedCandidateCount).toBe(source.suggestionCount);
    expect(
      artifact.questions
        .flatMap((question) => question.candidateDecisions)
        .every((entry) => entry.decision === 'reject'),
    ).toBe(true);
    expect(artifact.questionResults.every((entry) => !entry.hasConfirmedPattern)).toBe(true);
    expect(serializeExamQuestionAssessmentsArtifact(assessments)).toEqual(originalAssessments);
    for (const field of [
      'no_error',
      'no_cause',
      'correctness',
      'outcome',
      'mastery',
      'knowledgePointIds',
    ]) {
      expect(JSON.stringify(artifact)).not.toContain(`"${field}"`);
    }
  });

  it('accepts deterministic and model candidates independently without automatic confirmation', () => {
    const { input, source } = inputFixture();
    const modelId = source.questions
      .flatMap((question) => question.suggestions)
      .find((candidate) => candidate.generationSource === 'model_candidate')!.candidateId;
    for (const acceptModel of [true, false]) {
      const request: ExamErrorReviewRequestV1 = {
        schemaVersion: 1,
        questions: input.request.questions.map((question) => ({
          ...question,
          candidateDecisions: question.candidateDecisions.map((decision) => ({
            candidateId: decision.candidateId,
            decision: (decision.candidateId === modelId) === acceptModel ? 'accept' : 'reject',
          })),
        })),
      };
      const artifact = buildConfirmedExamErrorPatternReviewArtifact({ ...input, request });
      expect(
        artifact.confirmedPatternObservations.some((entry) => entry.sourceCandidateId === modelId),
      ).toBe(acceptModel);
      expect(artifact.acceptedCandidateCount).toBe(
        acceptModel ? 1 : source.deterministicSuggestionCount,
      );
      expect(artifact.acceptedCandidateCount + artifact.rejectedCandidateCount).toBe(
        source.suggestionCount,
      );
    }
  });

  it('replays reordered requests with identical canonical bytes, fingerprints, and IDs', () => {
    const { input } = inputFixture();
    const reordered = {
      ...input.request,
      questions: [...input.request.questions].reverse().map((question) => ({
        ...question,
        candidateDecisions: [...question.candidateDecisions].reverse(),
      })),
    };
    const first = buildConfirmedExamErrorPatternReviewArtifact(input);
    const second = buildConfirmedExamErrorPatternReviewArtifact({ ...input, request: reordered });
    expect(second).toEqual(first);
    const bytes = serializeConfirmedExamErrorPatternReviewArtifact(first);
    expect(serializeConfirmedExamErrorPatternReviewArtifact(second)).toEqual(bytes);
    expect(parseConfirmedExamErrorPatternReviewArtifact(bytes)).toEqual(first);
    expect(serializeConfirmedExamErrorPatternReviewArtifact(new Uint8Array(bytes))).toEqual(bytes);
  });

  it('changes decision fingerprint when one explicit decision changes while retaining source identity', () => {
    const { input } = inputFixture();
    const original = buildConfirmedExamErrorPatternReviewArtifact(input);
    const request = structuredClone(input.request);
    request.questions.find(
      (question) => question.candidateDecisions.length > 0,
    )!.candidateDecisions[0].decision = 'reject';
    const changed = buildConfirmedExamErrorPatternReviewArtifact({ ...input, request });
    expect(changed.decisionSemanticFingerprint).not.toBe(original.decisionSemanticFingerprint);
    expect(changed.errorReviewRef).toBe(original.errorReviewRef);
    expect(changed.errorReviewArtifactRef).toBe(original.errorReviewArtifactRef);
    expect(changed.confirmedObservationCount).toBe(original.confirmedObservationCount - 1);
  });

  it('preserves source candidate artifact bytes, digest, and candidate status on accept and reject', () => {
    const { input } = inputFixture();
    const before = serializeExamErrorSuggestionsArtifact(input.sourceCandidates);
    const sourceDigest = digest(before);
    const artifact = buildConfirmedExamErrorPatternReviewArtifact(input);
    for (const question of input.request.questions)
      for (const decision of question.candidateDecisions) decision.decision = 'reject';
    buildConfirmedExamErrorPatternReviewArtifact(input);
    artifact.confirmedPatternObservations[0].evidence.splice(0);
    expect(serializeExamErrorSuggestionsArtifact(input.sourceCandidates)).toEqual(before);
    expect(digest(serializeExamErrorSuggestionsArtifact(input.sourceCandidates))).toBe(
      sourceDigest,
    );
    expect(
      input.sourceCandidates.questions
        .flatMap((question) => question.suggestions)
        .every((candidate) => candidate.candidateStatus === 'candidate'),
    ).toBe(true);
  });

  it.each([
    'missing-question',
    'missing-zero-question',
    'missing-candidate',
    'extra-candidate',
    'cross-question',
    'correct-question',
    'unassessed-question',
  ] as const)('rejects incomplete or foreign coverage: %s', (scenario) => {
    const { input, questionId } = inputFixture();
    const request = structuredClone(input.request);
    const nonempty = request.questions.find((question) => question.candidateDecisions.length > 0)!;
    if (scenario === 'missing-question')
      request.questions = request.questions.filter((question) => question !== nonempty);
    if (scenario === 'missing-zero-question')
      request.questions = request.questions.filter(
        (question) => question.confirmedQuestionId !== questionId('5'),
      );
    if (scenario === 'missing-candidate') nonempty.candidateDecisions.pop();
    if (scenario === 'extra-candidate')
      nonempty.candidateDecisions.push({
        candidateId: 'foreign-exam-candidate',
        decision: 'accept',
      });
    if (scenario === 'cross-question')
      request.questions
        .find((question) => question.confirmedQuestionId === questionId('5'))!
        .candidateDecisions.push(nonempty.candidateDecisions.pop()!);
    if (scenario === 'correct-question' || scenario === 'unassessed-question')
      request.questions.push({
        confirmedQuestionId: questionId(scenario === 'correct-question' ? '2' : '3'),
        candidateDecisions: [],
      });
    expect(() => buildConfirmedExamErrorPatternReviewArtifact({ ...input, request })).toThrow(
      'EXAM_ERROR_REVIEW_INCOMPLETE',
    );
  });

  it('rejects mismatched candidate digest, owner-profile partition, version, and requested private refs', () => {
    const { input } = inputFixture();
    for (const overrides of [
      { sourceCandidateArtifactSha256: 'f'.repeat(64) },
      { profileId: 'foreign-profile' },
      { examSessionId: 'foreign-exam' },
      { subjectId: 'physics' },
      { reviewedAt: 'invalid-date' },
      { errorReviewRef: 'foreign-review' },
      { errorReviewArtifactRef: 'foreign-artifact' },
      { sourceCandidates: { ...input.sourceCandidates, generationVersion: 2 } },
    ]) {
      expect(() =>
        buildConfirmedExamErrorPatternReviewArtifact({
          ...input,
          ...overrides,
        } as BuildConfirmedExamErrorPatternReviewArtifactInput),
      ).toThrow('EXAM_ERROR_REVIEW_SOURCE_INVALID');
    }
  });

  it.each(['correct', 'unassessed'])(
    'rejects rehashed source candidates with %s assessment outcome',
    (assessmentOutcome) => {
      const { input } = inputFixture();
      const source = structuredClone(input.sourceCandidates);
      Object.assign(source.questions[0], { assessmentOutcome });
      const { semanticFingerprint: _ignored, ...facts } = source;
      source.semanticFingerprint = createExamErrorSuggestionsSemanticFingerprint(facts);
      expect(() =>
        buildConfirmedExamErrorPatternReviewArtifact({ ...input, sourceCandidates: source }),
      ).toThrow('EXAM_ERROR_REVIEW_SOURCE_INVALID');
    },
  );

  it('rejects client extensions and repeated decisions with a stable private error', () => {
    const { input } = inputFixture();
    const request = structuredClone(input.request);
    const question = request.questions.find((entry) => entry.candidateDecisions.length > 0)!;
    question.candidateDecisions.push({ ...question.candidateDecisions[0] });
    for (const malformed of [
      request,
      { ...input.request, authoritySource: EXAM_ERROR_PATTERN_AUTHORITY_SOURCE },
    ]) {
      expect(() =>
        buildConfirmedExamErrorPatternReviewArtifact({ ...input, request: malformed }),
      ).toThrow('EXAM_ERROR_REVIEW_INPUT_INVALID');
    }
  });

  it('rejects malformed bytes and oversize private artifacts using only stable error codes', () => {
    for (const bytes of [
      Buffer.from('{'),
      Buffer.from([0xc3, 0x28]),
      Buffer.alloc(EXAM_ERROR_REVIEW_LIMITS.maxArtifactBytes + 1),
    ]) {
      expect(() => parseConfirmedExamErrorPatternReviewArtifact(bytes)).toThrow(
        ExamErrorReviewPrivateError,
      );
      expect(() => parseConfirmedExamErrorPatternReviewArtifact(bytes)).toThrow(
        'EXAM_ERROR_REVIEW_ARTIFACT_CORRUPT',
      );
    }
  });

  it('rejects closed-schema extensions at every trusted artifact nesting level', () => {
    const { input } = inputFixture();
    const artifact = buildConfirmedExamErrorPatternReviewArtifact(input);
    const mutations: Array<(value: ConfirmedExamErrorPatternReviewArtifactV1) => void> = [
      (value) => Object.assign(value, { confidence: 1 }),
      (value) => Object.assign(value.sourceSuggestions, { objectKey: 'private-fixture-key' }),
      (value) => Object.assign(value.questions[0], { noError: true }),
      (value) =>
        Object.assign(
          value.questions.find((question) => question.candidateDecisions.length > 0)!
            .candidateDecisions[0],
          { reason: 'arbitrary reason' },
        ),
      (value) => Object.assign(value.questionResults[0], { cause: 'arbitrary cause' }),
      (value) => Object.assign(value.confirmedPatternObservations[0], { outcome: 'correct' }),
      (value) =>
        Object.assign(value.confirmedPatternObservations[0].evidence[0], {
          explanation: 'arbitrary text',
        }),
    ];
    for (const mutate of mutations) {
      const corrupt = structuredClone(artifact);
      mutate(corrupt);
      rejectsCorrupt(rehash(corrupt));
    }
  });

  it('rejects rehashed mismatched counts, duplicate facts, and incomplete accepted partitions', () => {
    const { input } = inputFixture();
    const artifact = buildConfirmedExamErrorPatternReviewArtifact(input);
    const mutations: Array<(value: ConfirmedExamErrorPatternReviewArtifactV1) => void> = [
      (value) => {
        value.acceptedCandidateCount += 1;
      },
      (value) => {
        value.reviewedQuestionCount -= 1;
      },
      (value) => {
        value.rejectedCandidateCount = -1;
      },
      (value) => {
        value.confirmedObservationCount = Number.MAX_SAFE_INTEGER;
      },
      (value) => {
        value.questionResults[0].hasConfirmedPattern =
          !value.questionResults[0].hasConfirmedPattern;
      },
      (value) => {
        value.confirmedPatternObservations.pop();
      },
      (value) => {
        value.confirmedPatternObservations.push(value.confirmedPatternObservations[0]);
      },
      (value) => {
        value.questionResults.push(value.questionResults[0]);
      },
      (value) => {
        value.questions.reverse();
      },
      (value) => {
        value.confirmedPatternObservations.reverse();
      },
      (value) => {
        value.confirmedPatternObservations[0].observationId = `exam-error-pattern-observation:v1:${'f'.repeat(64)}`;
      },
      (value) => {
        value.sourceSuggestions.suggestionArtifactSha256 = 'f'.repeat(64);
      },
      (value) => {
        value.errorReviewArtifactRef = 'foreign-artifact';
      },
    ];
    for (const mutate of mutations) {
      const corrupt = structuredClone(artifact);
      mutate(corrupt);
      rejectsCorrupt(rehash(corrupt));
    }
  });

  it('rejects rehashed observation reassignment to a different reviewed question', () => {
    const { input, questionId } = inputFixture();
    const corrupt = buildConfirmedExamErrorPatternReviewArtifact(input);
    corrupt.confirmedPatternObservations[0].confirmedQuestionId = questionId('5');
    rejectsCorrupt(rehash(corrupt));
  });

  it('validates malformed source objects without throwing outside the closed private error', () => {
    const { input } = inputFixture();
    const artifact = buildConfirmedExamErrorPatternReviewArtifact(input);
    for (const sourceSuggestions of [
      null,
      {},
      { ...artifact.sourceSuggestions, generationVersion: 0 },
      { ...artifact.sourceSuggestions, suggestionArtifactSha256: null },
    ]) {
      rejectsCorrupt({ ...artifact, sourceSuggestions });
    }
  });
});
