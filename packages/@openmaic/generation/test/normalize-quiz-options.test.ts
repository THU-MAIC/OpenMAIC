import { describe, expect, it } from 'vitest';

import type { GenerationLogger, SceneContentFailure } from '@openmaic/generation';
import {
  findQuizOptionsContractFailure,
  generateSceneContent,
  normalizeQuizOptions,
} from '../src/scene-generator.js';
import { quizOutline } from './scene-fixtures.js';

const correctOptions = [
  { value: 'A', label: '(6, 2)' },
  { value: 'B', label: '(2, -4)' },
  { value: 'C', label: '(6, -3)' },
  { value: 'D', label: '(6, -4)' },
];

const swappedOptions = [
  { value: '(6, 2)', label: 'A' },
  { value: '(2, -4)', label: 'B' },
  { value: '(6, -3)', label: 'C' },
  { value: '(6, -4)', label: 'D' },
];

describe('normalizeQuizOptions', () => {
  it('leaves a swapped letter label and content value unchanged', () => {
    expect(normalizeQuizOptions(swappedOptions)).toEqual(swappedOptions);
  });

  it('does not uppercase or swap a lowercase letter label', () => {
    expect(
      normalizeQuizOptions([
        { value: '4', label: 'a' },
        { value: 'Yes', label: 'b' },
      ]),
    ).toEqual([
      { value: '4', label: 'a' },
      { value: 'Yes', label: 'b' },
    ]);
  });

  it('keeps a letter label when it disagrees with the index', () => {
    expect(normalizeQuizOptions([{ value: '(6, 2)', label: 'C' }])).toEqual([
      { value: '(6, 2)', label: 'C' },
    ]);
  });

  it('leaves an already-correct letter value and content label unchanged', () => {
    expect(
      normalizeQuizOptions([
        { value: 'A', label: '(6, 2)' },
        { value: 'b', label: 'A is prime' },
        { value: 'C', label: 'C' },
      ]),
    ).toEqual([
      { value: 'A', label: '(6, 2)' },
      { value: 'b', label: 'A is prime' },
      { value: 'C', label: 'C' },
    ]);
  });

  it('does not rewrite when both sides are letters or both sides are content', () => {
    expect(
      normalizeQuizOptions([
        { value: 'A', label: 'B' },
        { value: 'red', label: 'blue' },
        { value: '(6, 2)', label: 'A ' },
        { value: '(6, 2)', label: 'Ｂ' },
        { value: '', label: 'A' },
      ]),
    ).toEqual([
      { value: 'A', label: 'B' },
      { value: 'red', label: 'blue' },
      { value: '(6, 2)', label: 'A ' },
      { value: '(6, 2)', label: 'Ｂ' },
      { value: '', label: 'A' },
    ]);
  });

  it('still maps plain strings to an index letter and the string as label', () => {
    expect(normalizeQuizOptions(['The caller', 'The package'])).toEqual([
      { value: 'A', label: 'The caller' },
      { value: 'B', label: 'The package' },
    ]);
  });

  it('keeps index-letter and text fallbacks when fields are missing or not strings', () => {
    expect(
      normalizeQuizOptions([
        'plain',
        { value: '(6, 2)', label: 'D' },
        { value: 'C', label: 'already content' },
        { label: 'only label' },
        { label: 'B' },
        { value: 'only value' },
        { text: 'from text' },
        { value: 42, label: 'A' },
        null,
        7,
      ]),
    ).toEqual([
      { value: 'A', label: 'plain' },
      { value: '(6, 2)', label: 'D' },
      { value: 'C', label: 'already content' },
      { value: 'D', label: 'only label' },
      { value: 'E', label: 'B' },
      { value: 'only value', label: 'only value' },
      { value: 'G', label: 'from text' },
      { value: 'H', label: 'A' },
      { value: 'I', label: 'null' },
      { value: 'J', label: '7' },
    ]);
  });

  it('returns undefined when options are missing or not an array', () => {
    expect(normalizeQuizOptions(undefined)).toBeUndefined();
    expect(normalizeQuizOptions(null as unknown as undefined)).toBeUndefined();
    expect(normalizeQuizOptions('A' as unknown as undefined)).toBeUndefined();
  });
});

