import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  segmentExamQuestionCandidates,
  serializeExamQuestionCandidatesArtifact,
  type ExamQuestionCandidatesArtifactV1,
} from '@/lib/zhongkao/exam-question-candidate';
import {
  buildExamQuestionResponseMatchesArtifact,
  buildStudentResponseCandidatesArtifact,
  parseExamQuestionResponseMatchesArtifact,
  parseExamStudentResponseCaptureRequest,
  parseStudentResponseCandidatesArtifact,
  serializeExamQuestionResponseMatchesArtifact,
  serializeStudentResponseCandidatesArtifact,
  validateExamQuestionResponseMatchesArtifact,
  validateExamStudentResponseCaptureRequest,
  validateStudentResponseCandidatesArtifact,
  type StudentResponseCandidatesArtifactV1,
} from '@/lib/zhongkao/exam-student-response';

const EXAM_SESSION_ID = 'exam-response-fixture';
const QUESTION_ARTIFACT_REF = 'exam-question-candidates:v1:fixture';
const CAPTURE_REF = 'exam-student-response-capture:v1:fixture';
const RESPONSE_ARTIFACT_REF = 'exam-student-response-candidates:v1:fixture';
const MATCHING_ARTIFACT_REF = 'exam-question-response-matches:v1:fixture';

function questionArtifact(text: string): ExamQuestionCandidatesArtifactV1 {
  return segmentExamQuestionCandidates({
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
      pages: [{ pageNumber: 1, blocks: [{ blockIndex: 0, kind: 'text', text }] }],
    },
  });
}

function questionSha256(artifact: ExamQuestionCandidatesArtifactV1): string {
  return createHash('sha256')
    .update(serializeExamQuestionCandidatesArtifact(artifact))
    .digest('hex');
}

function responses(
  text: string,
  questions: ExamQuestionCandidatesArtifactV1,
): StudentResponseCandidatesArtifactV1 {
  return buildStudentResponseCandidatesArtifact({
    examSessionId: EXAM_SESSION_ID,
    captureVersion: 1,
    captureRef: CAPTURE_REF,
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    questionCandidateArtifactRef: QUESTION_ARTIFACT_REF,
    questionCandidateArtifactSha256: questionSha256(questions),
    questionSegmentationVersion: questions.segmentationVersion,
    request: { format: 'numbered_text_v1', text },
  });
}

function matches(
  questions: ExamQuestionCandidatesArtifactV1,
  responseArtifact: StudentResponseCandidatesArtifactV1,
) {
  return buildExamQuestionResponseMatchesArtifact({
    examSessionId: EXAM_SESSION_ID,
    matchingArtifactRef: MATCHING_ARTIFACT_REF,
    questionCandidateArtifactRef: QUESTION_ARTIFACT_REF,
    questionCandidateArtifactSha256: questionSha256(questions),
    responseArtifactRef: RESPONSE_ARTIFACT_REF,
    questionCandidatesArtifact: questions,
    responseCandidatesArtifact: responseArtifact,
  });
}

describe('student response capture', () => {
  it('parses only the closed numbered_text_v1 request', () => {
    const request = { format: 'numbered_text_v1', text: '1=A' } as const;
    expect(parseExamStudentResponseCaptureRequest(request)).toEqual(request);
    expect(validateExamStudentResponseCaptureRequest({ ...request, extra: true }).valid).toBe(
      false,
    );
    expect(validateExamStudentResponseCaptureRequest({ format: 'other', text: '1=A' }).valid).toBe(
      false,
    );
  });

  it('splits on the first equals sign, preserves answer bytes, and projects blank status', () => {
    const questions = questionArtifact('一、选择题\n1. first\n2. second\n17(1) child');
    const artifact = responses(
      ['一、选择题', '2= A=B ', '１=   ', '17（1）=x'].join('\n'),
      questions,
    );

    expect(artifact.candidates.map((candidate) => candidate.locator.printedNumber)).toEqual([
      '1',
      '2',
      '17',
    ]);
    expect(artifact.candidates[0]).toMatchObject({
      rawLabel: '１',
      rawAnswerText: '   ',
      answerStatus: 'blank',
      locator: {
        sectionPath: [{ normalizedId: 'section:1', rawLabel: '一、选择题' }],
      },
    });
    expect(artifact.candidates[1]).toMatchObject({
      rawAnswerText: ' A=B ',
      answerStatus: 'text',
    });
  });

  it('rejects Unicode line separators instead of treating them as answer text', () => {
    const questions = questionArtifact('1. question');
    for (const separator of ['\u0085', '\u2028', '\u2029']) {
      expect(() => responses(`1=A${separator}2=B`, questions)).toThrow(
        'EXAM_STUDENT_RESPONSE_INPUT_INVALID',
      );
    }
  });

  it('canonically orders duplicate facts before assigning ordinals', () => {
    const questions = questionArtifact('1. question\n2. question');
    const first = responses('2=z\n1=x\n2=a', questions);
    const reordered = responses('\n2=a\n2=z\n1=x\n', questions);

    expect(serializeStudentResponseCandidatesArtifact(reordered)).toEqual(
      serializeStudentResponseCandidatesArtifact(first),
    );
    expect(reordered.inputSemanticFingerprint).toBe(first.inputSemanticFingerprint);
    expect(first.candidates.map((candidate) => candidate.rawAnswerText)).toEqual(['x', 'a', 'z']);
    expect(first.candidates.map((candidate) => candidate.ordinalDiscriminator)).toEqual([1, 1, 2]);
    expect(validateStudentResponseCandidatesArtifact(first)).toEqual({ valid: true });
    expect(
      parseStudentResponseCandidatesArtifact(serializeStudentResponseCandidatesArtifact(first)),
    ).toEqual(first);
  });
});

