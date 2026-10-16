import { describe, expect, it } from 'vitest';
import { checkWidgetIdentifiers } from '../src/widget-js-identifiers.js';
import { generateSceneContent, generateWidgetContent } from '../src/scene-generator.js';
import { withGenerationRetry } from '../src/generation-retry.js';
import type { SceneOutline, UserRequirements } from '../src/outline-types.js';

const document = (script: string, extra = '') =>
  `<!DOCTYPE html><html><body>${extra}<script>${script}</script></body></html>`;
const good = document('const value = 1; document.body.textContent = String(value);');
const bad = document('document.body.textContent = absentResult;');
const outline: SceneOutline = {
  id: 'identifier-check',
  type: 'interactive',
  title: 'Source observation',
  description: 'Preserve the supplied source and explain the state.',
  keyPoints: ['Distinguish declared values from other text'],
  order: 1,
  widgetType: 'simulation',
  widgetOutline: { concept: 'Source state' },
};
const requirements: UserRequirements = {
  requirement: 'Explain the complete source without executing it.',
  codeContextRequired: true,
  codemateSource: {
    title: 'Input and output',
    content: 'Read one integer and print it.\nSample input: 1\nSample output: 1\n',
    code: 'value = int(input())\nprint(value)\n',
    correctedCode: 'value = int(input())\nprint(value)\n',
    language: 'Python3',
    referenceValidation: { status: 'unknown', scope: 'not_supplied' },
  },
};

