import { describe, expect, it } from 'vitest';
import { preservesPlainTextLineBreaks } from '../../src/utils/richText';

describe('preservesPlainTextLineBreaks', () => {
  it.each(['First line\nSecond line', 'A&nbsp;\nB', '2 < 3'])(
    'keeps literal line endings for tag-free content: %j',
    (content) => {
      expect(preservesPlainTextLineBreaks(content)).toBe(true);
    },
  );

  it.each([
    '<p>A</p>\n<p>B</p>',
    '<my-widget>content</my-widget>',
    'A<!-- source note -->\nB',
    '<!doctype html>\nA',
  ])('does not preserve source-formatting line endings in HTML markup: %j', (content) => {
    expect(preservesPlainTextLineBreaks(content)).toBe(false);
  });
});
