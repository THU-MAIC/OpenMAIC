import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildConfirmedExamReviewFacts,
  createExamHumanReviewDecisionSemanticFingerprint,
  parseConfirmedExamReviewFacts,
  parseExamHumanReviewRequest,
  serializeConfirmedExamReviewFacts,
  validateConfirmedExamReviewFacts,
  validateExamHumanReviewRequest,
  type BuildConfirmedExamReviewFactsInput,
  type ExamHumanReviewDecision,
  type ExamHumanReviewRequest,
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

const EXAM_SESSION_ID = 'exam-human-review-fixture';
const QUESTION_ARTIFACT_REF = 'exam-question-candidates:v1:fixture';
const RESPONSE_ARTIFACT_REF = 'exam-student-response-candidates:v1:fixture';
const MATCHING_ARTIFACT_REF = 'exam-question-response-matches:v1:fixture';
const REVIEW_REF = 'exam-human-review:v1:fixture';
const REVIEW_ARTIFACT_REF = 'exam-confirmed-review-facts:v1:fixture';

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture() {
  const questions = segmentExamQuestionCandidates({
    examSessionId: EXAM_SESSION_ID,
    examDocumentId: 'question-paper-fixture',
    artifact: {
      schemaVersion: 1,
      artifactVersion: 1,
      examSessionId: EXAM_SESSION_ID,
      examDocumentId: 'question-paper-fixture',
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
                '1. 虚构原题一',
                '2. 虚构原题二',
                '三、解答题',
                '17. 虚构共同题干',
                '(1) 虚构子题',
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
    captureRef: 'exam-response-capture:v1:fixture',
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    questionCandidateArtifactRef: QUESTION_ARTIFACT_REF,
    questionCandidateArtifactSha256: questionSha,
    questionSegmentationVersion: 1,
    request: { format: 'numbered_text_v1', text: '1=A\n17(1)=   \n99=误录' },
  });
  const responseSha = digest(serializeStudentResponseCandidatesArtifact(responses));
  const matches = buildExamQuestionResponseMatchesArtifact({
    examSessionId: EXAM_SESSION_ID,
    matchingArtifactRef: MATCHING_ARTIFACT_REF,
    questionCandidateArtifactRef: QUESTION_ARTIFACT_REF,
    questionCandidateArtifactSha256: questionSha,
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    questionCandidatesArtifact: questions,
    responseCandidatesArtifact: responses,
  });
  const matchingSha = digest(serializeExamQuestionResponseMatchesArtifact(matches));
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
  return {
    questions,
    responses,
    matches,
    questionSha,
    responseSha,
    matchingSha,
    q1: byQuestion.get('leaf:1:')!,
    q2: byQuestion.get('leaf:2:')!,
    group17: byQuestion.get('group:17:')!,
    q17_1: byQuestion.get('leaf:17:1')!,
    r1: byResponse.get('1:')!,
    r17_1: byResponse.get('17:1')!,
    r99: byResponse.get('99:')!,
  };
}

function completeRequest(data = fixture()): ExamHumanReviewRequest {
  return {
    schemaVersion: 1,
    decisions: [
      { decisionType: 'confirm_question', questionCandidateId: data.q1.candidateId },
      {
        decisionType: 'correct_question',
        questionCandidateId: data.q2.candidateId,
        correctedQuestionText: '3. 用户确认后的虚构题面',
        correctedRawLabel: '3.',
        correctedSectionHeading: '二、填空题',
      },
      {
        decisionType: 'reject_question',
        questionCandidateId: data.group17.candidateId,
        reason: 'segmentation_error',
      },
      { decisionType: 'confirm_question', questionCandidateId: data.q17_1.candidateId },
      {
        decisionType: 'confirm_response',
        responseCandidateId: data.r1.candidateId,
        questionCandidateId: data.q1.candidateId,
      },
      {
        decisionType: 'correct_response',
        responseCandidateId: data.r17_1.candidateId,
        questionCandidateId: data.q17_1.candidateId,
        responseOverride: { status: 'blank' },
      },
      {
        decisionType: 'reject_response',
        responseCandidateId: data.r99.candidateId,
        reason: 'wrong_label',
      },
      { decisionType: 'confirm_no_response', questionCandidateId: data.q2.candidateId },
    ],
  };
}

function buildInput(
  data = fixture(),
  request: unknown = completeRequest(data),
): BuildConfirmedExamReviewFactsInput {
  return {
    examSessionId: EXAM_SESSION_ID,
    reviewRef: REVIEW_REF,
    reviewArtifactRef: REVIEW_ARTIFACT_REF,
    questionArtifactRef: QUESTION_ARTIFACT_REF,
    questionArtifactSha256: data.questionSha,
    questionExtractionVersion: 1,
    questionSegmentationVersion: 1,
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    responseArtifactSha256: data.responseSha,
    responseCaptureVersion: 1,
    matchingArtifactRef: MATCHING_ARTIFACT_REF,
    matchingArtifactSha256: data.matchingSha,
    matchingVersion: 1,
    questionCandidatesArtifact: data.questions,
    responseCandidatesArtifact: data.responses,
    questionResponseMatchesArtifact: data.matches,
    request,
  };
}

describe('Exam human review request', () => {
  it('accepts the closed decision union and canonicalizes array order', () => {
    const request = completeRequest();
    const reversed = { ...request, decisions: [...request.decisions].reverse() };
    const first = parseExamHumanReviewRequest(request);
    const second = parseExamHumanReviewRequest(reversed);

    expect(first).toEqual(second);
    expect(createExamHumanReviewDecisionSemanticFingerprint(first)).toBe(
      createExamHumanReviewDecisionSemanticFingerprint(second),
    );
    expect(validateExamHumanReviewRequest(first)).toEqual({ valid: true });
  });

  it('rejects unknown fields, unknown reasons, empty corrections, and implicit blank answers', () => {
    const data = fixture();
    const invalid: unknown[] = [
      { schemaVersion: 1, decisions: [], extra: true },
      {
        schemaVersion: 1,
        decisions: [
          {
            decisionType: 'reject_question',
            questionCandidateId: data.q1.candidateId,
            reason: 'model_guess',
          },
        ],
      },
      {
        schemaVersion: 1,
        decisions: [{ decisionType: 'correct_question', questionCandidateId: data.q1.candidateId }],
      },
      {
        schemaVersion: 1,
        decisions: [
          {
            decisionType: 'correct_response',
            responseCandidateId: data.r1.candidateId,
            questionCandidateId: data.q1.candidateId,
            responseOverride: { status: 'text', rawAnswerText: '   ' },
          },
        ],
      },
      {
        schemaVersion: 1,
        decisions: [
          {
            decisionType: 'correct_question',
            questionCandidateId: data.q1.candidateId,
            correctedRawLabel: '1. 夹带题面',
          },
        ],
      },
    ];
    invalid.forEach((request) => expect(validateExamHumanReviewRequest(request).valid).toBe(false));
  });

  it('enforces all configured request bounds', () => {
    const data = fixture();
    expect(
      validateExamHumanReviewRequest({
        schemaVersion: 1,
        decisions: Array.from({ length: 1_001 }, () => ({
          decisionType: 'confirm_question',
          questionCandidateId: data.q1.candidateId,
        })),
      }).valid,
    ).toBe(false);
    expect(
      validateExamHumanReviewRequest({
        schemaVersion: 1,
        decisions: [
          {
            decisionType: 'correct_question',
            questionCandidateId: data.q1.candidateId,
            correctedQuestionText: 'x'.repeat(100_001),
          },
        ],
      }).valid,
    ).toBe(false);
    expect(
      validateExamHumanReviewRequest({
        schemaVersion: 1,
        decisions: [
          {
            decisionType: 'correct_response',
            responseCandidateId: data.r1.candidateId,
            questionCandidateId: data.q1.candidateId,
            responseOverride: { status: 'text', rawAnswerText: 'x'.repeat(16 * 1024 + 1) },
          },
        ],
      }).valid,
    ).toBe(false);
  });
});

describe('confirmed Exam review facts', () => {
  it('builds deterministic full-set facts without correctness or grading fields', () => {
    const data = fixture();
    const first = buildConfirmedExamReviewFacts(buildInput(data));
    const reordered = buildConfirmedExamReviewFacts(
      buildInput(data, {
        ...completeRequest(data),
        decisions: [...completeRequest(data).decisions].reverse(),
      }),
    );

    expect(serializeConfirmedExamReviewFacts(reordered)).toEqual(
      serializeConfirmedExamReviewFacts(first),
    );
    expect(first).toMatchObject({
      confirmedQuestionCount: 3,
      confirmedResponseCount: 3,
      confirmedMatchCount: 3,
      rejectedQuestionCount: 1,
      rejectedResponseCount: 1,
    });
    const corrected = first.confirmedQuestions.find(
      (question) => question.sourceQuestionCandidateId === data.q2.candidateId,
    )!;
    expect(corrected).toMatchObject({
      rawLabel: '3.',
      locator: {
        printedNumber: '3',
        sectionPath: [{ normalizedId: 'section:2', rawLabel: '二、填空题' }],
      },
      questionText: '3. 用户确认后的虚构题面',
      textSource: 'owner_corrected',
      locatorSource: 'owner_corrected',
    });
    const noResponse = first.confirmedResponses.find(
      (response) => response.confirmedQuestionId === corrected.confirmedQuestionId,
    )!;
    expect(noResponse).toEqual(
      expect.objectContaining({
        answerStatus: 'no_response',
        answerSource: 'owner_no_response',
      }),
    );
    expect(noResponse).not.toHaveProperty('sourceResponseCandidateId');
    expect(noResponse).not.toHaveProperty('rawAnswerText');
    const child = first.confirmedQuestions.find(
      (question) => question.sourceQuestionCandidateId === data.q17_1.candidateId,
    )!;
    expect(child).toMatchObject({
      parentSourceCandidateId: data.group17.candidateId,
      parentContext: {
        sourceQuestionCandidateId: data.group17.candidateId,
        rawLabel: data.group17.rawLabel,
        locator: data.group17.locator,
        questionText: data.group17.text,
        contextSource: 'extracted_confirmed',
        sourceSpans: data.group17.sourceSpans,
      },
    });
    const serialized = serializeConfirmedExamReviewFacts(first).toString('utf8');
    expect(serialized).not.toMatch(/correctness|gradingSpec|expectedAnswer|score/iu);
  });

  it('preserves blank separately from no_response', () => {
    const data = fixture();
    const artifact = buildConfirmedExamReviewFacts(buildInput(data));
    const blank = artifact.confirmedResponses.find(
      (response) => response.sourceResponseCandidateId === data.r17_1.candidateId,
    )!;
    expect(blank).toMatchObject({ answerStatus: 'blank', answerSource: 'owner_corrected' });
    expect(blank).not.toHaveProperty('rawAnswerText');
    expect(
      artifact.confirmedResponses.some((response) => response.answerStatus === 'no_response'),
    ).toBe(true);
  });

  it('normalizes a corrected full-width complete label through the shared locator parser', () => {
    const data = fixture();
    const decisions = completeRequest(data).decisions.map((decision) =>
      decision.decisionType === 'correct_question' &&
      decision.questionCandidateId === data.q2.candidateId
        ? {
            decisionType: 'correct_question' as const,
            questionCandidateId: data.q2.candidateId,
            correctedRawLabel: '３',
          }
        : decision,
    );
    const artifact = buildConfirmedExamReviewFacts(
      buildInput(data, { schemaVersion: 1, decisions }),
    );
    expect(
      artifact.confirmedQuestions.find(
        (question) => question.sourceQuestionCandidateId === data.q2.candidateId,
      ),
    ).toMatchObject({ rawLabel: '３', locator: { printedNumber: '3' } });
  });

  it('accepts a plain complete corrected label through the shared response locator parser', () => {
    const data = fixture();
    const decisions = completeRequest(data).decisions.map((decision) =>
      decision.decisionType === 'correct_question' &&
      decision.questionCandidateId === data.q2.candidateId
        ? {
            decisionType: 'correct_question' as const,
            questionCandidateId: data.q2.candidateId,
            correctedRawLabel: '3',
          }
        : decision,
    );
    const artifact = buildConfirmedExamReviewFacts(
      buildInput(data, { schemaVersion: 1, decisions }),
    );
    expect(
      artifact.confirmedQuestions.find(
        (question) => question.sourceQuestionCandidateId === data.q2.candidateId,
      ),
    ).toMatchObject({ rawLabel: '3', locator: { printedNumber: '3' } });
  });

  it('marks a uniquely matched pair deterministic and an explicit unmatched link manual', () => {
    const data = fixture();
    const decisions: ExamHumanReviewDecision[] = [
      { decisionType: 'confirm_question', questionCandidateId: data.q1.candidateId },
      { decisionType: 'confirm_question', questionCandidateId: data.q2.candidateId },
      {
        decisionType: 'reject_question',
        questionCandidateId: data.group17.candidateId,
        reason: 'not_a_question',
      },
      { decisionType: 'confirm_question', questionCandidateId: data.q17_1.candidateId },
      {
        decisionType: 'confirm_response',
        responseCandidateId: data.r1.candidateId,
        questionCandidateId: data.q1.candidateId,
      },
      {
        decisionType: 'confirm_response',
        responseCandidateId: data.r17_1.candidateId,
        questionCandidateId: data.q17_1.candidateId,
      },
      {
        decisionType: 'correct_response',
        responseCandidateId: data.r99.candidateId,
        questionCandidateId: data.q2.candidateId,
        responseOverride: { status: 'text', rawAnswerText: 'x=-2（用户确认）' },
      },
    ];
    const artifact = buildConfirmedExamReviewFacts(
      buildInput(data, { schemaVersion: 1, decisions }),
    );
    const responseBySource = new Map(
      artifact.confirmedResponses.map((response) => [response.sourceResponseCandidateId, response]),
    );
    const relationFor = (responseCandidateId: string) => {
      const response = responseBySource.get(responseCandidateId)!;
      return artifact.confirmedMatches.find(
        (match) => match.confirmedResponseId === response.confirmedResponseId,
      )!.relationSource;
    };
    expect(relationFor(data.r1.candidateId)).toBe('deterministic_match_confirmed');
    expect(relationFor(data.r99.candidateId)).toBe('owner_manual_link');
    expect(responseBySource.get(data.r99.candidateId)).toMatchObject({
      rawAnswerText: 'x=-2（用户确认）',
      answerSource: 'owner_corrected',
    });
  });

  it('requires an explicit decision for groups and permits only rejection', () => {
    const data = fixture();
    const missingGroup = completeRequest(data).decisions.filter(
      (decision) =>
        !(
          decision.decisionType === 'reject_question' &&
          decision.questionCandidateId === data.group17.candidateId
        ),
    );
    expect(() =>
      buildConfirmedExamReviewFacts(
        buildInput(data, { schemaVersion: 1, decisions: missingGroup }),
      ),
    ).toThrow('EXAM_REVIEW_INCOMPLETE');

    const confirmGroup = completeRequest(data).decisions.map((decision) =>
      decision.decisionType === 'reject_question' &&
      decision.questionCandidateId === data.group17.candidateId
        ? ({
            decisionType: 'confirm_question',
            questionCandidateId: data.group17.candidateId,
          } as const)
        : decision,
    );
    expect(() =>
      buildConfirmedExamReviewFacts(
        buildInput(data, { schemaVersion: 1, decisions: confirmGroup }),
      ),
    ).toThrow('EXAM_REVIEW_INCOMPLETE');
  });

  it.each([
    [
      'missing leaf decision',
      (data: ReturnType<typeof fixture>) =>
        completeRequest(data).decisions.filter(
          (decision) =>
            !(
              'questionCandidateId' in decision &&
              decision.questionCandidateId === data.q1.candidateId &&
              decision.decisionType === 'confirm_question'
            ),
        ),
    ],
    [
      'missing response decision',
      (data: ReturnType<typeof fixture>) =>
        completeRequest(data).decisions.filter(
          (decision) =>
            !(
              'responseCandidateId' in decision &&
              decision.responseCandidateId === data.r1.candidateId
            ),
        ),
    ],
    [
      'response reuse',
      (data: ReturnType<typeof fixture>) => [
        ...completeRequest(data).decisions,
        {
          decisionType: 'confirm_response' as const,
          responseCandidateId: data.r1.candidateId,
          questionCandidateId: data.q2.candidateId,
        },
      ],
    ],
    [
      'confirmed locator collision',
      (data: ReturnType<typeof fixture>) =>
        completeRequest(data).decisions.map((decision) =>
          decision.decisionType === 'correct_question' &&
          decision.questionCandidateId === data.q2.candidateId
            ? {
                decisionType: 'correct_question' as const,
                questionCandidateId: data.q2.candidateId,
                correctedRawLabel: '1.',
              }
            : decision,
        ),
    ],
    [
      'cross-exam question candidate injection',
      (data: ReturnType<typeof fixture>) =>
        completeRequest(data).decisions.map((decision) =>
          decision.decisionType === 'confirm_question' &&
          decision.questionCandidateId === data.q1.candidateId
            ? {
                decisionType: 'confirm_question' as const,
                questionCandidateId: `exam-question-candidate:v1:${'f'.repeat(64)}`,
              }
            : decision,
        ),
    ],
  ])('rejects semantically incomplete review: %s', (_name, decisionsFor) => {
    const data = fixture();
    expect(() =>
      buildConfirmedExamReviewFacts(
        buildInput(data, { schemaVersion: 1, decisions: decisionsFor(data) }),
      ),
    ).toThrow('EXAM_REVIEW_INCOMPLETE');
  });

  it('fails closed when any exact upstream source binding changes', () => {
    const data = fixture();
    expect(() =>
      buildConfirmedExamReviewFacts({
        ...buildInput(data),
        responseArtifactSha256: 'f'.repeat(64),
      }),
    ).toThrow('EXAM_REVIEW_ARTIFACT_INVALID');
    expect(() =>
      buildConfirmedExamReviewFacts({
        ...buildInput(data),
        questionSegmentationVersion: 2,
      }),
    ).toThrow('EXAM_REVIEW_ARTIFACT_INVALID');
  });

  it('round-trips canonical bytes and rejects deterministic-ID or schema tampering', () => {
    const artifact = buildConfirmedExamReviewFacts(buildInput());
    const bytes = serializeConfirmedExamReviewFacts(artifact);
    expect(parseConfirmedExamReviewFacts(bytes)).toEqual(artifact);
    expect(validateConfirmedExamReviewFacts(artifact)).toEqual({ valid: true });

    const badId = structuredClone(artifact);
    badId.confirmedQuestions[0]!.confirmedQuestionId = 'exam-confirmed-question:v1:tampered';
    expect(validateConfirmedExamReviewFacts(badId).valid).toBe(false);
    expect(() => parseConfirmedExamReviewFacts(Buffer.from(JSON.stringify(badId)))).toThrow(
      'EXAM_REVIEW_ARTIFACT_INVALID',
    );

    const leakedGrading = structuredClone(artifact) as unknown as {
      confirmedResponses: Array<Record<string, unknown>>;
    };
    leakedGrading.confirmedResponses[0]!.correctness = 'correct';
    expect(validateConfirmedExamReviewFacts(leakedGrading).valid).toBe(false);

    const badParentContext = structuredClone(artifact);
    const child = badParentContext.confirmedQuestions.find(
      (question) => question.parentContext !== undefined,
    )!;
    child.parentContext!.sourceQuestionCandidateId = 'foreign-parent-candidate';
    expect(validateConfirmedExamReviewFacts(badParentContext).valid).toBe(false);
  });
});
