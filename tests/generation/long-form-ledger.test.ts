import { describe, expect, it } from 'vitest';
import { buildLedgerText } from '@/lib/generation/long-form';
import type { SceneOutline } from '@/lib/types/generation';

function page(index: number, title: string, keyPoints: string[]): SceneOutline {
  return {
    id: `scene_${index}`,
    type: 'slide',
    title,
    description: '',
    keyPoints,
    order: index,
  };
}

const course: SceneOutline[] = [
  page(1, '痛觉是怎样产生的', ['疼痛是伤害信号加情绪体验', '四站传导路径', '快痛与慢痛分型']),
  page(2, '镇痛的边界', ['中枢作用', '不影响意识', '三分类']),
  page(3, '阿片受体', ['七次跨膜', '三型分库']),
  page(4, '突触机制', ['突触前抑制', '突触后超极化']),
];

describe('buildLedgerText', () => {
  it('has nothing to say on the first page', () => {
    // A header with no content is worse than no header.
    expect(buildLedgerText(course, 1)).toBe('');
  });

  it('lists what the earlier pages established, one line each', () => {
    const text = buildLedgerText(course, 4);

    expect(text).toContain('What the course has already established (pages 1-3)');
    expect(text).toContain('1. 痛觉是怎样产生的');
    expect(text).toContain('疼痛是伤害信号加情绪体验');
    expect(text).toContain('3. 阿片受体');
    // The page being written is not in its own memory.
    expect(text).not.toContain('4. 突触机制');
  });

  it('tells the model what to do with the memory', () => {
    const text = buildLedgerText(course, 3);
    expect(text).toContain('do not redefine a term');
    expect(text).toContain('do not re-run an example');
  });

  it('keeps every page when the course is short enough', () => {
    const text = buildLedgerText(course, 4);
    expect(text).not.toContain('elided');
  });

  it('elides the middle of a two-hour course instead of overflowing', () => {
    const long = Array.from({ length: 100 }, (_, index) =>
      page(index + 1, `第 ${index + 1} 页`, ['一个相当长的要点描述用来占位', '第二个要点']),
    );
    const text = buildLedgerText(long, 100);

    expect(text).toContain('elided to fit');
    // The early definitions everything rests on survive.
    expect(text).toContain('1. 第 1 页');
    // So does the thread the next page continues.
    expect(text).toContain('99. 第 99 页');
    expect(text.length).toBeLessThan(2600);
  });

  it('respects the line budget', () => {
    const text = buildLedgerText(course, 2, { lineBudget: 20 });
    const line = text.split('\n').find((candidate) => candidate.startsWith('1. '))!;
    expect(line.length).toBeLessThanOrEqual(20);
  });

  it('does not run past the end of the outline', () => {
    expect(buildLedgerText(course, 999)).toContain('pages 1-4');
  });
});