describe('non-executing compact widget identifier analysis', () => {
  it('rejects undeclared reads in callbacks and accepts an actual declaration', () => {
    const result = checkWidgetIdentifiers(
      document('document.addEventListener("click", () => { document.title = missingValue; });'),
    );
    expect(result).toMatchObject({ ok: false, kind: 'unbound-read', scriptIndex: 1, line: 1 });
    expect(
      checkWidgetIdentifiers(document('const missingValue = "x"; document.title = missingValue;')),
    ).toMatchObject({ ok: true });
  });

  it('distinguishes properties, labels, interpolation and safe unary probes', () => {
    expect(
      checkWidgetIdentifiers(
        document('outer: for (;;) { const x = { key: 1 }; x.key; break outer; }'),
      ),
    ).toMatchObject({ ok: true });
    for (const code of [
      '({ missingValue });',
      '({ key: missingValue });',
      'Math[missingValue];',
      '`x${missingValue}`;',
      'typeof missingValue.member;',
      'typeof missingValue();',
    ])
      expect(checkWidgetIdentifiers(document(code))).toMatchObject({
        ok: false,
        kind: 'unbound-read',
      });
    expect(
      checkWidgetIdentifiers(document('typeof missingValue; delete missingValue;')),
    ).toMatchObject({ ok: true });
  });

  it('uses lexical scopes for defaults, destructuring, catches, classes and closures', () => {
    expect(
      checkWidgetIdentifiers(
        document(
          'function outer({ value: local = 1 } = {}) { try { throw new Error("x"); } catch (error) { class Inner { method() { return local + error.message.length; } } return new Inner().method(); } } window.example = outer;',
        ),
      ),
    ).toMatchObject({ ok: true });
    for (const code of [
      'function f(value = absentDefault) { return value; }',
      'function f(local) {} document.title = local;',
      '{ let blockOnly = 1; } document.title = blockOnly;',
    ])
      expect(checkWidgetIdentifiers(document(code))).toMatchObject({
        ok: false,
        kind: 'unbound-read',
      });
    expect(
      checkWidgetIdentifiers(document('{ function localLegacy() {} } localLegacy();')),
    ).toMatchObject({ ok: false, kind: 'unsupported' });
    expect(
      checkWidgetIdentifiers(
        document(
          '"use strict"; { function localOnly() {} localOnly(); } function outer() { function nested() {} nested(); } outer();',
        ),
      ),
    ).toMatchObject({ ok: true });
  });

  it('shares classic globals while keeping modules isolated', () => {
    const shared =
      '<script>let shared = 1; const fixed = 2; class Type {} function read() { return shared + fixed; } var legacy = 3;</script>';
    expect(checkWidgetIdentifiers(document('read(); new Type(); legacy;', shared))).toMatchObject({
      ok: true,
      classicScripts: 2,
    });
    expect(
      checkWidgetIdentifiers(
        document('', shared + '<script type="MODULE">read(); new Type();</script>'),
      ),
    ).toMatchObject({ ok: true, moduleScripts: 1 });
    expect(
      checkWidgetIdentifiers(
        document('moduleLocal;', '<script type="module">const moduleLocal = 1;</script>'),
      ),
    ).toMatchObject({ ok: false, kind: 'unbound-read' });
    expect(
      checkWidgetIdentifiers(
        document(
          '',
          '<script type="module">const local = 1;</script><script type="module">local;</script>',
        ),
      ),
    ).toMatchObject({ ok: false, kind: 'unbound-read' });
  });

  it('uses real active DOM names and skips data/inert scripts', () => {
    expect(
      checkWidgetIdentifiers(
        document(
          'Math.max(1, 2); setTimeout(() => {}, 1); liveSvg; namedForm;',
          '<svg id="liveSvg"></svg><form name="namedForm"></form>',
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(
      checkWidgetIdentifiers(
        document(
          '',
          '<script type="application/json">{ invalidJs: true }</script><template><script>missing;</script></template><noscript><script>missing;</script></noscript>',
        ),
      ),
    ).toMatchObject({ ok: true, classicScripts: 1 });
    for (const [name, extra] of [
      ['inertName', '<template><div id="inertName"></div></template>'],
      ['ordinaryName', '<div name="ordinaryName"></div>'],
      ['require', ''],
      ['process', ''],
    ])
      expect(checkWidgetIdentifiers(document(`${name};`, extra))).toMatchObject({
        ok: false,
        kind: 'unbound-read',
      });
    expect(
      checkWidgetIdentifiers(
        document('', '<svg><template><script>missing;</script></template></svg>'),
      ),
    ).toMatchObject({ ok: false, kind: 'unsupported' });
    expect(
      checkWidgetIdentifiers(
        document('', '<svg><script type="application/json">{}</script></svg>'),
      ),
    ).toMatchObject({ ok: false, kind: 'unsupported' });
    for (const attributes of [
      'type="text/javascript; charset=utf-8"',
      'type=" "',
      'language="javascript "',
      'type=" module "',
    ])
      expect(
        checkWidgetIdentifiers(document('ghost;', `<script ${attributes}>var ghost = 1;</script>`)),
      ).toMatchObject({ ok: false, kind: 'unbound-read' });
    expect(
      checkWidgetIdentifiers(
        document('ghost;', '<script type=" text/javascript ">var ghost = 1;</script>'),
      ),
    ).toMatchObject({ ok: true });
    expect(
      checkWidgetIdentifiers(document('', '<script nomodule src="/ignored.js">missing;</script>')),
    ).toMatchObject({ ok: true, classicScripts: 1 });
  });

  it('fails closed on unsupported executable environments and distinguishes writes', () => {
    for (const extra of [
      '<script src="/remote.js"></script>',
      '<script type="module">import x from "./remote.js";</script>',
      '<script type="importmap">{}</script>',
      '<button onclick="missing()">Go</button>',
      '<iframe srcdoc="hi"></iframe>',
      '<a href="javascript:missing()">Go</a>',
    ])
      expect(checkWidgetIdentifiers(document('', extra))).toMatchObject({
        ok: false,
        kind: 'unsupported',
      });
    expect(
      checkWidgetIdentifiers(
        document('ghost;', '<script for="other" event="onload">var ghost;</script>'),
      ),
    ).toMatchObject({ ok: false, kind: 'unsupported' });
    for (const code of [
      'eval("x");',
      'new Function("x");',
      'import("./x.js");',
      'setTimeout("x", 1);',
      'with ({}) {}',
    ])
      expect(checkWidgetIdentifiers(document(code))).toMatchObject({
        ok: false,
        kind: 'unsupported',
      });
    expect(checkWidgetIdentifiers(document('missingWrite = 1;'))).toMatchObject({
      ok: false,
      kind: 'implicit-global-write-unsupported',
    });
    expect(checkWidgetIdentifiers(document('"use strict"; missingWrite = 1;'))).toMatchObject({
      ok: false,
      kind: 'unresolvable-write',
    });
    expect(checkWidgetIdentifiers(document('missingWrite++;'))).toMatchObject({
      ok: false,
      kind: 'unbound-read',
    });
    expect(checkWidgetIdentifiers(document('const = ;'))).toMatchObject({
      ok: false,
      kind: 'syntax',
    });
  });

  it('enforces complete UTF-8/script/node limits without truncating to a pass', () => {
    expect(checkWidgetIdentifiers(document('', 'é'.repeat(524_288)))).toMatchObject({
      ok: false,
      kind: 'limit',
    });
    expect(checkWidgetIdentifiers(document('', '<script></script>'.repeat(64)))).toMatchObject({
      ok: false,
      kind: 'limit',
      scriptIndex: 65,
    });
    expect(
      checkWidgetIdentifiers(
        document('', '<script type="application/json">{}</script>'.repeat(65)),
      ),
    ).toMatchObject({ ok: true, classicScripts: 1 });
    expect(checkWidgetIdentifiers(document('0;'.repeat(50_001)))).toMatchObject({
      ok: false,
      kind: 'limit',
    });
  });
});

describe('actual generation entry failure contract', () => {
  it('returns null/failure from both entry points with no repair or additional call', async () => {
    for (const entry of ['scene', 'widget']) {
      let calls = 0;
      const failures: unknown[] = [];
      const callback = async () => {
        calls += 1;
        return bad;
      };
      const options = {
        userRequirements: requirements,
        onFailure: (value: unknown) => failures.push(value),
      };
      const content =
        entry === 'scene'
          ? await generateSceneContent(outline, callback, options)
          : await generateWidgetContent(outline, callback, undefined, options);
      expect(content).toBeNull();
      expect(calls).toBe(1);
      expect(failures).toEqual([{ code: 'invalid-model-output' }]);
    }
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
    await expect(
      generateSceneContent(
        outline,
        async () => {
          throw aborted;
        },
        { userRequirements: requirements },
      ),
    ).rejects.toBe(aborted);
  });

  it('retains ordinary behavior and the existing null retry bound', async () => {
    expect(await generateWidgetContent(outline, async () => bad)).not.toBeNull();
    expect(
      await generateWidgetContent(outline, async () => good, undefined, {
        userRequirements: requirements,
      }),
    ).not.toBeNull();
    let calls = 0;
    const result = await withGenerationRetry(
      () =>
        generateWidgetContent(
          outline,
          async () => {
            calls += 1;
            return bad;
          },
          undefined,
          { userRequirements: requirements },
        ),
      {
        label: 'offline null-bound check',
        maxRetries: 1,
        shouldRetryResult: (value) => value === null,
        sleep: async () => {},
      },
    );
    expect(result).toBeNull();
    expect(calls).toBe(2);
    const signal = AbortSignal.abort();
    await expect(
      withGenerationRetry(
        async () => {
          calls += 1;
          return null;
        },
        { label: 'cancelled', signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(2);
  });
});
