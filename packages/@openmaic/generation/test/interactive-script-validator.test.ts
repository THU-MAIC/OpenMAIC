import { describe, expect, it } from 'vitest';

import { findInteractiveScriptSyntaxFailure } from '../src/interactive-script-validator.js';

describe('findInteractiveScriptSyntaxFailure', () => {
  it('accepts valid classic inline scripts', () => {
    expect(
      findInteractiveScriptSyntaxFailure(
        '<html><body><button id="go">Go</button><script>document.getElementById("go")?.addEventListener("click", () => console.log("go"));</script></body></html>',
      ),
    ).toBeNull();
  });

  it('reports the first syntactically invalid classic inline script', () => {
    expect(
      findInteractiveScriptSyntaxFailure(
        '<html><body><script>const ok = 1;</script><script>const broken = ;</script></body></html>',
      ),
    ).toMatchObject({
      scriptIndex: 2,
      message: expect.any(String),
    });
  });

  it.each([
    [
      'widget config JSON',
      '<script type="application/json" id="widget-config">{"type":"simulation"}</script>',
    ],
    ['external scripts', '<script src="https://example.com/widget.js"></script>'],
    [
      'module scripts',
      '<script type="module">import value from "./value.js"; console.log(value);</script>',
    ],
  ])('skips %s because it is not a classic inline script body', (_label, script) => {
    expect(
      findInteractiveScriptSyntaxFailure('<html><body>' + script + '</body></html>'),
    ).toBeNull();
  });

  it('accepts classic JavaScript MIME types with parameters', () => {
    expect(
      findInteractiveScriptSyntaxFailure(
        '<script type="text/javascript; charset=utf-8">const value = 1;</script>',
      ),
    ).toBeNull();
  });
});
