import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { detectExamObservableErrorSuggestions } from '@/lib/server/zhongkao/exam-error-observable-detector';
import {
  EXAM_ANSWER_KEY_AUTHORITY_SOURCE,
  EXAM_ANSWER_KEY_SCHEMA_VERSION,
  EXAM_ANSWER_KEY_VERSION,
  EXAM_ASSESSMENT_SCHEMA_VERSION,
  EXAM_ASSESSMENT_VERSION,
  EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
  buildAuthoritativeExamAnswerKeyArtifact,
  buildExamQuestionAssessmentsArtifact,
  serializeAuthoritativeExamAnswerKeyArtifact,
  serializeExamQuestionAssessmentsArtifact,
  type AuthoritativeExamAnswerKeyArtifactV1,
  type ExamQuestionAssessmentsArtifactV1,
} from '@/lib/server/zhongkao/exam-grading-private';
import {
  buildExamErrorSuggestionsArtifact,
  createExamErrorSuggestionsSemanticFingerprint,
  parseExamErrorSuggestionsArtifact,
  serializeExamErrorSuggestionsArtifact,
  toPublicExamErrorSuggestionsBundle,
  validateExamErrorSuggestionsArtifact,
  type BuildExamErrorSuggestionsArtifactInput,
} from '@/lib/server/zhongkao/exam-error-suggestions-private';
import {
  EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION,
  EXAM_ERROR_MODEL_POLICY_VERSION,
  EXAM_ERROR_OBSERVABLE_RULES_VERSION,
  EXAM_ERROR_SUGGESTION_SCHEMA_VERSION,
  type ExamErrorSuggestionQuestionDraftV1,
} from '@/lib/zhongkao/exam-error-suggestions';
import {
  buildConfirmedExamReviewFacts,
  createExamHumanReviewDecisionSemanticFingerprint,
  deriveConfirmedExamQuestionId,
  deriveConfirmedQuestionResponseMatchId,
  deriveConfirmedStudentResponseId,
  parseExamHumanReviewRequest,
  serializeConfirmedExamReviewFacts,
  type ConfirmedExamReviewFactsV1,
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

const EXAM_SESSION_ID = 'exam-error-suggestions-fixture';
const PROFILE_ID = 'fictional-profile';
const SUBJECT_ID = 'math';
const QUESTION_ARTIFACT_REF = 'exam-question-candidates:v1:error-suggestions';
const RESPONSE_ARTIFACT_REF = 'exam-response-candidates:v1:error-suggestions';
const MATCHING_ARTIFACT_REF = 'exam-response-matches:v1:error-suggestions';
const ANSWER_KEY_ARTIFACT_REF = 'exam-answer-key-artifact:v1:error-suggestions';
const ASSESSMENT_ARTIFACT_REF = 'exam-assessment-artifact:v1:error-suggestions';
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function reviewFixture(): ConfirmedExamReviewFactsV1 {
  const questions = segmentExamQuestionCandidates({
    examSessionId: EXAM_SESSION_ID,
    examDocumentId: 'question-paper-error-suggestions',
    artifact: {
      schemaVersion: 1,
      artifactVersion: 1,
      examSessionId: EXAM_SESSION_ID,
      examDocumentId: 'question-paper-error-suggestions',
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
                '1. Fictional single-choice question.',
                '2. Fictional correct numeric question.',
                '3. Fictional unsupported open question.',
                '4. Give the final length in metres.',
                '5. Name the gas released by the fictional reaction.',
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
    captureRef: 'exam-response-capture:v1:error-suggestions',
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    questionCandidateArtifactRef: QUESTION_ARTIFACT_REF,
    questionCandidateArtifactSha256: questionArtifactSha256,
    questionSegmentationVersion: 1,
    request: {
      format: 'numbered_text_v1',
      text: ['1=C', '2=2', '3=essay', '4=5 cm', '5=O2'].join('\n'),
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
  const questionByNumber = new Map(
    questions.candidates.map((candidate) => [candidate.locator.printedNumber, candidate]),
  );
  const responseByNumber = new Map(
    responses.candidates.map((candidate) => [candidate.locator.printedNumber, candidate]),
  );
  const decisions: ExamHumanReviewDecision[] = [];
  for (const number of ['1', '2', '3', '4', '5']) {
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
  return buildConfirmedExamReviewFacts({
    examSessionId: EXAM_SESSION_ID,
    reviewRef: 'exam-human-review:v1:error-suggestions',
    reviewArtifactRef: 'exam-confirmed-review-facts:v1:error-suggestions',
    questionArtifactRef: QUESTION_ARTIFACT_REF,
    questionArtifactSha256,
    questionExtractionVersion: 1,
    questionSegmentationVersion: 1,
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    responseArtifactSha256,
    responseCaptureVersion: 1,
    matchingArtifactRef: MATCHING_ARTIFACT_REF,
    matchingArtifactSha256: digest(serializeExamQuestionResponseMatchesArtifact(matches)),
    matchingVersion: 1,
    questionCandidatesArtifact: questions,
    responseCandidatesArtifact: responses,
    questionResponseMatchesArtifact: matches,
    request: { schemaVersion: 1, decisions },
  });
}

function answerKeyFor(review: ConfirmedExamReviewFactsV1): AuthoritativeExamAnswerKeyArtifactV1 {
  const idFor = (number: string) =>
    review.confirmedQuestions.find((question) => question.locator.printedNumber === number)!
      .confirmedQuestionId;
  return buildAuthoritativeExamAnswerKeyArtifact({
    examSessionId: EXAM_SESSION_ID,
    subjectId: SUBJECT_ID,
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
        { confirmedQuestionId: idFor('4'), type: 'numeric', expectedValue: '5' },
        {
          confirmedQuestionId: idFor('5'),
          type: 'exact_short_answer',
          acceptedAnswers: ['oxygen'],
        },
      ],
    },
  });
}

function modelUnitSuggestion() {
  return {
    kind: 'unit_error_candidate' as const,
    generationSource: 'model_candidate' as const,
    candidateStatus: 'candidate' as const,
    confidenceBand: 'medium' as const,
    evidence: [
      { evidenceType: 'text_span' as const, source: 'question' as const, text: 'metres' },
      { evidenceType: 'text_span' as const, source: 'response' as const, text: 'cm' },
    ],
  };
}

function generatorDescriptor() {
  return {
    generatorVersion: EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION,
    detectorVersion: EXAM_ERROR_OBSERVABLE_RULES_VERSION,
    modelPolicyVersion: EXAM_ERROR_MODEL_POLICY_VERSION,
    candidateSchemaVersion: EXAM_ERROR_SUGGESTION_SCHEMA_VERSION,
  };
}

function inputForSources(
  confirmedReview: ConfirmedExamReviewFactsV1,
  answerKey: AuthoritativeExamAnswerKeyArtifactV1,
  assessments: ExamQuestionAssessmentsArtifactV1,
): BuildExamErrorSuggestionsArtifactInput {
  const drafts = detectExamObservableErrorSuggestions({
    confirmedReview,
    answerKey,
    assessments,
  }).map((draft) => {
    const question = confirmedReview.confirmedQuestions.find(
      (item) => item.confirmedQuestionId === draft.confirmedQuestionId,
    )!;
    if (question.locator.printedNumber !== '4') return draft;
    return {
      ...draft,
      generationStatus: 'generated' as const,
      suggestions: [...draft.suggestions, modelUnitSuggestion()],
    };
  });
  return {
    examSessionId: EXAM_SESSION_ID,
    profileId: PROFILE_ID,
    subjectId: SUBJECT_ID,
    confirmedReview,
    confirmedReviewArtifactSha256: digest(serializeConfirmedExamReviewFacts(confirmedReview)),
    answerKey,
    answerKeyArtifactRef: ANSWER_KEY_ARTIFACT_REF,
    answerKeyArtifactSha256: digest(serializeAuthoritativeExamAnswerKeyArtifact(answerKey)),
    assessments,
    assessmentArtifactRef: ASSESSMENT_ARTIFACT_REF,
    assessmentArtifactSha256: digest(serializeExamQuestionAssessmentsArtifact(assessments)),
    generator: generatorDescriptor(),
    modelExecution: {
      status: 'used',
      stage: 'exam-error-suggestions',
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
    },
    questionDrafts: drafts,
  };
}

function buildInput(): BuildExamErrorSuggestionsArtifactInput {
  const confirmedReview = reviewFixture();
  const answerKey = answerKeyFor(confirmedReview);
  const assessments = buildExamQuestionAssessmentsArtifact({ confirmedReview, answerKey });
  return inputForSources(confirmedReview, answerKey, assessments);
}

function boundaryReviewFixture(questionCount: number): ConfirmedExamReviewFactsV1 {
  const base = reviewFixture();
  const reviewRef = 'exam-human-review:v1:error-suggestions-boundary';
  const rawDecisions: ExamHumanReviewDecision[] = [];
  const confirmedQuestions: Array<ConfirmedExamReviewFactsV1['confirmedQuestions'][number]> = [];
  const confirmedResponses: Array<ConfirmedExamReviewFactsV1['confirmedResponses'][number]> = [];
  const confirmedMatches: Array<ConfirmedExamReviewFactsV1['confirmedMatches'][number]> = [];
  const questionText = 'Give the final length in metres.';

  for (let index = 0; index < questionCount; index += 1) {
    const printedNumber = String(index + 1);
    const sourceQuestionCandidateId = `boundary-question-${printedNumber.padStart(3, '0')}`;
    const sourceResponseCandidateId = `boundary-response-${printedNumber.padStart(3, '0')}`;
    const confirmedQuestionId = deriveConfirmedExamQuestionId(reviewRef, sourceQuestionCandidateId);
    const confirmedResponseId = deriveConfirmedStudentResponseId(
      reviewRef,
      confirmedQuestionId,
      sourceResponseCandidateId,
    );
    confirmedQuestions.push({
      confirmedQuestionId,
      sourceQuestionCandidateId,
      rawLabel: `${printedNumber}.`,
      locator: { sectionPath: [], printedNumber, subquestionPath: [] },
      questionText,
      textSource: 'extracted_confirmed',
      locatorSource: 'extracted_confirmed',
      sourceSpans: [
        {
          pageNumber: 1,
          startBlockIndex: index,
          endBlockIndex: index,
          startOffset: 0,
          endOffset: questionText.length,
        },
      ],
    });
    confirmedResponses.push({
      confirmedResponseId,
      confirmedQuestionId,
      sourceResponseCandidateId,
      answerStatus: 'text',
      rawAnswerText: '5 cm',
      answerSource: 'owner_corrected',
    });
    confirmedMatches.push({
      confirmedMatchId: deriveConfirmedQuestionResponseMatchId(
        reviewRef,
        confirmedQuestionId,
        confirmedResponseId,
      ),
      confirmedQuestionId,
      confirmedResponseId,
      relationSource: 'owner_manual_link',
    });
    rawDecisions.push(
      { decisionType: 'confirm_question', questionCandidateId: sourceQuestionCandidateId },
      {
        decisionType: 'correct_response',
        responseCandidateId: sourceResponseCandidateId,
        questionCandidateId: sourceQuestionCandidateId,
        responseOverride: { status: 'text', rawAnswerText: '5 cm' },
      },
    );
  }
  const request = parseExamHumanReviewRequest({ schemaVersion: 1, decisions: rawDecisions });
  const compare = (left: string, right: string) => left.localeCompare(right, 'en');
  return {
    ...base,
    reviewRef,
    reviewArtifactRef: 'exam-confirmed-review-facts:v1:error-suggestions-boundary',
    decisionSemanticFingerprint: createExamHumanReviewDecisionSemanticFingerprint(request),
    decisions: request.decisions,
    confirmedQuestionCount: confirmedQuestions.length,
    confirmedResponseCount: confirmedResponses.length,
    confirmedMatchCount: confirmedMatches.length,
    rejectedQuestionCount: 0,
    rejectedResponseCount: 0,
    confirmedQuestions: confirmedQuestions.sort((left, right) =>
      compare(left.confirmedQuestionId, right.confirmedQuestionId),
    ),
    confirmedResponses: confirmedResponses.sort((left, right) =>
      compare(left.confirmedResponseId, right.confirmedResponseId),
    ),
    confirmedMatches: confirmedMatches.sort((left, right) =>
      compare(left.confirmedMatchId, right.confirmedMatchId),
    ),
    rejectedQuestionCandidates: [],
    rejectedResponseCandidates: [],
  };
}

function boundaryInput(questionCount: number): BuildExamErrorSuggestionsArtifactInput {
  const confirmedReview = boundaryReviewFixture(questionCount);
  const answerKey = buildAuthoritativeExamAnswerKeyArtifact({
    examSessionId: EXAM_SESSION_ID,
    subjectId: SUBJECT_ID,
    confirmedReview,
    confirmedReviewArtifactSha256: digest(serializeConfirmedExamReviewFacts(confirmedReview)),
    request: {
      schemaVersion: 1,
      entries: confirmedReview.confirmedQuestions.map((question) => ({
        confirmedQuestionId: question.confirmedQuestionId,
        type: 'numeric' as const,
        expectedValue: '5',
      })),
    },
  });
  const assessments = buildExamQuestionAssessmentsArtifact({ confirmedReview, answerKey });
  const input = inputForSources(confirmedReview, answerKey, assessments);
  return {
    ...input,
    questionDrafts: input.questionDrafts.map((draft) => ({
      ...draft,
      generationStatus: 'generated',
      suggestions: [...draft.suggestions, modelUnitSuggestion()],
    })),
  };
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    key,
    ...objectKeys(child),
  ]);
}

function withFingerprint(
  artifact: ReturnType<typeof buildExamErrorSuggestionsArtifact>,
  mutation: Partial<ReturnType<typeof buildExamErrorSuggestionsArtifact>>,
) {
  const changed = { ...artifact, ...mutation };
  const { semanticFingerprint: _fingerprint, ...withoutFingerprint } = changed;
  return {
    ...changed,
    semanticFingerprint: createExamErrorSuggestionsSemanticFingerprint(withoutFingerprint),
  };
}

describe('private Exam error suggestion artifact', () => {
  it('builds a deterministic complete artifact bound to authoritative sources', () => {
    const input = buildInput();
    const first = buildExamErrorSuggestionsArtifact({
      ...input,
      questionDrafts: [...input.questionDrafts].reverse(),
    });
    const second = buildExamErrorSuggestionsArtifact(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      artifactVersion: 1,
      generationVersion: 1,
      examSessionId: EXAM_SESSION_ID,
      profileId: PROFILE_ID,
      subjectId: SUBJECT_ID,
      candidateStatus: 'candidate',
      eligibleQuestionCount: 3,
      candidateQuestionCount: 2,
      noSuggestionQuestionCount: 1,
      inputTooLargeQuestionCount: 0,
      suggestionCount: 3,
      deterministicSuggestionCount: 2,
      modelSuggestionCount: 1,
      modelExecution: {
        status: 'used',
        stage: 'exam-error-suggestions',
        providerId: 'fixture-provider',
        modelId: 'fixture-model',
      },
      sourceReview: {
        reviewArtifactSha256: input.confirmedReviewArtifactSha256,
        decisionSemanticFingerprint: input.confirmedReview.decisionSemanticFingerprint,
      },
      sourceAnswerKey: {
        answerKeyRef: input.answerKey.answerKeyRef,
        answerKeyArtifactRef: ANSWER_KEY_ARTIFACT_REF,
        answerKeyArtifactSha256: input.answerKeyArtifactSha256,
        semanticFingerprint: input.answerKey.semanticFingerprint,
      },
      sourceAssessment: {
        gradingRef: input.assessments.assessmentRef,
        assessmentArtifactRef: ASSESSMENT_ARTIFACT_REF,
        assessmentArtifactSha256: input.assessmentArtifactSha256,
        semanticFingerprint: input.assessments.semanticFingerprint,
      },
      generator: generatorDescriptor(),
    });
    expect(first.questions.map((question) => question.confirmedQuestionId)).toEqual(
      [...first.questions.map((question) => question.confirmedQuestionId)].sort(),
    );
    expect(first.questions.flatMap((question) => question.suggestions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: expect.stringMatching(/^exam-error-suggestion:v1:[a-f0-9]{64}$/u),
          candidateStatus: 'candidate',
        }),
      ]),
    );
    expect(validateExamErrorSuggestionsArtifact(first)).toEqual({ valid: true });
    expect(parseExamErrorSuggestionsArtifact(serializeExamErrorSuggestionsArtifact(first))).toEqual(
      first,
    );
  });

  it('merges model and deterministic candidates, exact-dedupes, and keeps ids stable', () => {
    const input = buildInput();
    const unitQuestion = input.questionDrafts.find((draft) =>
      draft.suggestions.some((suggestion) => suggestion.kind === 'unit_error_candidate'),
    )!;
    const unit = unitQuestion.suggestions.find(
      (suggestion) => suggestion.kind === 'unit_error_candidate',
    )!;
    const highDuplicate = {
      ...unit,
      confidenceBand: 'high' as const,
      evidence: [...unit.evidence].reverse(),
    };
    const replace = (duplicates: typeof unitQuestion.suggestions) =>
      input.questionDrafts.map((draft) =>
        draft.confirmedQuestionId === unitQuestion.confirmedQuestionId
          ? { ...draft, suggestions: duplicates }
          : draft,
      );
    const first = buildExamErrorSuggestionsArtifact({
      ...input,
      questionDrafts: replace([...unitQuestion.suggestions, highDuplicate]),
    });
    const second = buildExamErrorSuggestionsArtifact({
      ...input,
      questionDrafts: replace([highDuplicate, ...unitQuestion.suggestions]),
    });

    expect(first).toEqual(second);
    const persisted = first.questions.find(
      (question) => question.confirmedQuestionId === unitQuestion.confirmedQuestionId,
    )!;
    expect(persisted.suggestions).toHaveLength(2);
    expect(
      persisted.suggestions.find((suggestion) => suggestion.kind === 'unit_error_candidate'),
    ).toMatchObject({ confidenceBand: 'high', generationSource: 'model_candidate' });
    expect(new Set(persisted.suggestions.map((suggestion) => suggestion.candidateId)).size).toBe(2);
  });

  it('persists only eligible evaluated incorrect questions', () => {
    const input = buildInput();
    const artifact = buildExamErrorSuggestionsArtifact(input);
    const assessmentByQuestion = new Map(
      input.assessments.assessments.map((assessment) => [
        assessment.confirmedQuestionId,
        assessment,
      ]),
    );

    expect(artifact.questions).toHaveLength(3);
    for (const question of artifact.questions) {
      expect(assessmentByQuestion.get(question.confirmedQuestionId)).toMatchObject({
        status: 'evaluated',
        outcome: 'incorrect',
      });
    }
    const excluded = input.assessments.assessments.filter(
      (assessment) => assessment.status !== 'evaluated' || assessment.outcome !== 'incorrect',
    );
    expect(excluded).toHaveLength(2);
    expect(
      excluded.every(
        (assessment) =>
          !artifact.questions.some(
            (question) => question.confirmedQuestionId === assessment.confirmedQuestionId,
          ),
      ),
    ).toBe(true);
  });

  it('rejects incomplete, duplicate, unauthorized, and source-inconsistent drafts', () => {
    const input = buildInput();
    const first = input.questionDrafts[0]!;
    const exactNoSuggestion = input.questionDrafts.find(
      (draft) => draft.generationStatus === 'no_suggestion',
    )!;
    const formatQuestion = input.questionDrafts.find((draft) =>
      draft.suggestions.some(
        (suggestion) => suggestion.kind === 'response_format_mismatch_candidate',
      ),
    )!;
    const deterministic = formatQuestion.suggestions.find(
      (suggestion) => suggestion.generationSource === 'deterministic_candidate',
    )!;
    const invalidDraftSets: ExamErrorSuggestionQuestionDraftV1[][] = [
      input.questionDrafts.slice(1),
      [first, first, ...input.questionDrafts.slice(2)],
      [
        ...input.questionDrafts,
        {
          ...exactNoSuggestion,
          confirmedQuestionId: input.assessments.assessments.find(
            (assessment) => assessment.status === 'evaluated' && assessment.outcome === 'correct',
          )!.confirmedQuestionId,
        },
      ],
      input.questionDrafts.map((draft) =>
        draft.confirmedQuestionId === formatQuestion.confirmedQuestionId
          ? {
              ...draft,
              suggestions: [
                {
                  ...deterministic,
                  evidence: [
                    {
                      evidenceType: 'format_observation' as const,
                      gradingType: 'exact_short_answer' as const,
                      parseStatus: 'invalid' as const,
                    },
                  ],
                },
              ],
            }
          : draft,
      ),
      input.questionDrafts.map((draft) =>
        draft.confirmedQuestionId === exactNoSuggestion.confirmedQuestionId
          ? {
              ...draft,
              generationStatus: 'generated' as const,
              suggestions: [modelUnitSuggestion()],
            }
          : draft,
      ),
      input.questionDrafts.map((draft, index) =>
        index === 0 ? { ...draft, generationStatus: 'no_suggestion' as const } : draft,
      ),
    ];

    for (const questionDrafts of invalidDraftSets) {
      expect(() => buildExamErrorSuggestionsArtifact({ ...input, questionDrafts })).toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(
            /^EXAM_ERROR_SUGGESTION_(?:INCOMPLETE|INPUT_INVALID|SOURCE_INVALID)$/u,
          ),
        }),
      );
    }
  });

  it('rejects source digest drift and caller-controlled operation identities', () => {
    const input = buildInput();
    for (const mutation of [
      { confirmedReviewArtifactSha256: '0'.repeat(64) },
      { answerKeyArtifactSha256: '0'.repeat(64) },
      { assessmentArtifactSha256: '0'.repeat(64) },
      { subjectId: 'physics' },
      { generationRef: 'caller-controlled-generation' },
      { suggestionArtifactRef: 'caller-controlled-artifact' },
      {
        generator: { ...input.generator, modelPolicyVersion: 'changed-model-policy' },
      },
    ]) {
      expect(() =>
        buildExamErrorSuggestionsArtifact({
          ...input,
          ...mutation,
        } as BuildExamErrorSuggestionsArtifactInput),
      ).toThrowError(expect.objectContaining({ code: 'EXAM_ERROR_SUGGESTION_SOURCE_INVALID' }));
    }
  });

  it('keeps source content and model connection secrets out while retaining bounded execution identity', () => {
    const artifact = buildExamErrorSuggestionsArtifact(buildInput());
    expect(artifact.modelExecution).toEqual({
      status: 'used',
      stage: 'exam-error-suggestions',
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
    });
    const keys = new Set(objectKeys(artifact));
    for (const forbiddenKey of [
      'questionText',
      'parentContext',
      'confirmedResponse',
      'rawAnswerText',
      'expectedOptionId',
      'correctOptionId',
      'correctOptionIds',
      'expectedValue',
      'expectedNumericValue',
      'acceptedAnswers',
      'gradingSpec',
      'prompt',
      'rawProviderResponse',
      'reasoning',
      'apiKey',
      'credential',
      'baseUrl',
      'modelString',
    ]) {
      expect(keys.has(forbiddenKey), forbiddenKey).toBe(false);
    }
    const bytes = serializeExamErrorSuggestionsArtifact(artifact);
    expect(bytes.includes(Buffer.from('Fictional single-choice question'))).toBe(false);
    expect(bytes.includes(Buffer.from('5 cm'))).toBe(false);
    expect(bytes.includes(Buffer.from('oxygen'))).toBe(false);
  });

  it('uses a closed bounded model-execution union and binds it into the semantic fingerprint', () => {
    const input = buildInput();
    const used = buildExamErrorSuggestionsArtifact(input);
    const differentModel = buildExamErrorSuggestionsArtifact({
      ...input,
      modelExecution: {
        status: 'used',
        stage: 'exam-error-suggestions',
        providerId: 'fixture-provider',
        modelId: 'fixture-model-v2',
      },
    });
    expect(differentModel.semanticFingerprint).not.toBe(used.semanticFingerprint);

    const withoutModelCandidates = input.questionDrafts.map((draft) => ({
      ...draft,
      suggestions: draft.suggestions.filter(
        (suggestion) => suggestion.generationSource !== 'model_candidate',
      ),
    }));
    expect(
      buildExamErrorSuggestionsArtifact({
        ...input,
        modelExecution: { status: 'not_used', stage: 'exam-error-suggestions' },
        questionDrafts: withoutModelCandidates,
      }).modelExecution,
    ).toEqual({ status: 'not_used', stage: 'exam-error-suggestions' });

    expect(() =>
      buildExamErrorSuggestionsArtifact({
        ...input,
        modelExecution: { status: 'not_used', stage: 'exam-error-suggestions' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT' }));

    for (const modelExecution of [
      { status: 'used', stage: 'other-stage', providerId: 'provider', modelId: 'model' },
      {
        status: 'used',
        stage: 'exam-error-suggestions',
        providerId: 'p'.repeat(129),
        modelId: 'model',
      },
      {
        status: 'used',
        stage: 'exam-error-suggestions',
        providerId: 'provider',
        modelId: 'model',
        apiKey: 'must-not-be-persisted',
      },
      { status: 'not_used', stage: 'exam-error-suggestions', modelId: 'unexpected' },
    ]) {
      expect(() =>
        buildExamErrorSuggestionsArtifact({
          ...input,
          modelExecution:
            modelExecution as BuildExamErrorSuggestionsArtifactInput['modelExecution'],
        }),
      ).toThrowError(expect.objectContaining({ code: 'EXAM_ERROR_SUGGESTION_SOURCE_INVALID' }));
    }

    expect(
      validateExamErrorSuggestionsArtifact({
        ...used,
        modelExecution: { ...used.modelExecution, modelId: 'tampered-model' },
      }),
    ).toMatchObject({ valid: false });
  });

  it('joins confirmed display facts only in the dedicated public review bundle', () => {
    const input = buildInput();
    const artifact = buildExamErrorSuggestionsArtifact(input);
    const bundle = toPublicExamErrorSuggestionsBundle(artifact, input.confirmedReview);

    expect(Object.keys(bundle)).toEqual([
      'schemaVersion',
      'examSessionId',
      'subjectId',
      'candidateStatus',
      'questions',
    ]);
    expect(bundle.questions).toHaveLength(3);
    expect(bundle.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionText: expect.stringContaining('metres'),
          confirmedResponse: { answerStatus: 'text', rawAnswerText: '5 cm' },
          assessmentOutcome: 'incorrect',
          suggestions: expect.arrayContaining([
            expect.objectContaining({ kind: 'unit_error_candidate', candidateStatus: 'candidate' }),
          ]),
        }),
      ]),
    );
    const keys = new Set(objectKeys(bundle));
    for (const privateKey of [
      'profileId',
      'assessmentId',
      'ordinal',
      'sourceReview',
      'sourceAnswerKey',
      'sourceAssessment',
      'generator',
      'modelExecution',
      'providerId',
      'modelId',
      'generationRef',
      'suggestionArtifactRef',
      'semanticFingerprint',
      'expectedValue',
      'expectedOptionId',
      'acceptedAnswers',
      'gradingSpec',
      'provider',
      'rawProviderResponse',
    ]) {
      expect(keys.has(privateKey), privateKey).toBe(false);
    }

    const differentReview = { ...input.confirmedReview, reviewRef: 'different-review-ref' };
    expect(() => toPublicExamErrorSuggestionsBundle(artifact, differentReview)).toThrowError(
      expect.objectContaining({ code: 'EXAM_ERROR_SUGGESTION_SOURCE_INVALID' }),
    );

    const artifactVersionDrift = withFingerprint(artifact, {
      sourceReview: {
        ...artifact.sourceReview,
        reviewArtifactVersion: artifact.sourceReview.reviewArtifactVersion + 1,
      },
    });
    expect(validateExamErrorSuggestionsArtifact(artifactVersionDrift)).toEqual({ valid: true });
    expect(() =>
      toPublicExamErrorSuggestionsBundle(artifactVersionDrift, input.confirmedReview),
    ).toThrowError(expect.objectContaining({ code: 'EXAM_ERROR_SUGGESTION_SOURCE_INVALID' }));
  });

  it('rejects a non-current assessment grading algorithm at its exact source field', () => {
    const artifact = buildExamErrorSuggestionsArtifact(buildInput());
    const mutation = {
      ...artifact,
      sourceAssessment: {
        ...artifact.sourceAssessment,
        gradingAlgorithmVersion: 'exam-objective-grading:v999',
      },
    };

    expect(validateExamErrorSuggestionsArtifact(mutation)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        {
          path: '/sourceAssessment/gradingAlgorithmVersion',
          message: `expected ${EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION}`,
        },
      ]),
    });
    expect(() => parseExamErrorSuggestionsArtifact(mutation)).toThrowError(
      expect.objectContaining({ code: 'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT' }),
    );
  });

  it('detects candidate, question, count, status, ref, and fingerprint tampering', () => {
    const artifact = buildExamErrorSuggestionsArtifact(buildInput());
    const firstQuestion = artifact.questions[0]!;
    const firstCandidate = firstQuestion.suggestions[0]!;
    const mutations = [
      { ...artifact, suggestionCount: artifact.suggestionCount + 1 },
      { ...artifact, candidateStatus: 'confirmed' },
      { ...artifact, generationRef: `${artifact.generationRef}-changed` },
      { ...artifact, suggestionArtifactRef: `${artifact.suggestionArtifactRef}-changed` },
      { ...artifact, semanticFingerprint: '0'.repeat(64) },
      {
        ...artifact,
        sourceAssessment: {
          ...artifact.sourceAssessment,
          assessmentArtifactSha256: '0'.repeat(64),
        },
      },
      {
        ...artifact,
        questions: [
          { ...firstQuestion, assessmentOutcome: 'correct' },
          ...artifact.questions.slice(1),
        ],
      },
      {
        ...artifact,
        questions: [
          {
            ...firstQuestion,
            suggestions: [
              { ...firstCandidate, candidateId: `${firstCandidate.candidateId}-changed` },
              ...firstQuestion.suggestions.slice(1),
            ],
          },
          ...artifact.questions.slice(1),
        ],
      },
      { ...artifact, questions: [firstQuestion, firstQuestion, ...artifact.questions.slice(2)] },
      {
        ...artifact,
        questions: [
          { ...firstQuestion, questionText: 'private leak' },
          ...artifact.questions.slice(1),
        ],
      },
    ];
    for (const mutation of mutations) {
      expect(validateExamErrorSuggestionsArtifact(mutation).valid).toBe(false);
      expect(() => parseExamErrorSuggestionsArtifact(mutation)).toThrowError(
        expect.objectContaining({ code: 'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT' }),
      );
    }

    const internallyConsistentWrongCount = withFingerprint(artifact, {
      suggestionCount: artifact.suggestionCount + 1,
    });
    expect(validateExamErrorSuggestionsArtifact(internallyConsistentWrongCount).valid).toBe(false);
  });

  it('fails closed for malformed UTF-8, invalid JSON, and oversized artifacts', () => {
    for (const bytes of [
      Buffer.from('{not-json'),
      Buffer.from([0xc3, 0x28]),
      Buffer.alloc(MAX_ARTIFACT_BYTES + 1),
    ]) {
      expect(() => parseExamErrorSuggestionsArtifact(bytes)).toThrowError(
        expect.objectContaining({ code: 'EXAM_ERROR_SUGGESTION_ARTIFACT_CORRUPT' }),
      );
    }
  });

  it('serializes the 500-question and 1000-candidate boundary below four MiB', () => {
    const input = boundaryInput(500);
    const artifact = buildExamErrorSuggestionsArtifact(input);
    const bytes = serializeExamErrorSuggestionsArtifact(artifact);

    expect(artifact).toMatchObject({
      eligibleQuestionCount: 500,
      candidateQuestionCount: 500,
      suggestionCount: 1000,
      deterministicSuggestionCount: 500,
      modelSuggestionCount: 500,
    });
    expect(bytes.byteLength).toBeLessThan(MAX_ARTIFACT_BYTES);
    expect(bytes.includes(Buffer.from('questionText'))).toBe(false);
    expect(bytes.includes(Buffer.from('rawAnswerText'))).toBe(false);
    expect(bytes.includes(Buffer.from('expectedValue'))).toBe(false);
  });

  it('uses the established grading versions without granting error authority', () => {
    const input = buildInput();
    const artifact = buildExamErrorSuggestionsArtifact(input);

    expect(input.answerKey).toMatchObject({
      schemaVersion: EXAM_ANSWER_KEY_SCHEMA_VERSION,
      answerKeyVersion: EXAM_ANSWER_KEY_VERSION,
      authoritySource: EXAM_ANSWER_KEY_AUTHORITY_SOURCE,
    });
    expect(input.assessments).toMatchObject({
      schemaVersion: EXAM_ASSESSMENT_SCHEMA_VERSION,
      assessmentVersion: EXAM_ASSESSMENT_VERSION,
      gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
    });
    expect(JSON.stringify(artifact)).not.toMatch(
      /ConfirmedErrorDiagnosis|TrustedErrorType|authoritativeErrorType/u,
    );
    expect(artifact.questions.every((question) => question.assessmentOutcome === 'incorrect')).toBe(
      true,
    );
    expect(
      artifact.questions
        .flatMap((question) => question.suggestions)
        .every((suggestion) => suggestion.candidateStatus === 'candidate'),
    ).toBe(true);
  });
});
