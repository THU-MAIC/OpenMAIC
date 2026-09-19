import { describe, expect, it } from 'vitest';
import { applyHtmlEdits, applyEditsToNormalizedContent } from '@/lib/edit/html-edit';

const HTML =
  '<!DOCTYPE html>\n<html>\n<head></head>\n<body>\n<button id="go">Go</button>\n<script>document.getElementById("strt").addEventListener("click",fn);</script>\n</body>\n</html>\n';

describe('applyHtmlEdits (vendored pi edit core)', () => {
  it('applies a single exact str_replace edit', () => {
    const out = applyHtmlEdits(HTML, [
      { oldText: 'getElementById("strt")', newText: 'getElementById("go")' },
    ]);
    expect(out).toContain('getElementById("go").addEventListener');
    expect(out).not.toContain('strt');
    // everything else preserved
    expect(out).toContain('<button id="go">Go</button>');
  });

  it('applies multiple non-overlapping edits in one call', () => {
    const out = applyHtmlEdits(HTML, [
      { oldText: '<button id="go">Go</button>', newText: '<button id="go">Start</button>' },
      { oldText: '"strt"', newText: '"go"' },
    ]);
    expect(out).toContain('>Start<');
    expect(out).toContain('getElementById("go")');
  });

  it('throws a not-found error when oldText is absent', () => {
    expect(() => applyHtmlEdits(HTML, [{ oldText: 'does-not-exist', newText: 'x' }])).toThrow(
      /Could not find/i,
    );
  });

  it('throws an ambiguity error when oldText is not unique', () => {
    expect(() =>
      applyHtmlEdits('<p>x</p>\n<p>x</p>\n', [{ oldText: '<p>x</p>', newText: '<p>y</p>' }]),
    ).toThrow(/occurrences|unique/i);
  });

  it('throws when an edit makes no change', () => {
    expect(() => applyHtmlEdits(HTML, [{ oldText: 'Go', newText: 'Go' }])).toThrow(
      /No changes|identical/i,
    );
  });

  it('fuzzy-matches smart quotes against ASCII oldText', () => {
    // content has a smart double-quote; oldText uses an ASCII quote
    const src = '<p>“hello”</p>\n';
    const out = applyEditsToNormalizedContent(src, [{ oldText: '"hello"', newText: '"bye"' }], 'x');
    expect(out.newContent).toContain('bye');
  });

  it('preserves CRLF line endings', () => {
    const crlf = '<head></head>\r\n<body><b>old</b></body>\r\n';
    const out = applyHtmlEdits(crlf, [{ oldText: '<b>old</b>', newText: '<b>new</b>' }]);
    expect(out).toContain('\r\n');
    expect(out).toContain('<b>new</b>');
  });
});
