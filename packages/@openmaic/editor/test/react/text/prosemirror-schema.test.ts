// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../../src/react/text/prosemirror/document';

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

  it('preserves paragraph typography that affects line box geometry', () => {
    const output = serializeTextDocument(
      createTextDocument('<p style="font-size: 14px; line-height: 1.2">Text</p>'),
    );

    expect(output).toMatch(/<p style="[^"]*font-size: 14px/);
    expect(output).toMatch(/<p style="[^"]*line-height: 1.2/);
  });

  it('preserves PPTX character spacing and pixel first-line indentation', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<p style="text-indent: 78px"><span style="letter-spacing: 1.5pt">Indented text</span></p>',
      ),
    );

    expect(output).toContain('text-indent: 78px');
    expect(output).toContain('letter-spacing: 1.5pt');
  });

  it('preserves rem first-line indentation without converting its unit', () => {
    const output = serializeTextDocument(
      createTextDocument('<p style="text-indent: 1rem">Indented text</p>'),
    );

    expect(output).toContain('text-indent: 1rem');
    expect(output).not.toContain('text-indent: 1em');
  });

  it('preserves an empty inline-block spacer used for PPTX first-line indentation', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<p><span style="display: inline-block; width: 1.50em"></span>Indented text</p>',
      ),
    );

    expect(output).toContain('display: inline-block');
    expect(output).toContain('width: 1.5em');
    expect(output).toContain('Indented text');
  });

  it('preserves PPTX text-container and paragraph geometry while editing', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<div style="padding: 4.8px 9.6px"><p style="margin-left: 78px; text-indent: -30px; padding-top: 7.3px; margin-top: 8px; margin-bottom: 5px">Text</p></div>',
      ),
    );

    expect(output).toContain('padding: 4.8px 9.6px');
    expect(output).toContain('margin-left: 78px');
    expect(output).toContain('text-indent: -30px');
    expect(output).toContain('padding-top: 7.3px');
    expect(output).toContain('margin-top: 8px');
    expect(output).toContain('margin-bottom: 5px');
  });

  it('preserves no-wrap paragraphs imported from PPTX', () => {
    const output = serializeTextDocument(
      createTextDocument('<p style="white-space: nowrap">在集体中成长，与集体共成长</p>'),
    );

    expect(output).toContain('white-space: nowrap');
  });

  it('preserves a sized inline-block slot containing a PPTX bullet glyph', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<p><span style="display: inline-block; width: 30px; text-indent: 0; box-sizing: border-box">■</span>1954年清华大学首创</p>',
      ),
    );

    expect(output).toContain('display: inline-block');
    expect(output).toContain('width: 30px');
    expect(output).toContain('text-indent: 0');
    expect(output).toContain('box-sizing: border-box');
    expect(output).toContain('■');
  });

  it('preserves inline-block layout styles used by imported PPTX text', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<p><span style="display: inline-block; width: 30px; height: 24px; vertical-align: middle; margin: 1px 2px; padding: 3px 4px">■</span><span style="display: inline-block; width: 12px; margin-left: 5px; padding-right: 6px">•</span>Text</p>',
      ),
    );

    expect(output).toContain('display: inline-block');
    expect(output).toContain('height: 24px');
    expect(output).toContain('vertical-align: middle');
    expect(output).toContain('margin: 1px 2px');
    expect(output).toContain('margin-left: 5px');
    expect(output).toContain('padding: 3px 4px');
    expect(output).toContain('padding-right: 6px');
  });

  it('preserves explicit PPTX line breaks instead of reflowing them', () => {
    const output = serializeTextDocument(
      createTextDocument(
        '<p><span style="font-size: 29.3px">1954年清华大学首创“先进集体”</span><br><span style="font-size: 29.3px">评选制度</span></p>',
      ),
    );

    expect(output).toMatch(/1954年清华大学首创“先进集体”<\/span><br><span[^>]*>评选制度/);
  });

  it('turns literal plain-text newlines into explicit line breaks', () => {
    const output = serializeTextDocument(createTextDocument('First line\nSecond line'));

    expect(output).toContain('First line<br>Second line');
  });

  it('decodes plain-text HTML entities while preserving literal line breaks', () => {
    const output = serializeTextDocument(createTextDocument('A&nbsp;\nB &amp; C'));

    expect(output).toContain('A&nbsp;<br>B &amp; C');
  });
});
