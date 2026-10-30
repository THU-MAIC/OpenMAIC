import { describe, expect, it } from 'vitest';
import {
  deleteMentionBefore,
  insertMention,
  mentionLabel,
  mentionsInDraft,
  MENTION_NAME_MAX,
  segmentMentions,
  stripMentions,
  type InlineMention,
} from '@/lib/workbench/composer-mentions';

const course: InlineMention = { label: '@Fractions', kind: 'course', id: 'stage-1' };
const doc: InlineMention = { label: '@worksheet.pdf', kind: 'material', id: 'm-1' };

describe('a mention label', () => {
  it('is the name after an @, shortened inside the token when long, numbered when taken', () => {
    expect(mentionLabel('Fractions', [])).toBe('@Fractions');
    const long = '浮力：为什么铁块沉底，轮船却浮着在水面上漂';
    const label = mentionLabel(long, []);
    expect([...label].length).toBe(MENTION_NAME_MAX + 1);
    expect(label.endsWith('…')).toBe(true);
    expect(mentionLabel('Fractions', ['@Fractions'])).toBe('@Fractions 2');
    expect(mentionLabel('  Unit   1 ', [])).toBe('@Unit 1');
  });
});

describe('writing and deleting a mention', () => {
  it('goes in at the caret with a space on each side only where one is missing', () => {
    expect(insertMention('Compare with', '@Fractions', 8)).toEqual({
      draft: 'Compare @Fractions with',
      caret: 19,
    });
    expect(insertMention('', '@Fractions', 0)).toEqual({ draft: '@Fractions ', caret: 11 });
    expect(insertMention('Teach @fra', '@Fractions', 6, 10)).toEqual({
      draft: 'Teach @Fractions ',
      caret: 17,
    });
  });

  it('is taken whole by Backspace at its end, and only there', () => {
    const draft = 'Teach @Fractions now';
    expect(deleteMentionBefore(draft, 17, [course])).toEqual({
      draft: 'Teach now',
      caret: 6,
      mention: course,
    });
    expect(deleteMentionBefore(draft, 16, [course])?.draft).toBe('Teach  now');
    // Inside the token, or in plain words: the browser's one character.
    expect(deleteMentionBefore(draft, 12, [course])).toBeNull();
    expect(deleteMentionBefore(draft, 20, [course])).toBeNull();
  });

  it('is forgotten once an edit takes its label out of the draft', () => {
    const both = [course, doc];
    expect(mentionsInDraft('@Fractions and @worksheet.pdf', both)).toBe(both);
    expect(mentionsInDraft('@Fractions and', both)).toEqual([course]);
  });
});

describe('the text that is sent', () => {
  it('leaves the mentions out and closes up around them, keeping the rest as typed', () => {
    expect(stripMentions('Compare @Fractions with @worksheet.pdf  please', [course, doc])).toBe(
      'Compare with  please',
    );
    expect(stripMentions('@Fractions ', [course])).toBe('');
    expect(stripMentions('Teach @fra', [course])).toBe('Teach @fra');
  });
});

describe('the mirror', () => {
  it('splits the text where a mention stands', () => {
    expect(segmentMentions('Teach @Fractions now', ['@Fractions'])).toEqual([
      { text: 'Teach ', mention: false },
      { text: '@Fractions', mention: true },
      { text: ' now', mention: false },
    ]);
    expect(segmentMentions('Plain', [])).toEqual([{ text: 'Plain', mention: false }]);
  });
});
