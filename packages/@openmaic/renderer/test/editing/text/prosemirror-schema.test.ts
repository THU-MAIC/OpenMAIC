// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../../src/editing/text/prosemirror/document';

describe('renderer ProseMirror schema', () => {
  it('round-trips legacy rich-text nodes and marks', () => {
    const html =
      '<blockquote><p style="text-align: center"><a href="https://maic.chat"><strong><u><span style="font-size: 28px; color: #ff0000">MAIC</span></u></strong></a></p></blockquote><ol><li><p>One</p></li></ol>';

    const output = serializeTextDocument(createTextDocument(html));

    expect(output).toContain('<blockquote>');
    expect(output).toContain('<ol');
    expect(output).toContain('font-size: 28px');
    expect(output).toContain('color: rgb(255, 0, 0)');
    expect(output).toContain('href="https://maic.chat"');
    expect(output).toContain('text-align: center');
  });
});
