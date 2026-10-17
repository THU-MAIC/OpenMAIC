import { describe, expect, test } from 'vitest';
import {
  validateOutline,
  outlinesHaveBlockingIssues,
  countBlockingOutlines,
} from '@/lib/edit/content-validation';
import type { SceneOutline } from '@/lib/types/generation';

const outline = (over: Partial<SceneOutline>): SceneOutline =>
  ({
    id: 'o',
    order: 1,
    type: 'slide',
    title: 'X',
    description: '',
    keyPoints: [],
    ...over,
  }) as SceneOutline;

describe('validateOutline / blocking helpers', () => {
  test('blank title → emptyTitle; filled title → no issue', () => {
    expect(validateOutline(outline({ title: '' }))).toEqual([{ kind: 'emptyTitle' }]);
    expect(validateOutline(outline({ title: '   ' }))).toEqual([{ kind: 'emptyTitle' }]);
    expect(validateOutline(outline({ title: 'Intro' }))).toEqual([]);
  });

  test('outlinesHaveBlockingIssues / countBlockingOutlines count blank titles', () => {
    const os = [outline({ title: 'A' }), outline({ title: '' }), outline({ title: ' ' })];
    expect(outlinesHaveBlockingIssues(os)).toBe(true);
    expect(countBlockingOutlines(os)).toBe(2);
    expect(outlinesHaveBlockingIssues([outline({ title: 'A' })])).toBe(false);
    expect(countBlockingOutlines([outline({ title: 'A' })])).toBe(0);
  });
});
