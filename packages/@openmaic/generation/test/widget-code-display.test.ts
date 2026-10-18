import { describe, expect, it } from 'vitest';
import { checkWidgetCodeDisplay } from '../src/widget-code-display.js';
import { postProcessInteractiveHtml } from '../src/interactive-post-processor.js';
import { generateSceneContent, generateWidgetContent } from '../src/scene-generator.js';
import { withGenerationRetry } from '../src/generation-retry.js';
import { buildSourceGroundedPrompt, COURSE_SOURCE_DATA_MARKER } from '../src/source-requirement.js';
import type { SceneOutline, UserRequirements } from '../src/outline-types.js';

const original = 'value = int(input())\nprint(value)\n';
const repaired = 'value = int(input())\nprint(value + 1)\n';
const source = { code: original, correctedCode: repaired };
const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const block = (role: string, value: string) =>
  `<pre><code data-codemate-source="${role}">${value}</code></pre>`;
const html = (a = escape(original), b = escape(repaired), extra = '') =>
  `<!DOCTYPE html><html><body>${extra}${block('original', a)}${block('reference', b)}<script>const ready = true;</script></body></html>`;
const outline: SceneOutline = {
  id: 'source-display',
  type: 'interactive',
  title: 'Source',
  description: 'Observe source',
  keyPoints: [],
  order: 1,
  widgetType: 'simulation',
  widgetOutline: { concept: 'Source' },
};
const requirements: UserRequirements = {
  requirement: 'Preserve the source',
  codeContextRequired: true,
  codemateSource: {
    title: 'Values',
    content: 'Read and print a value.',
    ...source,
    language: 'Python3',
    referenceValidation: { status: 'unknown', scope: 'not_supplied' },
  },
};

describe('non-executing complete code displays', () => {
  it('accepts complete original/reference text and HTML entity decoding', () => {
    expect(checkWidgetCodeDisplay(html(), source)).toEqual({ ok: true });
    const quoted = 'if a < b and name == "x&y":\n\tprint("<ok>")\n';
    expect(
      checkWidgetCodeDisplay(html(escape(quoted), escape(repaired)), { ...source, code: quoted }),
    ).toEqual({ ok: true });
  });
  it('assembles text split by syntax highlighting spans and explicit line breaks', () => {
    const highlighted =
      '<span class="token">value</span> = int(input())<br><span>print</span>(value)<br>';
    expect(checkWidgetCodeDisplay(html(highlighted), source)).toEqual({ ok: true });
  });
  it('does not require or invent a reference when none is available to this checker', () => {
    const originalOnly = `<html><body>${block('original', escape(original))}</body></html>`;
    for (const correctedCode of [undefined, '', ' \n']) {
      expect(checkWidgetCodeDisplay(originalOnly, { code: original, correctedCode })).toEqual({
        ok: true,
      });
      expect(checkWidgetCodeDisplay(html(), { code: original, correctedCode })).toMatchObject({
        ok: false,
        role: 'reference',
      });
    }
  });
  it('normalizes only source line endings', () => {
    expect(
      checkWidgetCodeDisplay(html(), {
        code: original.replace(/\n/g, '\r\n'),
        correctedCode: repaired.replace(/\n/g, '\r'),
      }),
    ).toEqual({ ok: true });
    for (const value of [
      original.trim(),
      '\n' + original,
      original + '\n',
      ' ' + original,
      original.replace('print', ' print'),
    ]) {
      expect(checkWidgetCodeDisplay(html(escape(value)), source)).toMatchObject({
        ok: false,
        kind: 'source-mismatch',
        role: 'original',
      });
    }
    const leadingSource = { ...source, code: '\n' + original };
    expect(checkWidgetCodeDisplay(html(), leadingSource)).toMatchObject({
      ok: false,
      kind: 'source-mismatch',
    });
    expect(checkWidgetCodeDisplay(html(escape(leadingSource.code)), leadingSource)).toEqual({
      ok: true,
    });
  });
  it('rejects missing final or middle statements independently for either role', () => {
    expect(checkWidgetCodeDisplay(html('value = int(input())\n'), source)).toMatchObject({
      ok: false,
      role: 'original',
    });
    expect(
      checkWidgetCodeDisplay(html(escape(original), 'value = int(input())\n'), source),
    ).toMatchObject({ ok: false, role: 'reference' });
    expect(checkWidgetCodeDisplay(html('print(value)\n'), source)).toMatchObject({
      ok: false,
      role: 'original',
    });
  });
  it('does not accept source hidden in script, comments, attributes or inert nodes', () => {
    const extras = [
      `<script type="application/json">${JSON.stringify(source)}</script>`,
      `<!--${block('original', escape(original))}-->`,
      `<div data-source="${escape(original)}"></div>`,
      `<template>${block('original', escape(original))}</template>`,
      `<noscript>${block('original', escape(original))}</noscript>`,
      `<div hidden>${block('original', escape(original))}</div>`,
    ];
    for (const extra of extras) {
      const value = `<!DOCTYPE html><body>${extra}${block('reference', escape(repaired))}</body>`;
      expect(checkWidgetCodeDisplay(value, source)).toMatchObject({
        ok: false,
        kind: 'missing-display',
        role: 'original',
      });
    }
    expect(
      checkWidgetCodeDisplay(html('value = int(input())\n<!--print(value)-->\n'), source),
    ).toMatchObject({ ok: false, kind: 'source-mismatch' });
  });
  it('rejects ambiguous markers and invalid containers but ignores labels outside code', () => {
    expect(
      checkWidgetCodeDisplay(
        html(escape(original), escape(repaired), block('original', escape(original))),
        source,
      ),
    ).toMatchObject({ ok: false, kind: 'ambiguous-display' });
    expect(
      checkWidgetCodeDisplay(
        html().replace(
          '<pre><code data-codemate-source="original">',
          '<pre><code data-codemate-source="original" data-codemate-source="reference">',
        ),
        source,
      ),
    ).toMatchObject({ ok: false, kind: 'invalid-display' });
    expect(
      checkWidgetCodeDisplay(
        html().replace(
          '<pre><code data-codemate-source="original">',
          '<pre><div data-codemate-source="original">',
        ),
        source,
      ),
    ).toMatchObject({ ok: false });
    expect(
      checkWidgetCodeDisplay(
        html().replace(
          '<pre><code data-codemate-source="original">',
          '<pre><b>Original code</b><code data-codemate-source="original">',
        ),
        source,
      ),
    ).toEqual({ ok: true });
  });
  it('preserves code/pre dollars, entities and highlighting while converting prose math', () => {
    const literal = 'const text = "$value$ < & >";\n';
    const exact = '<span>const</span> text = &quot;$value$ &lt; &amp; &gt;&quot;;\n';
    const input = html(
      exact,
      escape(literal),
      '<p>Value: $x$</p><pre>$raw$</pre><code>$inline$</code>',
    );
    const processed = postProcessInteractiveHtml(input);
    expect(processed).toContain(block('original', exact));
    expect(processed).toContain('<pre>$raw$</pre><code>$inline$</code>');
    expect(processed).toContain('<p>Value: \\(x\\)</p>');
    expect(checkWidgetCodeDisplay(processed, { code: literal, correctedCode: literal })).toEqual({
      ok: true,
    });
  });
  it('retains literal placeholder-looking source and scripts', () => {
    const input =
      '<html><body><pre>__OPENMAIC_LITERAL_BLOCK_0__ $value$</pre><script>const value = "$s$";</script><p>$x$</p></body></html>';
    const processed = postProcessInteractiveHtml(input);
    expect(processed).toContain('<pre>__OPENMAIC_LITERAL_BLOCK_0__ $value$</pre>');
    expect(processed).toContain('<script>const value = "$s$";</script>');
    expect(processed).toContain('<p>\\(x\\)</p>');
  });
  it('rejects oversized source HTML without truncation', () => {
    expect(checkWidgetCodeDisplay(html('x'.repeat(1024 * 1024)), source)).toMatchObject({
      ok: false,
      kind: 'limit',
    });
  });
});

