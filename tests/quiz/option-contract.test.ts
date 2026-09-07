import { describe, it, expect } from 'vitest';
import { normalizeQuizOptions } from '@/packages/@openmaic/generation/src/scene-generator';

describe('normalizeQuizOptions option contract', () => {
  it('keeps the documented shape when the model already follows it', () => {
    expect(
      normalizeQuizOptions([
        { value: 'A', label: '梯度是一个标量' },
        { value: 'B', label: '梯度是一个向量' },
      ]),
    ).toEqual([
      { value: 'A', label: '梯度是一个标量' },
      { value: 'B', label: '梯度是一个向量' },
    ]);
  });

  it('restores the contract when the model swaps value and label (#1375)', () => {
    // QuizView renders `value` as the badge and `label` as the body, so this
    // shape used to render a badge reading "(6, 2)" above a body reading "A".
    expect(
      normalizeQuizOptions([
        { value: '(6, 2)', label: 'A' },
        { value: '(2, -4)', label: 'B' },
      ]),
    ).toEqual([
      { value: 'A', label: '(6, 2)' },
      { value: 'B', label: '(2, -4)' },
    ]);
  });

  it('takes the letter from label, not the index, so answer keys still resolve', () => {
    expect(normalizeQuizOptions([{ value: 'twelve', label: 'C' }])).toEqual([
      { value: 'C', label: 'twelve' },
    ]);
  });

  it('leaves two bare letters alone — the content may itself be a letter', () => {
    expect(normalizeQuizOptions([{ value: 'A', label: 'B' }])).toEqual([
      { value: 'A', label: 'B' },
    ]);
  });

  it('still letters plain string options by position', () => {
    expect(normalizeQuizOptions(['first', 'second'])).toEqual([
      { value: 'A', label: 'first' },
      { value: 'B', label: 'second' },
    ]);
  });

  it('returns undefined for missing options', () => {
    expect(normalizeQuizOptions(undefined)).toBeUndefined();
  });
});
