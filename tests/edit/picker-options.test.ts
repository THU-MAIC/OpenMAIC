import { describe, expect, test } from 'vitest';
import { pickerOptions } from '@/components/edit/ActionsBar/picker-options';
import type { Action } from '@/lib/types/action';

const A = (id: string, type = 'speech'): Action => ({ id, type }) as unknown as Action;

describe('pickerOptions', () => {
  test('slide scene offers speech + spotlight + laser + discussion', () => {
    expect(pickerOptions('slide', []).map((o) => o.type)).toEqual([
      'speech',
      'spotlight',
      'laser',
      'discussion',
    ]);
  });
  test('non-slide scenes drop element-bound cues', () => {
    expect(pickerOptions('interactive', []).map((o) => o.type)).toEqual(['speech', 'discussion']);
    expect(pickerOptions('pbl', []).map((o) => o.type)).toEqual(['speech', 'discussion']);
    expect(pickerOptions('quiz', []).map((o) => o.type)).toEqual(['speech', 'discussion']);
  });
  test('discussion is disabled once the scene already has one', () => {
    const opts = pickerOptions('slide', [A('d', 'discussion')]);
    expect(opts.find((o) => o.type === 'discussion')?.disabled).toBe(true);
    expect(opts.find((o) => o.type === 'speech')?.disabled).toBe(false);
  });
});
