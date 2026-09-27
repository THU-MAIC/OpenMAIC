// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../../src/react/text/prosemirror/document';

it('preserves intrinsic minimum width on imported tab columns', () => {
  const html =
    '<p><span style="display:inline-block;width:75pt;min-width:max-content;text-indent:0;white-space:pre"><span style="font-family:Arial;font-size:12pt">WWWWWWWW</span></span>Next</p>';
  const output = serializeTextDocument(createTextDocument(html));
  expect(output).toContain('min-width: max-content');
  expect(output).toContain('width: 75pt');
  expect(output).toContain('WWWWWWWW');
  expect(output).toContain('Next');
});

it('preserves left alignment inside columns of a right-aligned paragraph', () => {
  const html =
    '<p style="text-align:right"><span style="display:inline-block;width:75pt;text-align:left">A</span>B</p>';
  const output = serializeTextDocument(createTextDocument(html));
  expect(output).toMatch(/display: inline-block;[^\"]*text-align: left;/);
});
