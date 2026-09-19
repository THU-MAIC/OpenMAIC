// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isSemanticallyEmptyText } from '../../../src/react/text/richText';

describe('isSemanticallyEmptyText', () => {
  it.each(['', '<p></p>', '<p><br></p>', '<p>&nbsp;</p>', '<p> \n </p>'])(
    'treats %j as empty',
    (html) => expect(isSemanticallyEmptyText(html)).toBe(true),
  );

  it.each(['<p>A</p>', '<p><strong>中</strong></p>', '<ul><li><p>One</p></li></ul>'])(
    'keeps visible content %j',
    (html) => expect(isSemanticallyEmptyText(html)).toBe(false),
  );
});
