import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXAM_KNOWLEDGE_CANDIDATE_POOL_MAX_IDS,
  ExamKnowledgeCandidatePoolError,
  buildExamKnowledgeCandidatePool,
  collectExamKnowledgeCandidatePool,
  parseExamKnowledgeCandidatePool,
  validateExamKnowledgeCandidatePool,
} from '@/lib/server/zhongkao/exam-knowledge-candidate-pool';
import { collectKnowledgeProgressEvidence } from '@/lib/server/zhongkao/progress-evidence-service';

vi.mock('@/lib/server/zhongkao/progress-evidence-service', () => ({
  collectKnowledgeProgressEvidence: vi.fn(),
}));

const collectEvidence = vi.mocked(collectKnowledgeProgressEvidence);

describe('Exam knowledge candidate pool', () => {
  beforeEach(() => {
    collectEvidence.mockReset();
  });

  it('uses label-only mode for a zero-history cold start', () => {
    const pool = buildExamKnowledgeCandidatePool({ subjectId: 'math', knowledgePointIds: [] });

    expect(pool).toMatchObject({
      schemaVersion: 1,
      poolVersion: 1,
      mode: 'label_only',
      subjectId: 'math',
      knowledgePointIds: [],
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(validateExamKnowledgeCandidatePool(pool)).toEqual({ valid: true });
  });

  it('deduplicates, sorts, and deterministically caps observed ids', () => {
    const source = Array.from(
      { length: 300 },
      (_, index) => `kp-${String(index).padStart(3, '0')}`,
    );
    const pool = buildExamKnowledgeCandidatePool({
      subjectId: 'math',
      knowledgePointIds: [...source].reverse().flatMap((id) => [id, id]),
    });

    expect(pool.mode).toBe('observed_existing_ids');
    expect(pool.knowledgePointIds).toHaveLength(EXAM_KNOWLEDGE_CANDIDATE_POOL_MAX_IDS);
    expect(pool.knowledgePointIds).toEqual(source.slice(0, 256));
    expect(
      buildExamKnowledgeCandidatePool({
        subjectId: 'math',
        knowledgePointIds: [...source, ...source].reverse(),
      }),
    ).toEqual(pool);
  });

  it('rejects noncanonical pools and fingerprint tampering', () => {
    const pool = buildExamKnowledgeCandidatePool({
      subjectId: 'math',
      knowledgePointIds: ['linear-equations', 'fractions'],
    });

    for (const mutated of [
      { ...pool, extra: true },
      { ...pool, mode: 'label_only' },
      { ...pool, knowledgePointIds: [...pool.knowledgePointIds].reverse() },
      { ...pool, fingerprint: '0'.repeat(64) },
    ]) {
      expect(validateExamKnowledgeCandidatePool(mutated).valid).toBe(false);
      expect(() => parseExamKnowledgeCandidatePool(mutated)).toThrowError(
        expect.objectContaining({ code: 'EXAM_KNOWLEDGE_CANDIDATE_POOL_INVALID' }),
      );
    }
  });

  it('collects only same-subject ids from StudyAttempt and confirmed Exam evidence', async () => {
    collectEvidence.mockResolvedValue({
      profileId: 'fictional-profile',
      studyAttemptCount: 2,
      examObservationCount: 2,
      activeExamCount: 1,
      evidence: [
        {
          sourceKind: 'study_attempt',
          attempt: {
            subjectId: 'math',
            knowledgePointIds: ['linear-equations', 'fractions'],
          },
        },
        {
          sourceKind: 'study_attempt',
          attempt: { subjectId: 'english', knowledgePointIds: ['grammar'] },
        },
        {
          sourceKind: 'exam_observation',
          observation: {
            subjectId: 'math',
            knowledgePointIds: ['geometry', 'fractions'],
            outcome: 'incorrect',
          },
        },
        {
          sourceKind: 'exam_observation',
          observation: {
            subjectId: 'physics',
            knowledgePointIds: ['motion'],
            outcome: 'correct',
          },
        },
      ],
    } as Awaited<ReturnType<typeof collectKnowledgeProgressEvidence>>);
    const deps = { ownerId: 'fictional-owner' } as never;

    await expect(
      collectExamKnowledgeCandidatePool(deps, 'fictional-profile', 'math'),
    ).resolves.toMatchObject({
      mode: 'observed_existing_ids',
      subjectId: 'math',
      knowledgePointIds: ['fractions', 'geometry', 'linear-equations'],
    });
    expect(collectEvidence).toHaveBeenCalledWith(deps, 'fictional-profile');
  });

  it('maps authoritative collection failure to a closed pool error', async () => {
    collectEvidence.mockRejectedValue(new Error('private storage detail'));

    await expect(
      collectExamKnowledgeCandidatePool({} as never, 'fictional-profile', 'math'),
    ).rejects.toEqual(
      new ExamKnowledgeCandidatePoolError('EXAM_KNOWLEDGE_CANDIDATE_POOL_EVIDENCE_FAILED'),
    );
  });
});
