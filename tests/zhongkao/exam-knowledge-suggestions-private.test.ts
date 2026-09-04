import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildExamKnowledgeCandidatePool } from '@/lib/server/zhongkao/exam-knowledge-candidate-pool';
import {
  EXAM_KNOWLEDGE_SUGGESTION_LIMITS,
  buildExamKnowledgeSuggestionsArtifact,
  isSafeExamKnowledgeSuggestionEvidencePhrase,
  isSafeExamKnowledgeSuggestionProposedLabel,
  parseExamKnowledgeSuggestionsArtifact,
  serializeExamKnowledgeSuggestionsArtifact,
  toPublicExamKnowledgeSuggestionsBundle,
  validateExamKnowledgeSuggestionsArtifact,
  type BuildExamKnowledgeSuggestionsArtifactInput,
  type ExamKnowledgeSuggestionDraftV1,
  type ExamKnowledgeSuggestionQuestionDraftV1,
} from '@/lib/server/zhongkao/exam-knowledge-suggestions-private';
import {
  buildConfirmedExamReviewFacts,
  createExamHumanReviewDecisionSemanticFingerprint,
  deriveConfirmedExamQuestionId,
  deriveConfirmedQuestionResponseMatchId,
  deriveConfirmedStudentResponseId,
  parseExamHumanReviewRequest,
  serializeConfirmedExamReviewFacts,
  type ConfirmedExamQuestionV1,
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

const EXAM_SESSION_ID = 'exam-knowledge-suggestions-fixture';
const PROFILE_ID = 'fictional-profile';
const SUBJECT_ID = 'math';
const QUESTION_ARTIFACT_REF = 'exam-question-candidates:v1:suggestions-fixture';
const RESPONSE_ARTIFACT_REF = 'exam-student-response-candidates:v1:suggestions-fixture';
const MATCHING_ARTIFACT_REF = 'exam-question-response-matches:v1:suggestions-fixture';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function reviewFixture(): ConfirmedExamReviewFactsV1 {
  const questions = segmentExamQuestionCandidates({
    examSessionId: EXAM_SESSION_ID,
    examDocumentId: 'question-paper-suggestions-fixture',
    artifact: {
      schemaVersion: 1,
      artifactVersion: 1,
      examSessionId: EXAM_SESSION_ID,
      examDocumentId: 'question-paper-suggestions-fixture',
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
                '一、选择题',
                '1. 虚构原题一：求 x+2=5 的解。',
                '2. 虚构原题二',
                '三、解答题',
                '17. 虚构共同题干',
                '(1) 虚构子题：计算三角形面积。',
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
    captureRef: 'exam-response-capture:v1:suggestions-fixture',
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    questionCandidateArtifactRef: QUESTION_ARTIFACT_REF,
    questionCandidateArtifactSha256: questionArtifactSha256,
    questionSegmentationVersion: 1,
    request: { format: 'numbered_text_v1', text: '1=A\n17(1)=6' },
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
  const byQuestion = new Map(
    questions.candidates.map((candidate) => [
      `${candidate.candidateKind}:${candidate.locator.printedNumber}:${candidate.locator.subquestionPath.join('.')}`,
      candidate,
    ]),
  );
  const byResponse = new Map(
    responses.candidates.map((candidate) => [
      `${candidate.locator.printedNumber}:${candidate.locator.subquestionPath.join('.')}`,
      candidate,
    ]),
  );
  const q1 = byQuestion.get('leaf:1:')!;
  const q2 = byQuestion.get('leaf:2:')!;
  const group17 = byQuestion.get('group:17:')!;
  const q17 = byQuestion.get('leaf:17:1')!;
  const r1 = byResponse.get('1:')!;
  const r17 = byResponse.get('17:1')!;
  const decisions: ExamHumanReviewDecision[] = [
    { decisionType: 'confirm_question', questionCandidateId: q1.candidateId },
    {
      decisionType: 'correct_question',
      questionCandidateId: q2.candidateId,
      correctedQuestionText: '3. 用户确认后的虚构题面',
      correctedRawLabel: '3.',
      correctedSectionHeading: '二、填空题',
    },
    {
      decisionType: 'reject_question',
      questionCandidateId: group17.candidateId,
      reason: 'segmentation_error',
    },
    { decisionType: 'confirm_question', questionCandidateId: q17.candidateId },
    {
      decisionType: 'confirm_response',
      responseCandidateId: r1.candidateId,
      questionCandidateId: q1.candidateId,
    },
    {
      decisionType: 'confirm_response',
      responseCandidateId: r17.candidateId,
      questionCandidateId: q17.candidateId,
    },
    { decisionType: 'confirm_no_response', questionCandidateId: q2.candidateId },
  ];
  return buildConfirmedExamReviewFacts({
    examSessionId: EXAM_SESSION_ID,
    reviewRef: 'exam-human-review:v1:suggestions-fixture',
    reviewArtifactRef: 'exam-confirmed-review-facts:v1:suggestions-fixture',
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

function suggestionFor(question: ConfirmedExamQuestionV1): ExamKnowledgeSuggestionDraftV1 {
  if (question.locator.printedNumber === '1') {
    return {
      kind: 'existing_knowledge_point',
      knowledgePointId: 'linear-equations',
      confidenceBand: 'high',
      evidencePhrases: ['x+2=5'],
    };
  }
  if (question.parentContext) {
    return {
      kind: 'proposed_label',
      proposedLabel: '三角形面积',
      confidenceBand: 'medium',
      evidencePhrases: ['虚构共同题干', '三角形面积'],
    };
  }
  return {
    kind: 'proposed_label',
    proposedLabel: '代数表达式',
    confidenceBand: 'low',
    evidencePhrases: ['用户确认后的虚构题面'],
  };
}

function draftFor(
  question: ConfirmedExamQuestionV1,
  generationStatus: ExamKnowledgeSuggestionQuestionDraftV1['generationStatus'] = 'generated',
): ExamKnowledgeSuggestionQuestionDraftV1 {
  return {
    confirmedQuestionId: question.confirmedQuestionId,
    questionText: question.questionText,
    ...(question.parentContext
      ? { parentContext: { questionText: question.parentContext.questionText } }
      : {}),
    generationStatus,
    suggestions: generationStatus === 'generated' ? [suggestionFor(question)] : [],
  };
}

function buildInput(): BuildExamKnowledgeSuggestionsArtifactInput {
  const confirmedReview = reviewFixture();
  return {
    examSessionId: EXAM_SESSION_ID,
    profileId: PROFILE_ID,
    subjectId: SUBJECT_ID,
    confirmedReview,
    confirmedReviewArtifactSha256: digest(serializeConfirmedExamReviewFacts(confirmedReview)),
    pool: buildExamKnowledgeCandidatePool({
      subjectId: SUBJECT_ID,
      knowledgePointIds: ['linear-equations', 'fractions'],
    }),
    generator: { generatorVersion: 'knowledge-suggestions-v1', candidateSchemaVersion: 1 },
    questionDrafts: confirmedReview.confirmedQuestions.map((question) => draftFor(question)),
  };
}

function boundaryReviewFixture(
  questionCount: number,
  questionText: string,
): ConfirmedExamReviewFactsV1 {
  const base = reviewFixture();
  const reviewRef = 'exam-human-review:v1:suggestions-boundary';
  const rawDecisions: ExamHumanReviewDecision[] = [];
  const confirmedQuestions: ConfirmedExamReviewFactsV1['confirmedQuestions'][number][] = [];
  const confirmedResponses: ConfirmedExamReviewFactsV1['confirmedResponses'][number][] = [];
  const confirmedMatches: ConfirmedExamReviewFactsV1['confirmedMatches'][number][] = [];

  for (let index = 0; index < questionCount; index += 1) {
    const printedNumber = String(index + 1);
    const sourceQuestionCandidateId = `boundary-question-${printedNumber.padStart(3, '0')}`;
    const confirmedQuestionId = deriveConfirmedExamQuestionId(reviewRef, sourceQuestionCandidateId);
    const confirmedResponseId = deriveConfirmedStudentResponseId(reviewRef, confirmedQuestionId);
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
      answerStatus: 'no_response',
      answerSource: 'owner_no_response',
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
      { decisionType: 'confirm_no_response', questionCandidateId: sourceQuestionCandidateId },
    );
  }

  const request = parseExamHumanReviewRequest({ schemaVersion: 1, decisions: rawDecisions });
  const byId =
    <T>(id: (value: T) => string) =>
    (left: T, right: T) =>
      id(left) < id(right) ? -1 : id(left) > id(right) ? 1 : 0;
  return {
    ...base,
    reviewRef,
    reviewArtifactRef: 'exam-confirmed-review-facts:v1:suggestions-boundary',
    decisionSemanticFingerprint: createExamHumanReviewDecisionSemanticFingerprint(request),
    decisions: request.decisions,
    confirmedQuestionCount: confirmedQuestions.length,
    confirmedResponseCount: confirmedResponses.length,
    confirmedMatchCount: confirmedMatches.length,
    rejectedQuestionCount: 0,
    rejectedResponseCount: 0,
    confirmedQuestions: confirmedQuestions.sort(byId((question) => question.confirmedQuestionId)),
    confirmedResponses: confirmedResponses.sort(byId((response) => response.confirmedResponseId)),
    confirmedMatches: confirmedMatches.sort(byId((match) => match.confirmedMatchId)),
    rejectedQuestionCandidates: [],
    rejectedResponseCandidates: [],
  };
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    key,
    ...objectKeys(child),
  ]);
}

describe('private Exam knowledge suggestion artifact', () => {
  it('builds a deterministic, complete, source-bound candidate artifact', () => {
    const input = buildInput();
    const first = buildExamKnowledgeSuggestionsArtifact({
      ...input,
      questionDrafts: [...input.questionDrafts].reverse(),
    });
    const second = buildExamKnowledgeSuggestionsArtifact(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      artifactVersion: 1,
      generationVersion: 1,
      examSessionId: EXAM_SESSION_ID,
      profileId: PROFILE_ID,
      subjectId: SUBJECT_ID,
      generationSource: 'model_candidate',
      candidateStatus: 'candidate',
      generator: { generatorVersion: 'knowledge-suggestions-v1', candidateSchemaVersion: 1 },
      questionCount: input.confirmedReview.confirmedQuestions.length,
      generatedQuestionCount: input.confirmedReview.confirmedQuestions.length,
      noSuggestionQuestionCount: 0,
      inputTooLargeQuestionCount: 0,
      suggestionCount: input.confirmedReview.confirmedQuestions.length,
    });
    expect(first.questions.map((question) => question.confirmedQuestionId)).toEqual(
      [...first.questions.map((question) => question.confirmedQuestionId)].sort(),
    );
    expect(first.questions.flatMap((question) => question.suggestions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: expect.stringMatching(/^exam-knowledge-suggestion:v1:[a-f0-9]{64}$/u),
          ordinal: 0,
        }),
      ]),
    );
    expect(first.questions.every((question) => !Object.hasOwn(question, 'questionText'))).toBe(
      true,
    );
    expect(first.questions.every((question) => !Object.hasOwn(question, 'parentContext'))).toBe(
      true,
    );
    expect(validateExamKnowledgeSuggestionsArtifact(first)).toEqual({ valid: true });
    expect(
      parseExamKnowledgeSuggestionsArtifact(serializeExamKnowledgeSuggestionsArtifact(first)),
    ).toEqual(first);
  });

  it('supports generated, no-suggestion, and input-too-large status counts', () => {
    const input = buildInput();
    const [first, second, third] = input.confirmedReview.confirmedQuestions;
    const artifact = buildExamKnowledgeSuggestionsArtifact({
      ...input,
      questionDrafts: [
        draftFor(first!, 'generated'),
        draftFor(second!, 'no_suggestion'),
        draftFor(third!, 'input_too_large'),
      ],
    });

    expect(artifact).toMatchObject({
      generatedQuestionCount: 1,
      noSuggestionQuestionCount: 1,
      inputTooLargeQuestionCount: 1,
      suggestionCount: 1,
    });
    expect(
      artifact.questions.find((question) => question.generationStatus !== 'generated')?.suggestions,
    ).toEqual([]);
  });

  it('accepts zero evidence phrases without manufacturing evidence', () => {
    const input = buildInput();
    const questionDrafts = input.questionDrafts.map((question) => ({
      ...question,
      suggestions: question.suggestions.map((suggestion) => ({
        ...suggestion,
        evidencePhrases: [],
      })),
    }));

    expect(
      buildExamKnowledgeSuggestionsArtifact({ ...input, questionDrafts }).questions.flatMap(
        (question) => question.suggestions,
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ evidencePhrases: [] })]));
  });

  it('exposes only reviewable candidate display fields publicly', () => {
    const input = buildInput();
    const artifact = buildExamKnowledgeSuggestionsArtifact(input);
    const publicBundle = toPublicExamKnowledgeSuggestionsBundle(artifact, input.confirmedReview);

    expect(Object.keys(publicBundle)).toEqual([
      'schemaVersion',
      'examSessionId',
      'subjectId',
      'candidateStatus',
      'questions',
    ]);
    expect(publicBundle.questions[0]).toMatchObject({
      confirmedQuestionId: expect.any(String),
      questionText: expect.any(String),
      generationStatus: 'generated',
      suggestions: [expect.objectContaining({ candidateId: expect.any(String) })],
    });
    expect(
      publicBundle.questions.find((question) => question.parentContext)?.parentContext,
    ).toEqual({ questionText: '17. 虚构共同题干' });
    const keys = new Set(objectKeys(publicBundle));
    for (const privateKey of [
      'profileId',
      'sourceReview',
      'pool',
      'generator',
      'generationRef',
      'suggestionArtifactRef',
      'semanticFingerprint',
      'fingerprint',
      'reviewArtifactSha256',
      'generationSource',
      'ordinal',
      'provider',
    ]) {
      expect(keys.has(privateKey), privateKey).toBe(false);
    }
  });

  it('rejects persisted question text or parent context fields in artifact v1', () => {
    const artifact = buildExamKnowledgeSuggestionsArtifact(buildInput());
    for (const extra of [
      { questionText: 'duplicated private question text' },
      { parentContext: { questionText: 'duplicated private parent context' } },
    ]) {
      const mutation = {
        ...artifact,
        questions: artifact.questions.map((question, index) =>
          index === 0 ? { ...question, ...extra } : question,
        ),
      };
      expect(validateExamKnowledgeSuggestionsArtifact(mutation)).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: expect.stringMatching(/questionText|parentContext/u) }),
        ]),
      });
      expect(() => parseExamKnowledgeSuggestionsArtifact(mutation)).toThrowError(
        expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT' }),
      );
    }
  });

  it('rejects incomplete coverage, duplicate questions, and source display changes', () => {
    const input = buildInput();
    const first = input.questionDrafts[0]!;
    for (const questionDrafts of [
      input.questionDrafts.slice(1),
      [first, first, ...input.questionDrafts.slice(2)],
      [
        { ...first, questionText: `${first.questionText} changed` },
        ...input.questionDrafts.slice(1),
      ],
    ]) {
      expect(() =>
        buildExamKnowledgeSuggestionsArtifact({
          ...input,
          questionDrafts: questionDrafts as ExamKnowledgeSuggestionQuestionDraftV1[],
        }),
      ).toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(/^EXAM_KNOWLEDGE_SUGGESTION_(?:INCOMPLETE|INPUT_INVALID)$/u),
        }),
      );
    }
  });

  it('rejects unauthorized ids, duplicate targets, excessive candidates, and status drift', () => {
    const input = buildInput();
    const first = input.questionDrafts.find(
      (question) => question.suggestions[0]?.kind === 'existing_knowledge_point',
    )!;
    const base = first.suggestions[0]!;
    for (const suggestions of [
      [{ ...base, knowledgePointId: 'not-in-pool' }],
      [base, base],
      Array.from(
        { length: EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxSuggestionsPerQuestion + 1 },
        (_, index) => ({
          kind: 'proposed_label' as const,
          proposedLabel: `候选知识点 ${index}`,
          confidenceBand: 'low' as const,
          evidencePhrases: [] as string[],
        }),
      ),
    ]) {
      const questionDrafts = input.questionDrafts.map((question) =>
        question.confirmedQuestionId === first.confirmedQuestionId
          ? ({ ...question, suggestions } as ExamKnowledgeSuggestionQuestionDraftV1)
          : question,
      );
      expect(() =>
        buildExamKnowledgeSuggestionsArtifact({ ...input, questionDrafts }),
      ).toThrowError(expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID' }));
    }
    expect(() =>
      buildExamKnowledgeSuggestionsArtifact({
        ...input,
        questionDrafts: input.questionDrafts.map((question, index) =>
          index === 0 ? { ...question, generationStatus: 'no_suggestion' } : question,
        ),
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID' }));
  });

  it('rejects non-source evidence and markup or provenance-bearing proposed labels', () => {
    const input = buildInput();
    const proposedQuestion = input.questionDrafts.find(
      (question) => question.suggestions[0]?.kind === 'proposed_label',
    )!;
    const proposed = proposedQuestion.suggestions[0] as Extract<
      ExamKnowledgeSuggestionDraftV1,
      { kind: 'proposed_label' }
    >;
    const rejected = [
      { ...proposed, evidencePhrases: ['题面中不存在的短语'] },
      { ...proposed, proposedLabel: '<b>方程</b>' },
      { ...proposed, proposedLabel: '[方程](https://example.invalid)' },
      { ...proposed, proposedLabel: '人教版第三章方程' },
    ];
    for (const suggestion of rejected) {
      const questionDrafts = input.questionDrafts.map((question) =>
        question.confirmedQuestionId === proposedQuestion.confirmedQuestionId
          ? { ...question, suggestions: [suggestion] }
          : question,
      );
      expect(() =>
        buildExamKnowledgeSuggestionsArtifact({ ...input, questionDrafts }),
      ).toThrowError(expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID' }));
    }
  });

  it('rejects an empty proposed label at the private artifact boundary', () => {
    const input = buildInput();
    const proposedQuestion = input.questionDrafts.find(
      (question) => question.suggestions[0]?.kind === 'proposed_label',
    )!;
    const proposed = proposedQuestion.suggestions[0] as Extract<
      ExamKnowledgeSuggestionDraftV1,
      { kind: 'proposed_label' }
    >;
    const questionDrafts = input.questionDrafts.map((question) =>
      question.confirmedQuestionId === proposedQuestion.confirmedQuestionId
        ? { ...question, suggestions: [{ ...proposed, proposedLabel: '' }] }
        : question,
    );

    expect(() =>
      buildExamKnowledgeSuggestionsArtifact({
        ...input,
        questionDrafts,
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID' }));
  });

  it('rejects Unicode controls, format characters, and line separators in labels and evidence', () => {
    const unsafeCharacters = ['\u0085', '\u200b', '\u202e', '\u2028', '\u2029'];
    const input = buildInput();
    const proposedQuestion = input.questionDrafts.find(
      (question) => question.suggestions[0]?.kind === 'proposed_label',
    )!;
    const proposed = proposedQuestion.suggestions[0] as Extract<
      ExamKnowledgeSuggestionDraftV1,
      { kind: 'proposed_label' }
    >;

    for (const unsafeCharacter of unsafeCharacters) {
      expect(isSafeExamKnowledgeSuggestionProposedLabel(`方程${unsafeCharacter}求解`)).toBe(false);
      expect(isSafeExamKnowledgeSuggestionEvidencePhrase(`方程${unsafeCharacter}求解`)).toBe(false);
      const questionDrafts = input.questionDrafts.map((question) =>
        question.confirmedQuestionId === proposedQuestion.confirmedQuestionId
          ? {
              ...question,
              suggestions: [{ ...proposed, proposedLabel: `方程${unsafeCharacter}求解` }],
            }
          : question,
      );
      expect(() =>
        buildExamKnowledgeSuggestionsArtifact({ ...input, questionDrafts }),
      ).toThrowError(expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID' }));
    }
    expect(isSafeExamKnowledgeSuggestionProposedLabel('方程求解')).toBe(true);
    expect(isSafeExamKnowledgeSuggestionEvidencePhrase('一元一次方程')).toBe(true);
  });

  it('rejects model-supplied trusted fields and source digest changes', () => {
    const input = buildInput();
    const first = input.questionDrafts[0]!;
    for (const mutation of [
      { ...first, outcome: 'correct' },
      {
        ...first,
        suggestions: first.suggestions.map((suggestion) => ({
          ...suggestion,
          candidateId: 'model-controlled-id',
        })),
      },
    ]) {
      expect(() =>
        buildExamKnowledgeSuggestionsArtifact({
          ...input,
          questionDrafts: [
            mutation as unknown as ExamKnowledgeSuggestionQuestionDraftV1,
            ...input.questionDrafts.slice(1),
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID' }));
    }
    expect(() =>
      buildExamKnowledgeSuggestionsArtifact({
        ...input,
        confirmedReviewArtifactSha256: '0'.repeat(64),
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_SOURCE_INVALID' }));
  });

  it('detects candidate, count, ref, pool, and semantic fingerprint tampering', () => {
    const artifact = buildExamKnowledgeSuggestionsArtifact(buildInput());
    const mutations = [
      { ...artifact, suggestionCount: artifact.suggestionCount + 1 },
      { ...artifact, generationRef: `${artifact.generationRef}-changed` },
      { ...artifact, suggestionArtifactRef: `${artifact.suggestionArtifactRef}-changed` },
      { ...artifact, semanticFingerprint: '0'.repeat(64) },
      {
        ...artifact,
        pool: { ...artifact.pool, fingerprint: '0'.repeat(64) },
      },
      {
        ...artifact,
        questions: artifact.questions.map((question, index) =>
          index === 0
            ? {
                ...question,
                suggestions: question.suggestions.map((suggestion) => ({
                  ...suggestion,
                  candidateId: `${suggestion.candidateId}-changed`,
                })),
              }
            : question,
        ),
      },
    ];
    for (const mutation of mutations) {
      expect(validateExamKnowledgeSuggestionsArtifact(mutation).valid).toBe(false);
      expect(() => parseExamKnowledgeSuggestionsArtifact(mutation)).toThrowError(
        expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT' }),
      );
    }
  });

  it('fails closed for malformed or oversized serialized artifacts', () => {
    expect(() => parseExamKnowledgeSuggestionsArtifact(Buffer.from('{not-json'))).toThrowError(
      expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT' }),
    );
    expect(() =>
      parseExamKnowledgeSuggestionsArtifact(
        Buffer.alloc(EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxArtifactBytes + 1),
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT' }));
  });

  it('serializes a near-limit legal question and evidence combination below four MiB', () => {
    const evidencePhrases = [218, 219, 220].map((length) => '证'.repeat(length));
    const confirmedReview = boundaryReviewFixture(
      EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxQuestions,
      evidencePhrases.at(-1)!,
    );
    const input: BuildExamKnowledgeSuggestionsArtifactInput = {
      examSessionId: EXAM_SESSION_ID,
      profileId: PROFILE_ID,
      subjectId: SUBJECT_ID,
      confirmedReview,
      confirmedReviewArtifactSha256: digest(serializeConfirmedExamReviewFacts(confirmedReview)),
      pool: buildExamKnowledgeCandidatePool({ subjectId: SUBJECT_ID, knowledgePointIds: [] }),
      generator: { generatorVersion: 'knowledge-suggestions-v1', candidateSchemaVersion: 1 },
      questionDrafts: confirmedReview.confirmedQuestions.map((question) => ({
        confirmedQuestionId: question.confirmedQuestionId,
        questionText: question.questionText,
        generationStatus: 'generated',
        suggestions: ['甲', '乙', '丙'].map((suffix) => ({
          kind: 'proposed_label' as const,
          proposedLabel: `虚构概念${suffix}`,
          confidenceBand: 'low' as const,
          evidencePhrases,
        })),
      })),
    };

    const artifact = buildExamKnowledgeSuggestionsArtifact(input);
    const bytes = serializeExamKnowledgeSuggestionsArtifact(artifact);

    expect(artifact).toMatchObject({
      questionCount: EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxQuestions,
      suggestionCount:
        EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxQuestions *
        EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxSuggestionsPerQuestion,
    });
    expect(bytes.byteLength).toBeGreaterThan(3 * 1024 * 1024);
    expect(bytes.byteLength).toBeLessThan(EXAM_KNOWLEDGE_SUGGESTION_LIMITS.maxArtifactBytes);
    expect(bytes.includes(Buffer.from('questionText'))).toBe(false);
    expect(bytes.includes(Buffer.from('parentContext'))).toBe(false);
  });
});
