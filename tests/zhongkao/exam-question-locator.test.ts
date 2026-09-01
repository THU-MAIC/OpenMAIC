import { describe, expect, it } from 'vitest';

import { normalizeExamQuestionMarker as legacyNormalizeExamQuestionMarker } from '@/lib/zhongkao/exam-question-candidate';
import {
  examQuestionLocatorKey,
  normalizeExamQuestionLocator,
  normalizeExamQuestionMarker,
  parseExamQuestionResponseLabel,
} from '@/lib/zhongkao/exam-question-locator';

describe('shared Exam question locator', () => {
  it('preserves the M3A-2A marker API through the legacy module', () => {
    for (const value of ['1． question', '17（1） child', '一、选择题', '(1)+2']) {
      expect(normalizeExamQuestionMarker(value)).toEqual(legacyNormalizeExamQuestionMarker(value));
    }
  });

  it.each([
    ['1', { rawLabel: '1', printedNumber: '1', subquestionPath: [] }],
    ['１', { rawLabel: '１', printedNumber: '1', subquestionPath: [] }],
    ['17(1)', { rawLabel: '17(1)', printedNumber: '17', subquestionPath: ['1'] }],
    ['17（1）', { rawLabel: '17（1）', printedNumber: '17', subquestionPath: ['1'] }],
  ])('parses complete response label %s', (value, expected) => {
    expect(parseExamQuestionResponseLabel(value)).toEqual(expected);
  });

  it.each(['2026年', '1.5', '1:2', '第1页', '17(1) trailing', ' 1 '])(
    'rejects non-label response text %s',
    (value) => {
      expect(parseExamQuestionResponseLabel(value)).toBeNull();
    },
  );

  it('uses normalized section ids for semantic locator equality', () => {
    const first = {
      sectionPath: [{ normalizedId: 'section:1', rawLabel: '一、选择题' }],
      printedNumber: '17',
      subquestionPath: ['1'],
    };
    const renamed = {
      ...first,
      sectionPath: [{ normalizedId: 'section:1', rawLabel: '一、选择题（单选）' }],
    };

    expect(normalizeExamQuestionLocator(first)).toEqual({
      sectionPath: ['section:1'],
      printedNumber: '17',
      subquestionPath: ['1'],
    });
    expect(examQuestionLocatorKey(renamed)).toBe(examQuestionLocatorKey(first));
  });
});