describe('actual generation entry contract', () => {
  it('rejects incomplete displays once at both entries and preserves the existing retry bound', async () => {
    for (const entry of ['scene', 'widget']) {
      let calls = 0;
      const failures: unknown[] = [];
      const ai = async () => {
        calls++;
        return html('value = int(input())\n');
      };
      const options = {
        userRequirements: requirements,
        onFailure: (value: unknown) => failures.push(value),
      };
      const result =
        entry === 'scene'
          ? await generateSceneContent(outline, ai, options)
          : await generateWidgetContent(outline, ai, undefined, options);
      expect(result).toBeNull();
      expect(calls).toBe(1);
      expect(failures).toEqual([{ code: 'invalid-model-output' }]);
    }
    let calls = 0;
    const result = await withGenerationRetry(
      () =>
        generateWidgetContent(
          outline,
          async () => {
            calls++;
            return html('value = int(input())\n');
          },
          undefined,
          { userRequirements: requirements },
        ),
      {
        label: 'display completeness',
        maxRetries: 1,
        sleep: async () => {},
        shouldRetryResult: (value) => value === null,
      },
    );
    expect(result).toBeNull();
    expect(calls).toBe(2);
  });
  it('accepts complete displays, leaves ordinary output unchanged and forwards abort', async () => {
    expect(
      await generateWidgetContent(outline, async () => html(), undefined, {
        userRequirements: requirements,
      }),
    ).not.toBeNull();
    const value = html('value = int(input())\n');
    const ordinary = await generateWidgetContent(outline, async () => value);
    expect(ordinary).not.toBeNull();
    expect(ordinary?.html).toContain(block('original', 'value = int(input())\n'));
    const aborted = new DOMException('offline cancellation', 'AbortError');
    await expect(
      generateWidgetContent(
        outline,
        async () => {
          throw aborted;
        },
        undefined,
        { userRequirements: requirements },
      ),
    ).rejects.toBe(aborted);
  });
  it('keeps full source bytes in prompts and limits new boundary/quiz guidance to code-bound input', () => {
    const base = { system: 'system', user: 'user' };
    const bounded = buildSourceGroundedPrompt(base, requirements);
    const ordinary = buildSourceGroundedPrompt(base, {
      ...requirements,
      codeContextRequired: false,
    });
    expect(bounded.system).toContain('derive any claimed reachable range');
    expect(bounded.system).toContain('complete\nselected option text');
    expect(ordinary.system).not.toContain('derive any claimed reachable range');
    const data = JSON.parse(bounded.user.split(COURSE_SOURCE_DATA_MARKER)[1]);
    expect(data.codemateSource).toEqual(requirements.codemateSource);
  });
});
