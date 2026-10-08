import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findEngineImports, findUnsafeRenderUses, usesAutoRenderText } from './math-engine-guard';

/**
 * Every source file that can reach a math renderer, and why it is allowed to.
 *
 * - `render-calls`: imports KaTeX/Temml directly; every use must be a render
 *   call whose options are `safeKatexOptions(...)` (checked below).
 * - `reviewed`: reaches a renderer some other way; the reason says why it is
 *   safe and where that is tested.
 */
const ALLOWLIST: Record<string, { kind: 'render-calls' | 'reviewed'; reason: string }> = {
  'lib/action/engine.ts': { kind: 'render-calls', reason: 'whiteboard latex actions' },
  'lib/chat/pi/tools/native-whiteboard.ts': {
    kind: 'render-calls',
    reason: 'agent whiteboard tool',
  },
  'lib/edit/slide-edit-elements.ts': { kind: 'render-calls', reason: 'slide latex elements' },
  'lib/export/latex-to-omml.ts': { kind: 'render-calls', reason: 'PPTX export via Temml' },
  'lib/export/standalone-html/rich-text.ts': {
    kind: 'render-calls',
    reason: 'standalone HTML inline math',
  },
  'lib/quiz/math-text.ts': {
    kind: 'render-calls',
    reason: 'quiz math (also the standalone player)',
  },
  'packages/@openmaic/editor/src/react/text/prosemirror/schema/inlineMath.ts': {
    kind: 'render-calls',
    reason: 'editor inline math node',
  },
  'packages/@openmaic/editor/src/ui/latex/latex-editor.ts': {
    kind: 'render-calls',
    reason: 'editor latex dialog',
  },
  'packages/@openmaic/generation/src/scene-generator.ts': {
    kind: 'render-calls',
    reason: 'generated latex elements',
  },
  'packages/@openmaic/importer/src/import-pipeline/transformParsedToSlides.ts': {
    kind: 'render-calls',
    reason: 'imported formulas',
  },
  'packages/@openmaic/importer/src/serializer/textSerializer.ts': {
    kind: 'render-calls',
    reason: 'imported inline formulas',
  },
  'lib/markdown/safe-math-plugin.ts': {
    kind: 'reviewed',
    reason:
      'wraps @streamdown/math and replaces its rehype-katex options with safeKatexOptions; ' +
      'covered by the workbench chat paths in safe-math-render.test.ts',
  },
  'packages/@openmaic/generation/src/interactive-post-processor.ts': {
    kind: 'reviewed',
    reason:
      'injects KaTeX auto-render into generated interactive HTML. That page already runs ' +
      'arbitrary model-written scripts in a sandboxed iframe, so a formula there has no more ' +
      'power than the page itself',
  },
};

