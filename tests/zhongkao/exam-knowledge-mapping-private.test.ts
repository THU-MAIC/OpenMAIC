import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE,
  ExamKnowledgeMappingPrivateError,
  buildConfirmedExamKnowledgeMappingArtifact,
  buildConfirmedExamObservationsArtifact,
  createConfirmedExamObservationsSemanticFingerprint,
  createExamKnowledgeMappingSemanticFingerprint,
  parseConfirmedExamKnowledgeMappingArtifact,
  parseConfirmedExamObservationsArtifact,
  parseExamKnowledgeMappingRequest,
  serializeConfirmedExamKnowledgeMappingArtifact,
  serializeConfirmedExamObservationsArtifact,
  validateConfirmedExamKnowledgeMappingArtifact,
  validateConfirmedExamObservationsArtifact,
  validateExamKnowledgeMappingRequest,
  type ConfirmedExamKnowledgeMappingArtifactV1,
  type ConfirmedExamObservationsArtifactV1,
  type ExamKnowledgeMappingRequestV1,
} from '@/lib/server/zhongkao/exam-knowledge-mapping-private';
import {
  buildAuthoritativeExamAnswerKeyArtifact,
  buildExamQuestionAssessmentsArtifact,
  serializeExamQuestionAssessmentsArtifact,
  type ExamQuestionAssessmentsArtifactV1,
} from '@/lib/server/zhongkao/exam-grading-private';
import {
  buildConfirmedExamReviewFacts,
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

const EXAM_SESSION_ID = 'exam-knowledge-mapping-fixture';
const PROFILE_ID = 'fictional-profile';
const SUBJECT_ID = 'math';
const OBSERVED_AT = '2026-09-01T08:00:00.000Z';
const QUESTION_ARTIFACT_REF = 'exam-question-candidates:v1:knowledge-fixture';
const RESPONSE_ARTIFACT_REF = 'exam-student-response-candidates:v1:knowledge-fixture';
const MATCHING_ARTIFACT_REF = 'exam-question-response-matches:v1:knowledge-fixture';

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function reviewFixture(): ConfirmedExamReviewFactsV1 {
  const questions = segmentExamQuestionCandidates({
    examSessionId: EXAM_SESSION_ID,
    examDocumentId: 'question-paper-knowledge-fixture',
    artifact: {
      schemaVersion: 1,
      artifactVersion: 1,
      examSessionId: EXAM_SESSION_ID,
      examDocumentId: 'question-paper-knowledge-fixture',
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
                '1. Fictional correct objective question',
                '2. Fictional incorrect objective question',
                '3. Fictional unsupported open question',
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
    captureRef: 'exam-response-capture:v1:knowledge-fixture',
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    questionCandidateArtifactRef: QUESTION_ARTIFACT_REF,
    questionCandidateArtifactSha256: questionArtifactSha256,
    questionSegmentationVersion: 1,
    request: {
      format: 'numbered_text_v1',
      text: ['1=B', '2=A', '3=Fictional proof response'].join('\n'),
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
  return buildConfirmedExamReviewFacts({
    examSessionId: EXAM_SESSION_ID,
    reviewRef: 'exam-human-review:v1:knowledge-fixture',
    reviewArtifactRef: 'exam-confirmed-review-facts:v1:knowledge-fixture',
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

function questionId(review: ConfirmedExamReviewFactsV1, number: string): string {
  return review.confirmedQuestions.find((question) => question.locator.printedNumber === number)!
    .confirmedQuestionId;
}

function assessmentFixture(review: ConfirmedExamReviewFactsV1): ExamQuestionAssessmentsArtifactV1 {
  const key = buildAuthoritativeExamAnswerKeyArtifact({
    examSessionId: EXAM_SESSION_ID,
    subjectId: SUBJECT_ID,
    confirmedReview: review,
    confirmedReviewArtifactSha256: digest(serializeConfirmedExamReviewFacts(review)),
    request: {
      schemaVersion: 1,
      entries: [
        {
          confirmedQuestionId: questionId(review, '1'),
          type: 'single_choice',
          expectedOptionId: 'B',
        },
        {
          confirmedQuestionId: questionId(review, '2'),
          type: 'single_choice',
          expectedOptionId: 'B',
        },
        {
          confirmedQuestionId: questionId(review, '3'),
          type: 'unassessed',
          reason: 'unsupported_question_type',
        },
      ],
    },
  });
  return buildExamQuestionAssessmentsArtifact({ confirmedReview: review, answerKey: key });
}

function mappingRequest(
  review: ConfirmedExamReviewFactsV1,
  thirdDecision: 'mapped' | 'unmapped' = 'mapped',
): ExamKnowledgeMappingRequestV1 {
  return {
    schemaVersion: 1,
    entries: [
      {
        confirmedQuestionId: questionId(review, '2'),
        decision: 'mapped',
        knowledgePointIds: ['linear-equations', 'fractions'],
      },
      thirdDecision === 'mapped'
        ? {
            confirmedQuestionId: questionId(review, '3'),
            decision: 'mapped',
            knowledgePointIds: ['geometry-proof'],
          }
        : {
            confirmedQuestionId: questionId(review, '3'),
            decision: 'unmapped',
            reason: 'unsupported',
          },
      {
        confirmedQuestionId: questionId(review, '1'),
        decision: 'mapped',
        knowledgePointIds: ['fractions'],
      },
    ],
  };
}

function sources() {
  const review = reviewFixture();
  const assessments = assessmentFixture(review);
  return {
    review,
    reviewSha256: digest(serializeConfirmedExamReviewFacts(review)),
    assessments,
    assessmentSha256: digest(serializeExamQuestionAssessmentsArtifact(assessments)),
  };
}

function buildMapping(
  source = sources(),
  request: unknown = mappingRequest(source.review),
): ConfirmedExamKnowledgeMappingArtifactV1 {
  return buildConfirmedExamKnowledgeMappingArtifact({
    examSessionId: EXAM_SESSION_ID,
    profileId: PROFILE_ID,
    subjectId: SUBJECT_ID,
    confirmedReview: source.review,
    confirmedReviewArtifactSha256: source.reviewSha256,
    assessments: source.assessments,
    assessmentArtifactSha256: source.assessmentSha256,
    request: request as ExamKnowledgeMappingRequestV1,
  });
}

function buildObservations(
  source = sources(),
  mapping = buildMapping(source),
): ConfirmedExamObservationsArtifactV1 {
  return buildConfirmedExamObservationsArtifact({
    profileId: PROFILE_ID,
    subjectId: SUBJECT_ID,
    observedAt: OBSERVED_AT,
    confirmedReview: source.review,
    confirmedReviewArtifactSha256: source.reviewSha256,
    assessments: source.assessments,
    assessmentArtifactSha256: source.assessmentSha256,
    mapping,
    mappingArtifactSha256: digest(serializeConfirmedExamKnowledgeMappingArtifact(mapping)),
  });
}

function refingerprintMapping(
  artifact: ConfirmedExamKnowledgeMappingArtifactV1,
): ConfirmedExamKnowledgeMappingArtifactV1 {
  const { semanticFingerprint: _ignored, ...facts } = artifact;
  return {
    ...artifact,
    semanticFingerprint: createExamKnowledgeMappingSemanticFingerprint(facts),
  };
}

function refingerprintObservations(
  artifact: ConfirmedExamObservationsArtifactV1,
): ConfirmedExamObservationsArtifactV1 {
  const { semanticFingerprint: _ignored, ...facts } = artifact;
  return {
    ...artifact,
    semanticFingerprint: createConfirmedExamObservationsSemanticFingerprint(facts),
  };
}

describe('manual Exam knowledge mapping request', () => {
  it('accepts the closed union and canonicalizes question and knowledge-point order', () => {
    const review = reviewFixture();
    const request = mappingRequest(review, 'unmapped');
    const parsed = parseExamKnowledgeMappingRequest({
      ...request,
      entries: [...request.entries]
        .reverse()
        .map((entry) =>
          entry.decision === 'mapped'
            ? { ...entry, knowledgePointIds: [...entry.knowledgePointIds].reverse() }
            : entry,
        ),
    });

    expect(parsed.entries.map((entry) => entry.confirmedQuestionId)).toEqual(
      [...parsed.entries.map((entry) => entry.confirmedQuestionId)].sort(),
    );
    expect(
      parsed.entries.find((entry) => entry.confirmedQuestionId === questionId(review, '2')),
    ).toMatchObject({ knowledgePointIds: ['fractions', 'linear-equations'] });
  });

  it.each([
    { schemaVersion: 1, entries: [], extra: true },
    {
      schemaVersion: 2,
      entries: [{ confirmedQuestionId: 'q', decision: 'unmapped', reason: 'unknown' }],
    },
    { schemaVersion: 1, entries: [{ confirmedQuestionId: 'q', decision: 'automatic' }] },
    {
      schemaVersion: 1,
      entries: [{ confirmedQuestionId: 'q', decision: 'mapped', knowledgePointIds: [] }],
    },
    {
      schemaVersion: 1,
      entries: [
        {
          confirmedQuestionId: 'q',
          decision: 'mapped',
          knowledgePointIds: ['kp', 'kp'],
        },
      ],
    },
    {
      schemaVersion: 1,
      entries: [{ confirmedQuestionId: 'q', decision: 'unmapped', reason: 'free text' }],
    },
    {
      schemaVersion: 1,
      entries: [
        {
          confirmedQuestionId: 'q',
          decision: 'mapped',
          knowledgePointIds: ['kp'],
          outcome: 'incorrect',
        },
      ],
    },
    {
      schemaVersion: 1,
      entries: [
        { confirmedQuestionId: 'q', decision: 'unmapped', reason: 'unknown' },
        { confirmedQuestionId: 'q', decision: 'unmapped', reason: 'not_applicable' },
      ],
    },
  ])('rejects unknown, duplicate, empty, outcome, and extra fields %#', (request) => {
    expect(validateExamKnowledgeMappingRequest(request).valid).toBe(false);
  });

  it('requires exactly one decision for every confirmed question, including unassessed', () => {
    const source = sources();
    const missing = mappingRequest(source.review);
    missing.entries.pop();
    expect(() => buildMapping(source, missing)).toThrowError(
      expect.objectContaining({ code: 'EXAM_KNOWLEDGE_MAPPING_INCOMPLETE' }),
    );

    const foreign = mappingRequest(source.review);
    foreign.entries[0] = { ...foreign.entries[0]!, confirmedQuestionId: 'other-exam-question' };
    expect(() => buildMapping(source, foreign)).toThrowError(
      expect.objectContaining({ code: 'EXAM_KNOWLEDGE_MAPPING_INCOMPLETE' }),
    );
  });
});

describe('confirmed private Exam knowledge mapping artifact', () => {
  it('is deterministic across request order and binds manual authority plus both sources', () => {
    const source = sources();
    const request = mappingRequest(source.review);
    const first = buildMapping(source, request);
    const reordered = buildMapping(source, {
      ...request,
      entries: [...request.entries]
        .reverse()
        .map((entry) =>
          entry.decision === 'mapped'
            ? { ...entry, knowledgePointIds: [...entry.knowledgePointIds].reverse() }
            : entry,
        ),
    });

    expect(reordered).toEqual(first);
    expect(first).toMatchObject({
      authoritySource: EXAM_KNOWLEDGE_MAPPING_AUTHORITY_SOURCE,
      entryCount: 3,
      mappedQuestionCount: 3,
      unmappedQuestionCount: 0,
      sourceReview: {
        decisionSemanticFingerprint: source.review.decisionSemanticFingerprint,
        reviewArtifactSha256: source.reviewSha256,
      },
      sourceAssessments: {
        semanticFingerprint: source.assessments.semanticFingerprint,
        assessmentArtifactSha256: source.assessmentSha256,
      },
    });
    expect(serializeConfirmedExamKnowledgeMappingArtifact(first).toString('utf8')).not.toMatch(
      /questionText|rawAnswerText|outcome|official|expert|textbook|provider|llm/iu,
    );
  });

  it('rejects source digest substitution before creating a trusted mapping', () => {
    const source = sources();
    expect(() =>
      buildConfirmedExamKnowledgeMappingArtifact({
        examSessionId: EXAM_SESSION_ID,
        profileId: PROFILE_ID,
        subjectId: SUBJECT_ID,
        confirmedReview: source.review,
        confirmedReviewArtifactSha256: '0'.repeat(64),
        assessments: source.assessments,
        assessmentArtifactSha256: source.assessmentSha256,
        request: mappingRequest(source.review),
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXAM_KNOWLEDGE_MAPPING_SOURCE_INVALID' }));
  });

  it('round-trips canonically and rejects authority, source, ordering, and fingerprint tampering', () => {
    const mapping = buildMapping();
    expect(
      parseConfirmedExamKnowledgeMappingArtifact(
        serializeConfirmedExamKnowledgeMappingArtifact(mapping),
      ),
    ).toEqual(mapping);

    const mutations: ConfirmedExamKnowledgeMappingArtifactV1[] = [];
    const authority = structuredClone(mapping) as unknown as Record<string, unknown>;
    authority.authoritySource = 'official_curriculum_mapping';
    mutations.push(authority as unknown as ConfirmedExamKnowledgeMappingArtifactV1);
    const source = structuredClone(mapping);
    source.sourceAssessments.semanticFingerprint = '0'.repeat(64);
    mutations.push(source);
    const reordered = structuredClone(mapping);
    reordered.entries.reverse();
    mutations.push(reordered);
    const changed = structuredClone(mapping);
    const mapped = changed.entries.find((entry) => entry.decision === 'mapped');
    if (mapped?.decision !== 'mapped') throw new Error('fixture mismatch');
    mapped.knowledgePointIds.push('injected-point');
    mutations.push(changed);

    for (const mutation of mutations) {
      expect(validateConfirmedExamKnowledgeMappingArtifact(mutation).valid).toBe(false);
      expect(() => parseConfirmedExamKnowledgeMappingArtifact(mutation)).toThrowError(
        expect.objectContaining({ code: 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT' }),
      );
    }
  });

  it('rejects a re-fingerprinted assessment source that is not derived from the same review', () => {
    const mapping = structuredClone(buildMapping());
    mapping.sourceAssessments.answerKeyRef = 'exam-answer-key:v1:cross-review';
    const refingerprinted = refingerprintMapping(mapping);

    expect(validateConfirmedExamKnowledgeMappingArtifact(refingerprinted).valid).toBe(false);
    expect(() => parseConfirmedExamKnowledgeMappingArtifact(refingerprinted)).toThrowError(
      expect.objectContaining({ code: 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT' }),
    );
  });
});

describe('confirmed private Exam observations artifact', () => {
  it('projects evaluated correct/incorrect and mapped unassessed without inventing mastery facts', () => {
    const artifact = buildObservations();

    expect(artifact).toMatchObject({
      observationCount: 3,
      evaluatedCount: 2,
      correctCount: 1,
      incorrectCount: 1,
      unassessedCount: 1,
    });
    expect(artifact.observations.map((observation) => observation.assessmentStatus).sort()).toEqual(
      ['evaluated', 'evaluated', 'unassessed'],
    );
    expect(
      new Set(artifact.observations.map((observation) => observation.occasionId)),
    ).toHaveLength(1);
    expect(
      new Set(artifact.observations.map((observation) => observation.observationId)),
    ).toHaveLength(3);
    const serialized = serializeConfirmedExamObservationsArtifact(artifact).toString('utf8');
    expect(serialized).not.toMatch(
      /studentAttemptedBeforeHelp|hintsUsed|usedKeyHint|viewedFullAnswer|attemptKind|independent|mastery|errorType|score|questionText|rawAnswerText/iu,
    );
  });

  it('omits explicitly unmapped questions rather than inventing an unknown knowledge id', () => {
    const source = sources();
    const mapping = buildMapping(source, mappingRequest(source.review, 'unmapped'));
    const artifact = buildObservations(source, mapping);

    expect(artifact.observationCount).toBe(2);
    expect(
      artifact.observations.some(
        (observation) => observation.confirmedQuestionId === questionId(source.review, '3'),
      ),
    ).toBe(false);
    expect(JSON.stringify(artifact.observations)).not.toContain('"unknown"');
  });

  it('is deterministic, canonical, source-bound, and rejects forged outcome or observation ids', () => {
    const source = sources();
    const mapping = buildMapping(source);
    const first = buildObservations(source, mapping);
    const second = buildObservations(source, mapping);
    expect(second).toEqual(first);
    expect(
      parseConfirmedExamObservationsArtifact(serializeConfirmedExamObservationsArtifact(first)),
    ).toEqual(first);

    const forgedOutcome = structuredClone(first);
    const evaluated = forgedOutcome.observations.find(
      (observation) => observation.assessmentStatus === 'evaluated',
    );
    if (evaluated?.assessmentStatus !== 'evaluated') throw new Error('fixture mismatch');
    evaluated.outcome = evaluated.outcome === 'correct' ? 'incorrect' : 'correct';
    expect(validateConfirmedExamObservationsArtifact(forgedOutcome).valid).toBe(false);

    const forgedId = structuredClone(first);
    forgedId.observations[0]!.observationId = 'exam-observation:v1:forged';
    expect(validateConfirmedExamObservationsArtifact(forgedId).valid).toBe(false);

    const changedSource = structuredClone(first);
    changedSource.sourceMapping.semanticFingerprint = '0'.repeat(64);
    expect(validateConfirmedExamObservationsArtifact(changedSource).valid).toBe(false);
  });

  it('rechecks full confirmed-question coverage before projecting observations', () => {
    const source = sources();
    const mapping = structuredClone(buildMapping(source));
    mapping.entries.pop();
    mapping.entryCount = mapping.entries.length;
    mapping.mappedQuestionCount = mapping.entries.filter(
      (entry) => entry.decision === 'mapped',
    ).length;
    mapping.unmappedQuestionCount = mapping.entryCount - mapping.mappedQuestionCount;
    const incomplete = refingerprintMapping(mapping);

    expect(validateConfirmedExamKnowledgeMappingArtifact(incomplete)).toEqual({ valid: true });
    expect(() => buildObservations(source, incomplete)).toThrowError(
      expect.objectContaining({ code: 'EXAM_OBSERVATION_SOURCE_INVALID' }),
    );
  });

  it('rejects a re-fingerprinted observation artifact with a cross-partition mapping source', () => {
    const artifact = structuredClone(buildObservations());
    artifact.sourceMapping.mappingRef = 'exam-knowledge-mapping:v1:cross-partition';
    const refingerprinted = refingerprintObservations(artifact);

    expect(validateConfirmedExamObservationsArtifact(refingerprinted).valid).toBe(false);
    expect(() => parseConfirmedExamObservationsArtifact(refingerprinted)).toThrowError(
      expect.objectContaining({ code: 'EXAM_OBSERVATION_ARTIFACT_CORRUPT' }),
    );
  });

  it('fails closed on invalid UTF-8 and non-canonical artifact bytes', () => {
    expect(() => parseConfirmedExamObservationsArtifact(new Uint8Array([0xc3, 0x28]))).toThrowError(
      expect.objectContaining({ code: 'EXAM_OBSERVATION_ARTIFACT_CORRUPT' }),
    );
    const mapping = buildMapping();
    const bytes = Buffer.from(
      JSON.stringify({ ...mapping, entries: [...mapping.entries].reverse() }),
      'utf8',
    );
    expect(() => parseConfirmedExamKnowledgeMappingArtifact(bytes)).toThrowError(
      expect.objectContaining({ code: 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT' }),
    );
  });
});

it('uses closed private errors without carrying source text', () => {
  const error = new ExamKnowledgeMappingPrivateError('EXAM_OBSERVATION_SOURCE_INVALID');
  expect(error.message).toBe('EXAM_OBSERVATION_SOURCE_INVALID');
});
