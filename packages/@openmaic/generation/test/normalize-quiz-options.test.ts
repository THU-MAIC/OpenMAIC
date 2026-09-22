import { describe, expect, it } from 'vitest';

import { generateSceneContent, normalizeQuizOptions } from '../src/scene-generator.js';
import { quizOutline } from './scene-fixtures.js';

describe('normalizeQuizOptions', () => {
  it('swaps a bare letter label with longer value content', () => {
    expect(
      normalizeQuizOptions([
        { value: '(6, 2)', label: 'A' },
        { value: '(2, -4)', label: 'B' },
        { value: '(6, -3)', label: 'C' },
        { value: '(6, -4)', label: 'D' },
      ]),
    ).toEqual([
      { value: 'A', label: '(6, 2)' },
      { value: 'B', label: '(2, -4)' },
      { value: 'C', label: '(6, -3)' },
      { value: 'D', label: '(6, -4)' },
    ]);
  });

  it('uppercases a lowercase bare letter and still swaps single-character content', () => {
    expect(
      normalizeQuizOptions([
        { value: '4', label: 'a' },
        { value: 'Yes', label: 'b' },
      ]),
    ).toEqual([
      { value: 'A', label: '4' },
      { value: 'B', label: 'Yes' },
    ]);
  });

  it('keeps the letter that was in label when it disagrees with the index', () => {
    expect(normalizeQuizOptions([{ value: '(6, 2)', label: 'C' }])).toEqual([
      { value: 'C', label: '(6, 2)' },
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

  it('does not swap when both sides are letters or both sides are content', () => {
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
      { value: 'D', label: '(6, 2)' },
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

describe('generateSceneContent quiz option contract', () => {
  it('persists swapped model options as letter values and resolves the content key', async () => {
    const content = await generateSceneContent(quizOutline(), async () =>
      JSON.stringify([
        {
          id: 'q1',
          type: 'single',
          question: 'Which coordinate is (6, 2)?',
          options: [
            { value: '(6, 2)', label: 'A' },
            { value: '(2, -4)', label: 'B' },
            { value: '(6, -3)', label: 'C' },
            { value: '(6, -4)', label: 'D' },
          ],
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
    );

    expect(content).toMatchObject({
      questions: [
        {
          id: 'q1',
          options: [
            { value: 'A', label: '(6, 2)' },
            { value: 'B', label: '(2, -4)' },
            { value: 'C', label: '(6, -3)' },
            { value: 'D', label: '(6, -4)' },
          ],
          answer: ['A'],
        },
        {
          id: 'q2',
          options: [
            { value: 'A', label: '(0, 1)' },
            { value: 'B', label: '(1, 0)' },
          ],
          answer: ['A'],
        },
      ],
    });
  });
});