const NON_PRODUCT_PATH_RE = /(^|\/)(tests?|__tests__|__snapshots__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

function productSources(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.mts', '*.cts'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .filter(Boolean)
    .filter((file) => !NON_PRODUCT_PATH_RE.test(file));
}

describe('math engine guard recognizes every import shape', () => {
  const imports = (source: string, fileName = 'fixture.ts') =>
    findEngineImports(fileName, source).map((entry) => `${entry.shape} ${entry.specifier}`);

  it.each([
    ["import katex from 'katex';", 'import katex'],
    ["import k from 'katex';", 'import katex'],
    ["import * as K from 'katex';", 'import katex'],
    ["import { renderToString } from 'katex';", 'import katex'],
    ["import { default as kk } from 'katex';", 'import katex'],
    ["import 'katex/contrib/auto-render';", 'side-effect import katex/contrib/auto-render'],
    [
      "import renderMathInElement from 'katex/contrib/auto-render';",
      'import katex/contrib/auto-render',
    ],
    ["import katex = require('katex');", 'import = require katex'],
    ["export * from 'katex';", 're-export katex'],
    ["export { default as k } from 'temml';", 're-export temml'],
    ["const k = await import('katex');", 'dynamic import katex'],
    ["const k = require('katex');", 'require katex'],
    ["import temml from 'temml';", 'import temml'],
    ["import rehypeKatex from 'rehype-katex';", 'import rehype-katex'],
    ["import remarkMath from 'remark-math';", 'import remark-math'],
    ["import { createMathPlugin } from '@streamdown/math';", 'import @streamdown/math'],
    ["import { math } from '@streamdown/math';", 'import @streamdown/math'],
  ])('%s', (source, expected) => {
    expect(imports(source)).toEqual([expected]);
  });

  it('ignores type-only imports and asset subpaths', () => {
    expect(
      imports(
        [
          "import type { KatexOptions } from 'katex';",
          "import { type KatexOptions } from 'katex';",
          "import 'katex/dist/katex.min.css';",
          "const pkg = require('katex/package.json');",
          "const dir = require.resolve('katex/package.json');",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('detects auto-render injected as script text', () => {
    expect(usesAutoRenderText('const s = "renderMathInElement(document.body)";')).toBe(true);
    expect(usesAutoRenderText('<script src="katex/dist/contrib/auto-render.min.js">')).toBe(true);
    expect(usesAutoRenderText('const x = 1;')).toBe(false);
  });
});

describe('render-call check rejects every bypass', () => {
  const header = "import katex from 'katex';\nimport { safeKatexOptions } from '@openmaic/dsl';\n";

  it('accepts render calls whose options are safeKatexOptions(...)', () => {
    expect(
      findUnsafeRenderUses(
        'ok.ts',
        `${header}import temml from 'temml';\nkatex.renderToString(a, safeKatexOptions({ displayMode: true }));\n` +
          'katex.render(a, host, safeKatexOptions());\n' +
          'temml.renderToString(a, safeKatexOptions());\n' +
          'let t: typeof katex;\n',
      ),
    ).toEqual([]);
  });

  it('accepts an aliased import of the helper', () => {
    expect(
      findUnsafeRenderUses(
        'ok.ts',
        "import * as K from 'katex';\nimport { safeKatexOptions as safe } from '@openmaic/dsl';\n" +
          'K.renderToString(a, safe());',
      ),
    ).toEqual([]);
  });

  it.each([
    ['plain options', `${header}katex.renderToString(a, { displayMode: true });`],
    ['no options', `${header}katex.renderToString(a);`],
    ['options built elsewhere', `${header}const o = safeKatexOptions(); katex.render(a, h, o);`],
    ['aliased binding', "import k from 'katex';\nk.renderToString(a, {});"],
    ['namespace binding', "import * as K from 'katex';\nK.renderToString(a, {});"],
    ['escaped binding', `${header}const r = katex.renderToString; r(a);`],
    ['passed along', `${header}use(katex);`],
    ['named import', "import { renderToString } from 'katex';\nrenderToString(a, {});"],
    ['aliased default', "import { default as kk } from 'katex';\nkk.renderToString(a, {});"],
    ['other engine module', "import renderMath from 'katex/contrib/auto-render';"],
    ['temml without helper', "import temml from 'temml';\ntemml.renderToString(a);"],
    [
      'require binding',
      `${header}const k = require('katex');\nk.renderToString(a, safeKatexOptions());`,
    ],
    [
      'dynamic import binding',
      `${header}const k = await import('katex');\nk.default.renderToString(a, safeKatexOptions());`,
    ],
    ['re-export', `${header}export { default as k } from 'katex';`],
    ['import = require', `import k = require('katex');\nk.renderToString(a, {});`],
    ['side-effect import', `${header}import 'katex/contrib/auto-render';`],
    ['helper in the wrong position (render)', `${header}katex.render(a, safeKatexOptions(), {});`],
    [
      'helper after the options (renderToString)',
      `${header}katex.renderToString(a, {}, safeKatexOptions());`,
    ],
    ['element passed as options', `${header}katex.render(a, safeKatexOptions());`],
    [
      'helper not imported from the dsl',
      "import katex from 'katex';\nconst safeKatexOptions = (o) => o;\nkatex.renderToString(a, safeKatexOptions({}));",
    ],
    [
      'helper shadowed locally',
      `${header}function f(safeKatexOptions) { return katex.renderToString(a, safeKatexOptions({})); }`,
    ],
  ])('%s', (_name, source) => {
    expect(findUnsafeRenderUses('bad.ts', source)).not.toEqual([]);
  });
});

describe('every math render in the product goes through safeKatexOptions', () => {
  const sources = productSources();
  const reaching = sources.filter((file) => {
    const source = readFileSync(file, 'utf8');
    if (!/katex|temml|math|mathjax|auto-render/i.test(source)) return false;
    return findEngineImports(file, source).length > 0 || usesAutoRenderText(source);
  });

  it('scans a plausible set of files', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(reaching.length).toBeGreaterThanOrEqual(10);
  });

  it('allows only reviewed files to reach a renderer', () => {
    const unexpected = reaching.filter((file) => !(file in ALLOWLIST));
    expect(unexpected, 'add a safeKatexOptions call site or a reviewed entry').toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    expect(Object.keys(ALLOWLIST).filter((file) => !reaching.includes(file))).toEqual([]);
  });

  for (const [file, entry] of Object.entries(ALLOWLIST)) {
    if (entry.kind !== 'render-calls') continue;
    it(`${file} renders only through safeKatexOptions`, () => {
      expect(findUnsafeRenderUses(file, readFileSync(file, 'utf8'))).toEqual([]);
    });
  }
});
