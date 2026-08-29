import type { AICallFn } from '@openmaic/generation';
import { describe, expect, it, vi } from 'vitest';

import {
  TRANSFER_QUESTION_GENERATION_ATTEMPTS,
  assessTransferQuestionSimilarity,
  generateVerifiedTransferQuestion,
  transferQuestionPassesCurriculumPolicy,
} from '@/lib/server/zhongkao/transfer-question-generation';
import {
  validateTransferQuestionCandidate,
  type TransferQuestionCandidate,
} from '@/lib/server/zhongkao/transfer-question-private';

const INPUT = {
  transferQuestionId: 'transfer-question-1',
  subjectId: 'math',
  originalQuestion: { question: '解方程 2x = 8。' },
  allowedKnowledgePointIds: ['linear-equations'],
  curriculumMode: 'generic' as const,
};

function single(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: 'single_choice',
    question: '若 3x = 12，x 等于多少？',
    options: [
      { id: 'A', text: '2' },
      { id: 'B', text: '3' },
      { id: 'C', text: '4' },
    ],
    expectedAnswer: { correctOptionId: 'C' },
    knowledgePointIds: ['linear-equations'],
    difficulty: 'same',
    claims: [],
    ...overrides,
  };
}

function acceptedVerification(overrides: Record<string, boolean> = {}) {
  return {
    schemaVersion: 1,
    verdict: 'accept',
    checks: {
      sameKnowledgePoint: true,
      selfContained: true,
      answerConsistent: true,
      answerNotLeaked: true,
      singleAnswerOrExactSet: true,
      middleSchoolScope: true,
      meaningfullyDifferent: true,
      ...overrides,
    },
  };
}

function responses(...values: unknown[]): AICallFn {
  const queue = values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value)));
  return vi.fn(async () => queue.shift() ?? queue.at(-1)!);
}

function candidate(value: unknown): TransferQuestionCandidate {
  const result = validateTransferQuestionCandidate(value, {
    allowedKnowledgePointIds: ['linear-equations'],
  });
  if (!result.ok) throw new Error(`invalid fixture: ${result.reason}`);
  return result.candidate;
}

describe('transfer question deterministic policy and similarity', () => {
  it('rejects an exact copy after Unicode/spacing/punctuation normalization', () => {
    const copied = candidate(single({ question: '若 3x = 12 x 等于多少' }));
    expect(
      assessTransferQuestionSimilarity({ question: ' 若 3x = 12，x 等于多少？ ' }, copied),
    ).toMatchObject({ allowed: false, reason: 'EXACT_DUPLICATE' });
  });

  it('rejects a choice question whose only change is option order', () => {
    const copied = candidate(
      single({
        options: [
          { id: 'C2', text: '4' },
          { id: 'A2', text: '2' },
          { id: 'B2', text: '3' },
        ],
        expectedAnswer: { correctOptionId: 'C2' },
      }),
    );
    expect(
      assessTransferQuestionSimilarity(
        {
          question: '若 3x = 12，x 等于多少？',
          options: [
            { id: 'A', text: '2' },
            { id: 'B', text: '3' },
            { id: 'C', text: '4' },
          ],
        },
        copied,
      ),
    ).toMatchObject({ allowed: false, reason: 'CHOICE_REORDER_DUPLICATE' });
  });

  it('rejects option reordering when the original options are embedded in raw text', () => {
    const copied = candidate(
      single({
        question: '若 3x = 12，x 等于多少？',
        options: [
          { id: 'first', text: '4' },
          { id: 'second', text: '2' },
          { id: 'third', text: '3' },
        ],
        expectedAnswer: { correctOptionId: 'first' },
      }),
    );
    expect(
      assessTransferQuestionSimilarity(
        { question: '若 3x = 12，x 等于多少？\nA. 2\nB. 3\nC. 4' },
        copied,
      ),
    ).toMatchObject({ allowed: false, reason: 'CHOICE_REORDER_DUPLICATE' });
  });

  it('allows an obviously different question to proceed to the verifier', () => {
    expect(
      assessTransferQuestionSimilarity(INPUT.originalQuestion, candidate(single())),
    ).toMatchObject({ allowed: true });
  });

  it('rejects synthetic-source, generic curriculum, and answer-leak text', () => {
    for (const question of [
      '根据人教版第88页，若 3x = 12，x 等于多少？',
      '这是某市中考真题：若 3x = 12，x 等于多少？',
      '正确答案是 C，请选择。',
      '正确选项为 B，请说明理由。',
      '这是 2025 年北京中考第 12 题。',
      '本题选自2025年北京市初中学业水平考试第12题。',
      'B 是正确选项。',
      '选项 B 正确。',
      'B is the correct option.',
    ]) {
      expect(
        transferQuestionPassesCurriculumPolicy(candidate(single({ question })), 'generic'),
      ).toBe(false);
    }
  });

  it('permits only an optional generic knowledge-point claim for synthetic questions', () => {
    expect(transferQuestionPassesCurriculumPolicy(candidate(single()), 'generic')).toBe(true);
    expect(
      transferQuestionPassesCurriculumPolicy(
        candidate(single({ claims: [{ type: 'generic_knowledge_point' }] })),
        'generic',
      ),
    ).toBe(true);
    expect(
      transferQuestionPassesCurriculumPolicy(
        candidate(single({ claims: [{ type: 'source_attribution' }] })),
        'confirmed',
      ),
    ).toBe(false);
  });
});

