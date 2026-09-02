import { describe, expect, it } from 'vitest';

import {
  assertPortableMaterialObjectKey,
  examAuthoritativeAnswerKeyObjectKey,
  examDocumentArtifactObjectKey,
  examHumanReviewObjectKey,
  examKnowledgeMappingObjectKey,
  examObservationsObjectKey,
  examQuestionCandidatesObjectKey,
  examQuestionAssessmentsObjectKey,
  examSnapshotObjectKey,
  examSnapshotObjectPrefix,
  examQuestionResponseMatchesObjectKey,
  examStudentResponseCandidatesObjectKey,
  isExamSnapshotObjectKey,
  isLegacySessionMaterialObjectKey,
  isSessionMaterialObjectKey,
  ownerMaterialObjectKey,
  safeMaterialStorageNamespace,
  sessionMaterialObjectKey,
} from '@/lib/server/materials/object-keys';

describe('material object key contract', () => {
  it('derives a stable domain-separated SHA-256 owner namespace', () => {
    expect(safeMaterialStorageNamespace('owner', 'anon:00000000-0000-4000-8000-000000000001')).toBe(
      'own_16f88273bc58605c2b7319fd6f009b66577da9c533fdc0f85c970b13e8f258db',
    );
    expect(safeMaterialStorageNamespace('owner', 'same')).not.toBe(
      safeMaterialStorageNamespace('session', 'same'),
    );
  });

  it('is deterministic and uses the same portable result on Windows and Linux', () => {
    const first = ownerMaterialObjectKey('anon:abc', 'mat_alpha');
    const second = ownerMaterialObjectKey('anon:abc', 'mat_alpha');
    expect(first).toBe(second);
    expect(first).toMatch(/^materials\/v1\/owners\/own_[a-f0-9]{64}\/mat_[a-f0-9]{64}\/raw$/);
    expect(first).not.toMatch(/[\\:<>'"|?*]/);
    expect(() => assertPortableMaterialObjectKey(first)).not.toThrow();
  });

  it('separates different owners without disclosing either owner or material id', () => {
    const first = ownerMaterialObjectKey('owner-a', 'mat_shared');
    const second = ownerMaterialObjectKey('owner-b', 'mat_shared');
    expect(first).not.toBe(second);
    expect(first).not.toContain('owner-a');
    expect(first).not.toContain('mat_shared');
  });

  it('derives a deterministic isolated Exam snapshot namespace without disclosing ids', () => {
    const first = examSnapshotObjectKey('exam-session-alpha', 'exam-document-question-paper');
    const replay = examSnapshotObjectKey('exam-session-alpha', 'exam-document-question-paper');
    const otherDocument = examSnapshotObjectKey(
      'exam-session-alpha',
      'exam-document-student-response',
    );
    const otherExam = examSnapshotObjectKey('exam-session-beta', 'exam-document-question-paper');

    expect(first).toBe(replay);
    expect(first).toMatch(/^materials\/v1\/exams\/exm_[a-f0-9]{64}\/doc_[a-f0-9]{64}\/raw$/);
    expect(first.startsWith(examSnapshotObjectPrefix('exam-session-alpha'))).toBe(true);
    expect(first).not.toBe(otherDocument);
    expect(first).not.toBe(otherExam);
    expect(first).not.toContain('exam-session-alpha');
    expect(first).not.toContain('exam-document-question-paper');
    expect(() => assertPortableMaterialObjectKey(first)).not.toThrow();
  });

  it('derives versioned Exam-owned extraction artifacts inside the document namespace', () => {
    const documentArtifact = examDocumentArtifactObjectKey('exam-alpha', 'document-alpha', 1);
    const candidates = examQuestionCandidatesObjectKey('exam-alpha', 'document-alpha', 1, 1);

    expect(documentArtifact).toMatch(
      /^materials\/v1\/exams\/exm_[a-f0-9]{64}\/doc_[a-f0-9]{64}\/extraction_v1\/document_artifact_v1\.json$/,
    );
    expect(candidates).toMatch(
      /^materials\/v1\/exams\/exm_[a-f0-9]{64}\/doc_[a-f0-9]{64}\/extraction_v1\/question_candidates_v1\.json$/,
    );
    expect(documentArtifact).not.toContain('exam-alpha');
    expect(candidates).not.toContain('document-alpha');
    expect(isExamSnapshotObjectKey('exam-alpha', documentArtifact)).toBe(true);
    expect(isExamSnapshotObjectKey('exam-alpha', candidates)).toBe(true);
    expect(() => assertPortableMaterialObjectKey(documentArtifact)).not.toThrow();
    expect(() => assertPortableMaterialObjectKey(candidates)).not.toThrow();
  });

  it('derives response artifacts in an Exam-owned namespace independent of uploaded documents', () => {
    const responses = examStudentResponseCandidatesObjectKey('exam-alpha', 1);
    const matching = examQuestionResponseMatchesObjectKey('exam-alpha', 1, 1);

    expect(responses).toMatch(
      /^materials\/v1\/exams\/exm_[a-f0-9]{64}\/response_capture_v1\/student_response_candidates_v1\.json$/,
    );
    expect(matching).toMatch(
      /^materials\/v1\/exams\/exm_[a-f0-9]{64}\/response_capture_v1\/question_response_matches_v1\.json$/,
    );
    expect(responses).not.toContain('exam-alpha');
    expect(matching).not.toContain('exam-alpha');
    expect(isExamSnapshotObjectKey('exam-alpha', responses)).toBe(true);
    expect(isExamSnapshotObjectKey('exam-alpha', matching)).toBe(true);
    expect(isExamSnapshotObjectKey('exam-beta', responses)).toBe(false);
    expect(() => assertPortableMaterialObjectKey(responses)).not.toThrow();
    expect(() => assertPortableMaterialObjectKey(matching)).not.toThrow();
  });

  it('derives versioned human-review facts under the exact Exam response lineage', () => {
    const review = examHumanReviewObjectKey('exam-alpha', 1, 2, 3);
    expect(review).toMatch(
      /^materials\/v1\/exams\/exm_[a-f0-9]{64}\/response_capture_v1\/matching_v2\/human_review_v3\/confirmed_review_facts_v1\.json$/,
    );
    expect(review).toBe(examHumanReviewObjectKey('exam-alpha', 1, 2, 3));
    expect(review).not.toBe(examHumanReviewObjectKey('exam-alpha', 1, 2, 4));
    expect(review).not.toBe(examHumanReviewObjectKey('exam-beta', 1, 2, 3));
    expect(review).not.toContain('exam-alpha');
    expect(isExamSnapshotObjectKey('exam-alpha', review)).toBe(true);
    expect(isExamSnapshotObjectKey('exam-beta', review)).toBe(false);
    expect(() => assertPortableMaterialObjectKey(review)).not.toThrow();
  });

  it('derives private answer-key and assessment artifacts inside one Exam namespace', () => {
    const answerKey = examAuthoritativeAnswerKeyObjectKey('exam-alpha', 1);
    const assessments = examQuestionAssessmentsObjectKey('exam-alpha', 1);

    expect(answerKey).toMatch(
      /^materials\/v1\/exams\/exm_[a-f0-9]{64}\/grading\/answer_key_v1\/authoritative_answer_key_v1\.json$/,
    );
    expect(assessments).toMatch(
      /^materials\/v1\/exams\/exm_[a-f0-9]{64}\/grading\/grading_v1\/exam_question_assessments_v1\.json$/,
    );
    expect(answerKey).toBe(examAuthoritativeAnswerKeyObjectKey('exam-alpha', 1));
    expect(assessments).toBe(examQuestionAssessmentsObjectKey('exam-alpha', 1));
    expect(answerKey).not.toBe(examAuthoritativeAnswerKeyObjectKey('exam-beta', 1));
    expect(assessments).not.toBe(examQuestionAssessmentsObjectKey('exam-beta', 1));
    for (const key of [answerKey, assessments]) {
      expect(key).not.toContain('exam-alpha');
      expect(isExamSnapshotObjectKey('exam-alpha', key)).toBe(true);
      expect(isExamSnapshotObjectKey('exam-beta', key)).toBe(false);
      expect(() => assertPortableMaterialObjectKey(key)).not.toThrow();
    }
  });

  it('derives private mapping and observation artifacts inside one Exam namespace', () => {
    const mapping = examKnowledgeMappingObjectKey('exam-alpha', 1);
    const observations = examObservationsObjectKey('exam-alpha', 1, 1);

    expect(mapping).toMatch(
      /^materials\/v1\/exams\/exm_[a-f0-9]{64}\/knowledge\/mapping_v1\/confirmed_exam_knowledge_mapping_v1\.json$/,
    );
    expect(observations).toMatch(
      /^materials\/v1\/exams\/exm_[a-f0-9]{64}\/knowledge\/mapping_v1\/observations_v1\/confirmed_exam_observations_v1\.json$/,
    );
    expect(mapping).toBe(examKnowledgeMappingObjectKey('exam-alpha', 1));
    expect(observations).toBe(examObservationsObjectKey('exam-alpha', 1, 1));
    expect(mapping).not.toBe(examKnowledgeMappingObjectKey('exam-beta', 1));
    expect(observations).not.toBe(examObservationsObjectKey('exam-beta', 1, 1));
    for (const key of [mapping, observations]) {
      expect(key).not.toContain('exam-alpha');
      expect(isExamSnapshotObjectKey('exam-alpha', key)).toBe(true);
      expect(isExamSnapshotObjectKey('exam-beta', key)).toBe(false);
      expect(() => assertPortableMaterialObjectKey(key)).not.toThrow();
    }
  });

  it('rejects invalid Exam derivative versions', () => {
    expect(() => examDocumentArtifactObjectKey('exam', 'document', 0)).toThrow(
      'invalid exam artifact version',
    );
    expect(() => examQuestionCandidatesObjectKey('exam', 'document', 1, Number.NaN)).toThrow(
      'invalid exam artifact version',
    );
    expect(() => examStudentResponseCandidatesObjectKey('exam', 0)).toThrow(
      'invalid exam artifact version',
    );
    expect(() => examQuestionResponseMatchesObjectKey('exam', 1, Number.NaN)).toThrow(
      'invalid exam artifact version',
    );
    expect(() => examHumanReviewObjectKey('exam', 1, 1, 0)).toThrow(
      'invalid exam artifact version',
    );
    expect(() => examHumanReviewObjectKey('exam', 1, Number.NaN, 1)).toThrow(
      'invalid exam artifact version',
    );
    expect(() => examAuthoritativeAnswerKeyObjectKey('exam', 0)).toThrow(
      'invalid exam artifact version',
    );
    expect(() => examQuestionAssessmentsObjectKey('exam', Number.NaN)).toThrow(
      'invalid exam artifact version',
    );
    expect(() => examKnowledgeMappingObjectKey('exam', 0)).toThrow('invalid exam artifact version');
    expect(() => examObservationsObjectKey('exam', 1, Number.NaN)).toThrow(
      'invalid exam artifact version',
    );
  });

  it.each(['../outside', 'exam/../../outside', 'exam\\outside', 'CON', 'trailing.'])(
    'contains malicious Exam identities inside portable hashed namespaces: %s',
    (identity) => {
      const keys = [
        examSnapshotObjectKey(identity, identity),
        examKnowledgeMappingObjectKey(identity, 1),
        examObservationsObjectKey(identity, 1, 1),
      ];
      for (const key of keys) {
        expect(() => assertPortableMaterialObjectKey(key)).not.toThrow();
        expect(isExamSnapshotObjectKey(identity, key)).toBe(true);
        expect(key).not.toContain(identity);
        expect(key).not.toMatch(/[\\:<>'"|?*]/);
      }
    },
  );

  it('rejects cross-Exam keys and traversal hidden behind a canonical Exam prefix', () => {
    const first = examSnapshotObjectKey('exam-a', 'document-a');
    const foreign = examSnapshotObjectKey('exam-b', 'document-a');
    const traversal = first.replace(/\/[^/]+\/raw$/, '/../foreign/raw');

    expect(isExamSnapshotObjectKey('exam-a', first)).toBe(true);
    expect(isExamSnapshotObjectKey('exam-a', foreign)).toBe(false);
    expect(traversal).toContain('/../');
    expect(isExamSnapshotObjectKey('exam-a', traversal)).toBe(false);
  });

  it.each([
    'anon:00000000-0000-4000-8000-000000000001',
    '../outside',
    'owner/../../outside',
    'owner\\outside',
  ])('contains malicious owner input inside one safe namespace: %s', (ownerId) => {
    const key = ownerMaterialObjectKey(ownerId, 'mat_alpha');
    expect(() => assertPortableMaterialObjectKey(key)).not.toThrow();
    expect(key).not.toContain(ownerId);
  });

  it('hashes session and material identities and enforces the session prefix guard', () => {
    const key = sessionMaterialObjectKey(
      'session/../../foreign',
      'mat/../../foreign',
      'raw.YXBwbGljYXRpb24vcGRm',
    );
    expect(() => assertPortableMaterialObjectKey(key)).not.toThrow();
    expect(isSessionMaterialObjectKey('session/../../foreign', key)).toBe(true);
    expect(isSessionMaterialObjectKey('session-other', key)).toBe(false);
    expect(key).not.toContain('session/');
  });

  it('rejects traversal hidden behind an otherwise valid canonical session prefix', () => {
    const key = sessionMaterialObjectKey('session-a', 'mat-a', 'raw.bin');
    const traversal = key.replace(/\/[^/]+\/raw\.bin$/, '/../other-session/raw.bin');
    expect(traversal).toContain('/../');
    expect(isSessionMaterialObjectKey('session-a', traversal)).toBe(false);
  });

  it('permits legacy reads only for portable pre-v1 session segments', () => {
    expect(isLegacySessionMaterialObjectKey('session-1', 'materials/session-1/mat_1/raw.bin')).toBe(
      true,
    );
    expect(
      isLegacySessionMaterialObjectKey('../session', 'materials/../session/mat_1/raw.bin'),
    ).toBe(false);
    expect(
      isLegacySessionMaterialObjectKey('session/other', 'materials/session/other/mat_1/raw.bin'),
    ).toBe(false);
    expect(
      isLegacySessionMaterialObjectKey(
        'session-1',
        'materials/session-1/../session-2/mat_1/raw.bin',
      ),
    ).toBe(false);
    expect(isLegacySessionMaterialObjectKey('session.', 'materials/session./mat_1/raw.bin')).toBe(
      false,
    );
  });

  it.each([
    '../outside',
    'materials/anon:owner/mat',
    'materials/owner\\outside/mat',
    'materials/CON/file',
    'materials/trailing./file',
  ])('rejects non-portable direct object keys: %s', (key) => {
    expect(() => assertPortableMaterialObjectKey(key)).toThrow('invalid material object key');
  });
});