describe('findQuizOptionsContractFailure', () => {
  it('accepts letter values whose answers name those values', () => {
    expect(
      findQuizOptionsContractFailure([
        {
          id: 'q1',
          type: 'single',
          question: 'Which coordinate is (6, 2)?',
          options: correctOptions,
          answer: ['A'],
        },
        {
          id: 'q2',
          type: 'multiple',
          question: 'Select the matching points',
          options: correctOptions.slice(0, 2),
          answer: ['A', 'B'],
        },
        {
          id: 'q3',
          type: 'short_answer',
          question: 'Explain the pair',
        },
      ]),
    ).toBeNull();
  });

  it('rejects a swapped value, a missing option list, and an answer that misses every value', () => {
    expect(
      findQuizOptionsContractFailure([
        {
          id: 'q-swap',
          type: 'single',
          question: 'Which coordinate is (6, 2)?',
          options: swappedOptions,
          answer: ['A'],
        },
      ]),
    ).toBe('question 1 (q-swap): option 1 value "(6, 2)" is not a single letter A-Z');

    expect(
      findQuizOptionsContractFailure([
        { id: 'q-empty', type: 'single', question: '?', options: [], answer: ['A'] },
      ]),
    ).toBe('question 1 (q-empty): choice question has no options');

    expect(
      findQuizOptionsContractFailure([{ id: 'q-missing', type: 'single', question: '?' }]),
    ).toBe('question 1 (q-missing): choice question has no options');

    expect(
      findQuizOptionsContractFailure([
        {
          id: 'q-none',
          type: 'multiple',
          question: '?',
          options: correctOptions.slice(0, 2),
        },
      ]),
    ).toBe('question 1 (q-none): answer key does not reference an option value');

    expect(
      findQuizOptionsContractFailure([
        {
          id: 'q-key',
          type: 'single',
          question: '?',
          options: correctOptions.slice(0, 2),
          answer: ['a'],
        },
      ]),
    ).toBe('question 1 (q-key): answer "a" does not match an option value');
  });
});

function recordingLogger(): { logger: GenerationLogger; errors: string[] } {
  const errors: string[] = [];
  const logger: GenerationLogger = {
    debug() {},
    info() {},
    warn() {},
    error(message: string) {
      errors.push(message);
    },
  };
  return { logger, errors };
}

describe('generateSceneContent quiz option contract', () => {
  it('rejects a swapped option shape as invalid model output', async () => {
    const failures: SceneContentFailure[] = [];
    const { logger, errors } = recordingLogger();

    const content = await generateSceneContent(
      quizOutline(),
      async () =>
        JSON.stringify([
          {
            id: 'q1',
            type: 'single',
            question: 'Which coordinate is (6, 2)?',
            options: swappedOptions,
            answer: ['(6, 2)'],
          },
          {
            id: 'q2',
            type: 'multiple',
            question: 'Select the matching points',
            options: [
              { value: '(0, 1)', label: 'A' },
              { value: '(1, 0)', label: 'B' },
            ],
            correctAnswer: 'A',
          },
        ]),
      { onFailure: (failure) => failures.push(failure), logger },
    );

    expect(content).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
    expect(errors).toEqual([
      'Quiz option contract failed for "Dependency Injection Check": question 1 (q1): option 1 value "(6, 2)" is not a single letter A-Z',
    ]);
  });

  it('rejects a lowercase letter key instead of rewriting it onto the value', async () => {
    const failures: SceneContentFailure[] = [];

    const content = await generateSceneContent(
      quizOutline(),
      async () =>
        JSON.stringify([
          {
            id: 'q-lower',
            type: 'single',
            question: 'Which coordinate is (6, 2)?',
            options: [
              { value: '(6, 2)', label: 'a' },
              { value: '(2, -4)', label: 'b' },
            ],
            answer: ['a'],
          },
        ]),
      { onFailure: (failure) => failures.push(failure) },
    );

    expect(content).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });

  it('persists a correct option shape unchanged', async () => {
    const failures: SceneContentFailure[] = [];

    const content = await generateSceneContent(
      quizOutline(),
      async () =>
        JSON.stringify([
          {
            id: 'q1',
            type: 'single',
            question: 'Which coordinate is (6, 2)?',
            options: correctOptions,
            answer: ['A'],
            analysis: 'A is the point (6, 2).',
            points: 10,
          },
          {
            id: 'q2',
            type: 'short_answer',
            question: 'Describe the point.',
            commentPrompt: 'Mention both coordinates.',
            analysis: 'Both numbers.',
            points: 5,
          },
        ]),
      { onFailure: (failure) => failures.push(failure) },
    );

    expect(failures).toEqual([]);
    expect(content).toMatchObject({
      questions: [
        {
          id: 'q1',
          type: 'single',
          options: correctOptions,
          answer: ['A'],
          analysis: 'A is the point (6, 2).',
          points: 10,
        },
        {
          id: 'q2',
          type: 'short_answer',
          answer: undefined,
          hasAnswer: false,
        },
      ],
    });
  });

  it('still accepts an exact content answer once it aligns to the option value', async () => {
    const content = await generateSceneContent(quizOutline(), async () =>
      JSON.stringify([
        {
          id: 'q1',
          type: 'single',
          question: 'Which coordinate is (6, 2)?',
          options: correctOptions.slice(0, 2),
          answer: ['(6, 2)'],
        },
      ]),
    );

    expect(content).toMatchObject({
      questions: [
        {
          id: 'q1',
          options: correctOptions.slice(0, 2),
          answer: ['A'],
        },
      ],
    });
  });

  it('rejects an answer that does not name an option value', async () => {
    const failures: SceneContentFailure[] = [];

    const content = await generateSceneContent(
      quizOutline(),
      async () =>
        JSON.stringify([
          {
            id: 'q-already',
            type: 'single',
            question: 'Which coordinate is (6, 2)?',
            options: correctOptions.slice(0, 2),
            answer: ['a'],
          },
        ]),
      { onFailure: (failure) => failures.push(failure) },
    );

    expect(content).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });
});
