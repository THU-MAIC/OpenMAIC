import { describe, expect, it } from 'vitest';
import { parseMarkdownIntoBlocks } from 'streamdown';
import {
  courseCardExclusions,
  courseMentionsIn,
  segmentCourseMentions,
} from '@/lib/workbench/course-link';

describe('course mentions in agent Markdown', () => {
  it('finds course links in order, once each, and skips fenced code', () => {
    const text = [
      '[A](/classroom/a) and [B](/workspace?course=b) and [A](/classroom/a)',
      '```',
      '[C](/classroom/c)',
      '```',
      '[docs](/docs) [D](</classroom/d> "title")',
    ].join('\n');
    expect(courseMentionsIn(text)).toEqual(['a', 'b', 'd']);
  });

  it('segments after the block that first mentions a course, and keeps the text whole', () => {
    const text =
      'Intro.\n\n- item [A](/classroom/a)\n- two\n\nMore [A](/classroom/a) [B](/classroom/b).';
    const segments = segmentCourseMentions(parseMarkdownIntoBlocks(text));
    expect(segments.map((segment) => segment.cards)).toEqual([['a'], ['b']]);
    expect(segments.map((segment) => segment.markdown).join('')).toBe(text);
  });

  it('gives an excluded course no card, and text with no mention one plain segment', () => {
    expect(segmentCourseMentions(['See [A](/classroom/a).'], new Set(['a']))).toEqual([
      { markdown: 'See [A](/classroom/a).', cards: [] },
    ]);
    expect(segmentCourseMentions(['Plain.'])).toEqual([{ markdown: 'Plain.', cards: [] }]);
  });

  it('excludes what the same answer carded earlier or carries at its tail, per answer', () => {
    const exclusions = courseCardExclusions([
      { key: 'u1', kind: 'user', text: 'make it' },
      { key: 't1', kind: 'assistant', text: 'Made [A](/classroom/a), see [B](/classroom/b).' },
      { key: 'tool', kind: 'tool', text: '' },
      { key: 't2', kind: 'assistant', text: 'Again [B](/classroom/b), and [C](/classroom/c).' },
      { key: 'c1', kind: 'course', text: '', stageIds: ['a'] },
      { key: 'u2', kind: 'user', text: 'more' },
      { key: 't3', kind: 'assistant', text: '[A](/classroom/a)' },
    ]);
    expect([...exclusions.get('t1')!]).toEqual(['a']);
    expect([...exclusions.get('t2')!].sort()).toEqual(['a', 'b']);
    expect([...exclusions.get('t3')!]).toEqual([]);
  });
});