describe('verified transfer question generation', () => {
  it('returns a server-verified public/private split after an independent verifier call', async () => {
    const generateCandidate = responses(single());
    const verifyCandidate = responses(acceptedVerification());
    const result = await generateVerifiedTransferQuestion(
      { generateCandidate, verifyCandidate },
      INPUT,
    );

    expect(result).toMatchObject({
      validationStatus: 'verified',
      validationRef: expect.stringMatching(/^transfer-validation:v1:[a-f0-9]{64}$/u),
      publicQuestion: {
        transferQuestionId: INPUT.transferQuestionId,
        type: 'single_choice',
        difficulty: 'same',
      },
      gradingSpec: {
        schemaVersion: 1,
        type: 'single_choice',
        correctOptionId: 'C',
      },
      verification: {
        schemaVersion: 1,
        status: 'verified',
        candidateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        verifierVersion: 1,
      },
    });
    expect(JSON.stringify(result.publicQuestion)).not.toMatch(/answer|grading|correct/iu);
    expect(generateCandidate).toHaveBeenCalledTimes(1);
    expect(verifyCandidate).toHaveBeenCalledTimes(1);
    expect(generateCandidate).not.toBe(verifyCandidate);
    expect(verifyCandidate).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(
        `authoritativeOriginalKnowledgePointIds: ${JSON.stringify(INPUT.allowedKnowledgePointIds)}`,
      ),
    );
    expect(verifyCandidate).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(
        'allowedQuestionTypes: ["single_choice","multiple_choice","numeric","exact_short_answer"]',
      ),
    );
  });

  it('publishes only server-remapped choice ids and keeps the remapped answer key private', async () => {
    const result = await generateVerifiedTransferQuestion(
      {
        generateCandidate: responses(
          single({
            options: [
              { id: 'correct-answer', text: '2' },
              { id: 'A', text: '3' },
              { id: 'last-choice', text: '4' },
            ],
            expectedAnswer: { correctOptionId: 'correct-answer' },
          }),
        ),
        verifyCandidate: responses(acceptedVerification()),
      },
      INPUT,
    );

    expect(result.publicQuestion).toMatchObject({
      options: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    });
    expect(result.gradingSpec).toMatchObject({
      optionIds: ['A', 'B', 'C'],
      correctOptionId: 'A',
    });
    expect(JSON.stringify(result.publicQuestion)).not.toContain('correct-answer');
  });

  it('supports numeric and exact-short private grading without leaking it publicly', async () => {
    for (const rawCandidate of [
      {
        ...single(),
        type: 'numeric',
        question: '若 5x = 15，写出 x 的数值。',
        expectedAnswer: { expectedNumericValue: 3 },
        options: undefined,
      },
      {
        ...single(),
        type: 'exact_short_answer',
        question: '英文单词 China 的中文是什么？',
        expectedAnswer: { acceptedAnswers: ['中国'] },
        options: undefined,
      },
    ]) {
      const clean = Object.fromEntries(
        Object.entries(rawCandidate).filter(([, value]) => value !== undefined),
      );
      const result = await generateVerifiedTransferQuestion(
        { generateCandidate: responses(clean), verifyCandidate: responses(acceptedVerification()) },
        INPUT,
      );
      expect(result.publicQuestion).not.toHaveProperty('expectedAnswer');
      expect(result.publicQuestion).not.toHaveProperty('options');
      expect(result.gradingSpec.type).toBe(clean.type);
    }
  });

  it('never lets a candidate self-assert verification and regenerates within one budget', async () => {
    const generateCandidate = responses({ ...single(), validationStatus: 'verified' }, single());
    const verifyCandidate = responses(acceptedVerification());
    await expect(
      generateVerifiedTransferQuestion({ generateCandidate, verifyCandidate }, INPUT),
    ).resolves.toMatchObject({ validationStatus: 'verified' });
    expect(generateCandidate).toHaveBeenCalledTimes(2);
    expect(verifyCandidate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unauthorized knowledge point', { ...single(), knowledgePointIds: ['quadratic-equations'] }],
    ['answer in question', single({ question: '正确答案是 C，请选择。' })],
    [
      'answer marker in option',
      single({
        options: [
          { id: 'A', text: '2（本项正确）' },
          { id: 'B', text: '3' },
          { id: 'C', text: '4' },
        ],
      }),
    ],
    [
      'exam source attribution',
      single({ question: '本题选自2025年北京市初中学业水平考试第12题。' }),
    ],
    ['inverted answer marker', single({ question: 'B is the correct option.' })],
    ['generic publisher claim', single({ question: '根据人教版第88页完成此题。' })],
    ['structural key mismatch', single({ expectedAnswer: { correctOptionId: 'missing' } })],
  ])('does not call the verifier for %s', async (_label, rejected) => {
    const generateCandidate = responses(rejected, single());
    const verifyCandidate = responses(acceptedVerification());
    await generateVerifiedTransferQuestion({ generateCandidate, verifyCandidate }, INPUT);
    expect(generateCandidate).toHaveBeenCalledTimes(2);
    expect(verifyCandidate).toHaveBeenCalledTimes(1);
  });

  it('requires verdict=accept and every verifier check=true', async () => {
    const generateCandidate = responses(single(), single({ question: '若 4x = 20，x 是多少？' }));
    const verifyCandidate = responses(
      acceptedVerification({ answerNotLeaked: false }),
      acceptedVerification(),
    );
    await expect(
      generateVerifiedTransferQuestion({ generateCandidate, verifyCandidate }, INPUT),
    ).resolves.toMatchObject({ publicQuestion: { question: '若 4x = 20，x 是多少？' } });
    expect(verifyCandidate).toHaveBeenCalledTimes(2);
  });

  it('treats verifier rationale, malformed output, and provider errors as bounded retry failures', async () => {
    const withRationale = { ...acceptedVerification(), rationale: 'hidden model reasoning' };
    for (const firstVerifier of [
      responses(withRationale, acceptedVerification()),
      responses('{not-json', acceptedVerification()),
      vi
        .fn<AICallFn>()
        .mockRejectedValueOnce(new Error('private provider detail'))
        .mockResolvedValueOnce(JSON.stringify(acceptedVerification())),
    ]) {
      const generateCandidate = responses(single(), single({ question: '若 4x = 20，x 是多少？' }));
      await expect(
        generateVerifiedTransferQuestion(
          { generateCandidate, verifyCandidate: firstVerifier },
          INPUT,
        ),
      ).resolves.toMatchObject({ validationStatus: 'verified' });
      expect(firstVerifier).toHaveBeenCalledTimes(2);
    }
  });

  it('returns stable exhaustion and unsupported-type errors without raw provider detail', async () => {
    const rejectedVerifier = responses(
      { ...acceptedVerification(), verdict: 'reject', reasonCode: 'ANSWER_INCONSISTENT' },
      { ...acceptedVerification(), verdict: 'reject', reasonCode: 'ANSWER_INCONSISTENT' },
    );
    await expect(
      generateVerifiedTransferQuestion(
        { generateCandidate: responses(single(), single()), verifyCandidate: rejectedVerifier },
        INPUT,
      ),
    ).rejects.toMatchObject({ code: 'TRANSFER_QUESTION_GENERATION_FAILED' });
    expect(rejectedVerifier).toHaveBeenCalledTimes(TRANSFER_QUESTION_GENERATION_ATTEMPTS);

    await expect(
      generateVerifiedTransferQuestion(
        {
          generateCandidate: responses(
            { ...single(), type: 'essay' },
            { ...single(), type: 'essay' },
          ),
          verifyCandidate: responses(acceptedVerification()),
        },
        INPUT,
      ),
    ).rejects.toMatchObject({ code: 'TRANSFER_QUESTION_TYPE_UNSUPPORTED' });
  });

  it('requires both generation capabilities and discards a late aborted result', async () => {
    await expect(
      generateVerifiedTransferQuestion({ generateCandidate: responses(single()) }, INPUT),
    ).rejects.toMatchObject({ code: 'COACH_GENERATION_UNAVAILABLE' });

    let resolveCandidate!: (value: string) => void;
    const candidateResult = new Promise<string>((resolve) => {
      resolveCandidate = resolve;
    });
    const generateCandidate = vi.fn<AICallFn>(async () => candidateResult);
    const controller = new AbortController();
    const pending = generateVerifiedTransferQuestion(
      { generateCandidate, verifyCandidate: responses(acceptedVerification()) },
      INPUT,
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(generateCandidate).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveCandidate(JSON.stringify(single()));
    await rejected;
  });

  it('keeps candidate identity deterministic across identical verified runs', async () => {
    const first = await generateVerifiedTransferQuestion(
      {
        generateCandidate: responses(single()),
        verifyCandidate: responses(acceptedVerification()),
      },
      INPUT,
    );
    const replay = await generateVerifiedTransferQuestion(
      {
        generateCandidate: responses(single()),
        verifyCandidate: responses(acceptedVerification()),
      },
      INPUT,
    );
    expect(replay.publicQuestion.transferQuestionId).toBe(first.publicQuestion.transferQuestionId);
    expect(replay.verification.candidateFingerprint).toBe(first.verification.candidateFingerprint);
    expect(replay.validationRef).toBe(first.validationRef);
  });
});
