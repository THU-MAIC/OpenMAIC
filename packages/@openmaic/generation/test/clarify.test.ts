// TDD RED: pre-outline ask_user clarification contracts for @openmaic/generation.
import { describe, expect, test, vi } from 'vitest';
import {
  MAX_CLARIFICATION_QUESTIONS,
  buildClarificationPrompt,
  buildClarificationQA,
  buildOutlinePrompt,
  formatClarificationQAForPrompt,
  generateClarificationQuestions,
  parseClarificationResponse,
  type AICallFn,
  type AskUserQuestion,
} from '@openmaic/generation';

describe('parseClarificationResponse', () => {
  test('returns no-clarification for an explicit proceed payload', () => {
    expect(
      parseClarificationResponse(JSON.stringify({ needsClarification: false, questions: [] })),
    ).toEqual({ needsClarification: false, questions: [] });
  });

  test('normalizes questions: assigns ids, coerces flags, caps at the maximum', () => {
    const questions = Array.from({ length: MAX_CLARIFICATION_QUESTIONS + 3 }, (_, i) => ({
      question: `Question ${i + 1}?`,
      options: [
        { id: 'a', label: 'Alpha' },
        { id: 'a', label: 'Duplicate id is dropped' },
        { id: '', label: 'Blank id is dropped' },
        { id: 'b', label: '' },
      ],
      multiSelect: i % 2 === 0 ? true : undefined,
    }));
    const parsed = parseClarificationResponse(
      JSON.stringify({ needsClarification: true, questions }),
    );

    expect(parsed?.needsClarification).toBe(true);
    expect(parsed?.questions).toHaveLength(MAX_CLARIFICATION_QUESTIONS);
    expect(parsed?.questions[0]).toMatchObject({
      id: 'q1',
      question: 'Question 1?',
      multiSelect: true,
      allowFreeText: false,
    });
    expect(parsed?.questions[0]?.options).toEqual([{ id: 'a', label: 'Alpha' }]);
  });

  test('drops questions with empty text and returns no-clarification when none survive', () => {
    expect(
      parseClarificationResponse(
        JSON.stringify({ needsClarification: true, questions: [{ question: '  ' }] }),
      ),
    ).toEqual({ needsClarification: false, questions: [] });
  });

  test('returns null for unparseable model output', () => {
    expect(parseClarificationResponse('not json at all {{{')).toBeNull();
  });
});

describe('buildClarificationPrompt', () => {
  test('embeds the requirement and the ask-vs-assume policy', () => {
    const prompts = buildClarificationPrompt(
      { requirement: 'Teach me physics' },
      { researchContext: 'Recent findings.' },
    );

    expect(prompts.system).toContain('clarif');
    expect(prompts.user).toContain('Teach me physics');
    expect(prompts.user).toContain('Recent findings.');
    expect(prompts.user).toContain('needsClarification');
  });
});

describe('generateClarificationQuestions', () => {
  test('returns questions from a valid clarify payload', async () => {
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify({
        needsClarification: true,
        questions: [
          {
            id: 'q1',
            question: 'Who is this course for?',
            options: [{ id: 'kids', label: 'Kids' }],
            allowFreeText: true,
          },
        ],
      }),
    );

    const result = await generateClarificationQuestions(
      { requirement: 'Teach photosynthesis' },
      aiCall,
    );

    expect(result.success).toBe(true);
    expect(result.data?.needsClarification).toBe(true);
    expect(result.data?.questions).toHaveLength(1);
    expect(aiCall).toHaveBeenCalledOnce();
  });

  test('fails loud on unparseable output so callers can fail open deliberately', async () => {
    const result = await generateClarificationQuestions(
      { requirement: 'Teach photosynthesis' },
      async () => 'garbage {{{',
    );

    expect(result.success).toBe(false);
  });
});

describe('clarification QA assembly', () => {
  const questions: AskUserQuestion[] = [
    {
      id: 'q1',
      question: 'Who is this course for?',
      options: [
        { id: 'kids', label: 'Kids' },
        { id: 'adults', label: 'Adults' },
      ],
      allowFreeText: true,
    },
  ];

  test('buildClarificationQA resolves option labels and appends free text', () => {
    expect(
      buildClarificationQA(questions, {
        q1: { optionIds: ['kids'], freeText: 'Age 8-10' },
      }),
    ).toEqual([{ question: 'Who is this course for?', answer: 'Kids; Age 8-10' }]);
  });

  test('buildClarificationQA skips unanswered questions', () => {
    expect(buildClarificationQA(questions, {})).toEqual([]);
  });

  test('formatClarificationQAForPrompt renders stable Q/A lines', () => {
    expect(
      formatClarificationQAForPrompt([{ question: 'Who is this course for?', answer: 'Kids' }]),
    ).toBe('Q1: Who is this course for?\nA1: Kids');
  });

  test('buildOutlinePrompt injects answered clarifications as authoritative context', () => {
    const withQA = buildOutlinePrompt(
      { requirement: 'Teach photosynthesis' },
      {
        clarificationQA: [{ question: 'Who is this course for?', answer: 'Kids' }],
      },
    );
    expect(withQA.user).toContain('## User Clarifications');
    expect(withQA.user).toContain('A1: Kids');

    const withoutQA = buildOutlinePrompt({ requirement: 'Teach photosynthesis' }, {});
    expect(withoutQA.user).not.toContain('User Clarifications');
  });
});