describe('question and response matching', () => {
  it('matches a sectionless response across the Exam only when the leaf is unique', () => {
    const questions = questionArtifact('一、选择题\n1. first\n二、填空题\n2. second');
    const artifact = matches(questions, responses('1=A\n9=missing', questions));

    expect(artifact.matches.map((match) => match.status)).toEqual(['matched', 'unmatched']);
    expect(artifact.needsReview).toBe(true);
  });

  it('marks cross-section duplicates and top-level group children ambiguous', () => {
    const duplicateQuestions = questionArtifact('一、选择题\n1. first\n二、填空题\n1. second');
    const duplicateMatch = matches(duplicateQuestions, responses('1=A', duplicateQuestions));
    expect(duplicateMatch.matches[0]).toMatchObject({
      status: 'ambiguous',
      reasonCodes: ['duplicate_question_locator'],
    });

    const groupedQuestions = questionArtifact('三、解答题\n17. stem\n(1) first\n(2) second');
    const groupedMatch = matches(
      groupedQuestions,
      responses('17=whole\n17(1)=leaf', groupedQuestions),
    );
    expect(groupedMatch.matches.map((match) => match.status)).toEqual(['ambiguous', 'matched']);
    expect(groupedMatch.matches[0]!.reasonCodes).toEqual(['group_has_subquestions']);
  });

  it('marks every duplicate response ambiguous and round-trips the closed match artifact', () => {
    const questions = questionArtifact('1. only question');
    const artifact = matches(questions, responses('1=B\n1=A', questions));

    expect(artifact.matches).toHaveLength(2);
    expect(artifact.matches.every((match) => match.status === 'ambiguous')).toBe(true);
    expect(
      artifact.matches.every((match) => match.reasonCodes.includes('duplicate_response_locator')),
    ).toBe(true);
    expect(validateExamQuestionResponseMatchesArtifact(artifact)).toEqual({ valid: true });
    expect(
      parseExamQuestionResponseMatchesArtifact(
        serializeExamQuestionResponseMatchesArtifact(artifact),
      ),
    ).toEqual(artifact);

    const ambiguousWithoutCandidate = structuredClone(artifact);
    ambiguousWithoutCandidate.matches[0]!.questionCandidateIds = [];
    expect(validateExamQuestionResponseMatchesArtifact(ambiguousWithoutCandidate).valid).toBe(
      false,
    );

    const tooManyCandidateIds = structuredClone(artifact);
    tooManyCandidateIds.matches[0]!.questionCandidateIds = Array.from(
      { length: 501 },
      (_, index) => `question-candidate-${index.toString().padStart(3, '0')}`,
    );
    expect(validateExamQuestionResponseMatchesArtifact(tooManyCandidateIds).valid).toBe(false);
  });

  it('keeps duplicate response locators unmatched when no question candidate exists', () => {
    const questions = questionArtifact('1. only question');
    const artifact = matches(questions, responses('99=A\n99=B', questions));

    expect(artifact.matches).toHaveLength(2);
    expect(artifact.matches.every((match) => match.status === 'unmatched')).toBe(true);
    expect(artifact.matches.every((match) => match.questionCandidateIds.length === 0)).toBe(true);
    expect(artifact.matches.every((match) => match.reasonCodes.length === 0)).toBe(true);
  });

  it('rejects a response artifact bound to a different question artifact hash', () => {
    const questions = questionArtifact('1. only question');
    const responseArtifact = responses('1=A', questions);
    expect(() =>
      buildExamQuestionResponseMatchesArtifact({
        examSessionId: EXAM_SESSION_ID,
        matchingArtifactRef: MATCHING_ARTIFACT_REF,
        questionCandidateArtifactRef: QUESTION_ARTIFACT_REF,
        questionCandidateArtifactSha256: 'f'.repeat(64),
        responseArtifactRef: RESPONSE_ARTIFACT_REF,
        questionCandidatesArtifact: questions,
        responseCandidatesArtifact: responseArtifact,
      }),
    ).toThrow('EXAM_QUESTION_RESPONSE_MATCHING_FAILED');
  });
});
