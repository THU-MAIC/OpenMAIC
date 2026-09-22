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
      message: expect.stringMatching(/Unexpected token/),
    });
  });

  it('reports a Flink-like bare declaration and counts skipped scripts', () => {
    const failure = findInteractiveScriptSyntaxFailure(
      [
        '<html><body>',
        '<script type="application/json" id="widget-config">{"type":"simulation"}</script>',
        '<script>state counts = new Array(10).fill(0);</script>',
        '</body></html>',
      ].join(''),
    );

    expect(failure).toMatchObject({
      scriptIndex: 2,
      message: expect.stringMatching(/Unexpected identifier 'counts'/),
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
    expect(findInteractiveScriptSyntaxFailure(`<html><body>${script}</body></html>`)).toBeNull();
  });

  it('accepts classic JavaScript MIME types with parameters', () => {
    expect(
      findInteractiveScriptSyntaxFailure(
        '<script type="text/javascript; charset=utf-8">const value = 1;</script>',
      ),
    ).toBeNull();
  });

  it('accepts a classic script whose quoted attribute contains a greater-than', () => {
    expect(
      findInteractiveScriptSyntaxFailure(
        '<script data-note="a > b">window.widgetRan = true;</script>',
      ),
    ).toBeNull();
  });

  it('still checks the script body when an attribute value contains a greater-than', () => {
    expect(
      findInteractiveScriptSyntaxFailure('<script data-note="a > b">state counts = [];</script>'),
    ).toMatchObject({
      scriptIndex: 1,
      message: expect.stringMatching(/Unexpected identifier 'counts'/),
    });
  });

  it('does not let a greater-than inside quotes hide a later type attribute', () => {
    expect(
      findInteractiveScriptSyntaxFailure(
        '<script data-note="a > b" type="application/json">{"a":1}</script>',
      ),
    ).toBeNull();
  });

  it('does not treat a script inside an HTML comment as executable', () => {
    expect(
      findInteractiveScriptSyntaxFailure(
        '<!-- <script>state counts = [];</script> --><script>window.widgetRan = true;</script>',
      ),
    ).toBeNull();
  });

  it('checks the script that follows an HTML comment and does not count the comment', () => {
    expect(
      findInteractiveScriptSyntaxFailure(
        '<!-- <script>state counts = [];</script> --><script>state counts = [];</script>',
      ),
    ).toMatchObject({
      scriptIndex: 1,
      message: expect.stringMatching(/Unexpected identifier 'counts'/),
    });
  });

  it('ends an abruptly closed comment before the next script', () => {
    expect(
      findInteractiveScriptSyntaxFailure('<!--> <script>state counts = [];</script>'),
    ).toMatchObject({
      scriptIndex: 1,
      message: expect.stringMatching(/Unexpected identifier 'counts'/),
    });
  });

  it.each([
    [
      'noscript',
      '<noscript><script>state counts = [];</script></noscript><script>window.widgetRan = true;</script>',
    ],
    [
      'textarea',
      '<textarea><script>state counts = [];</script></textarea><script>window.widgetRan = true;</script>',
    ],
  ])('does not treat a script inside %s as executable', (_label, html) => {
    expect(findInteractiveScriptSyntaxFailure(html)).toBeNull();
  });

  it('rejects a top-level return, which is illegal in a classic script', () => {
    expect(findInteractiveScriptSyntaxFailure('<script>return;</script>')).toMatchObject({
      scriptIndex: 1,
      message: expect.stringMatching(/Illegal return statement/),
    });
  });

  it('accepts a return nested inside a function', () => {
    expect(
      findInteractiveScriptSyntaxFailure('<script>function stop() { return; }</script>'),
    ).toBeNull();
  });

  it('ends a classic script at the HTML end tag, even inside a JavaScript string', () => {
    expect(
      findInteractiveScriptSyntaxFailure(
        '<script>const value = "</script>"; window.widgetRan = true;</script>',
      ),
    ).toMatchObject({
      scriptIndex: 1,
      message: expect.stringMatching(/Invalid or unexpected token/),
    });
  });
});
