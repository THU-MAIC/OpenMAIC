import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

/**
 * Executable contract for the single-LLM-entry-point lint guard (#1003).
 *
 * The guard is the thing that keeps `generateText` / `streamText` reachable only
 * through `callLLM` / `streamLLM` in `lib/ai/llm.ts`. Its weak spot is not the
 * rules — it is their SCOPE, and review found three separate holes in it: two
 * `@openmaic` package directories excluded from the dynamic-import ban, and both
 * blocks matching only `ts,tsx` so a `route.js` or a `scripts/*.mjs` could import
 * the SDK freely.
 *
 * Each hole was closed and then verified by hand, which is exactly the process
 * that produced the next hole. So the matrix lives here instead: every import
 * form — including `require('ai')`, which an inherited repo-wide rule happens to
 * cover — × every source extension × the production paths that must be covered
 * and the paths that are deliberately exempt. A future edit that narrows `files`,
 * adds an `ignores` entry, or swaps the rule key fails this test rather than
 * quietly reopening the door.
 *
 * Runs the real eslint against the real `eslint.config.mjs` on in-memory text, so
 * there is no fixture drift and nothing is written to the tree.
 */

const BYPASS_FORMS = {
  named: "import { streamText } from 'ai';\nexport const a = streamText;\n",
  namespace: "import * as ai from 'ai';\nexport const a = ai.generateText;\n",
  dynamic: "export async function a() {\n  return import('ai');\n}\n",
  dynamicTemplate: 'export async function a() {\n  return import(`ai`);\n}\n',
  // Blocked by the inherited repo-wide `@typescript-eslint/no-require-imports`
  // rather than by the guard's own rules. Pinned here anyway: if that rule is ever
  // relaxed (allowing require in .cjs, say), this row goes red and whoever relaxes
  // it has to add an explicit `'ai'` selector instead of silently reopening the door.
  require: "const ai = require('ai');\nmodule.exports = ai;\n",
} as const;

/** The guard's own rules. Guarded paths assert the PROPERTY (the import is
 *  rejected, by whichever rule); exempt paths assert specifically that these two
 *  do not fire, since an unrelated repo-wide rule legitimately may. */
const GUARD_RULES = ['@typescript-eslint/no-restricted-imports', 'no-restricted-syntax'];

/** Production paths: an SDK import here must be an error. */
const GUARDED_PATHS = [
  'lib/pbl/v2/agents/probe',
  'lib/server/probe',
  'app/api/probe/route',
  'components/probe',
  'packages/@openmaic/renderer/src/probe',
  'packages/@openmaic/storage/src/probe',
  'packages/@openmaic/generation/src/probe',
  'lib/choreography/probe',
  'lib/video-export/probe',
  'scripts/probe',
] as const;

/** Deliberate exemptions: the entry point itself, offline harnesses, and tests. */
const EXEMPT_PATHS = ['lib/ai/llm', 'eval/probe', 'tests/probe'] as const;

const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] as const;

const eslint = new ESLint({ cwd: process.cwd() });

async function errorsFor(filePath: string, code: string): Promise<string[]> {
  // A path ESLint would ignore (build output, vendored trees) returns no result;
  // treat that as "not covered" so an ignored path can never look like a pass.
  if (await eslint.isPathIgnored(filePath)) return ['<path is eslint-ignored>'];
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => m.ruleId ?? 'unknown');
}

describe('LLM entry-point lint guard — coverage matrix', () => {
  for (const [form, code] of Object.entries(BYPASS_FORMS)) {
    for (const ext of EXTENSIONS) {
      // A namespace or named import of a value is not valid in a .cjs/.mjs mix
      // only in principle; eslint parses all of these fine, so no exclusions.
      it(`blocks the ${form} import in every guarded path (.${ext})`, async () => {
        for (const base of GUARDED_PATHS) {
          const filePath = `${base}.${ext}`;
          const errors = await errorsFor(filePath, code);
          expect(errors, `${filePath} should reject the ${form} form`).not.toHaveLength(0);
        }
      });
    }
  }

  it('leaves the entry point, eval harnesses and tests exempt', async () => {
    for (const base of EXEMPT_PATHS) {
      for (const [form, code] of Object.entries(BYPASS_FORMS)) {
        const filePath = `${base}.ts`;
        const errors = await errorsFor(filePath, code);
        expect(
          errors.filter((rule) => GUARD_RULES.includes(rule)),
          `${filePath} should not trip the LLM entry-point guard on the ${form} form`,
        ).toEqual([]);
      }
    }
  });

  it('still enforces the pre-existing module boundaries it shares a rule key with', async () => {
    // The dynamic-import ban uses `no-restricted-syntax`, a key several boundary
    // blocks configure. Flat config REPLACES rule options per key, so a careless
    // edit to the guard silently deletes those boundaries — assert two of them.
    const hostPathImport = "import x from '@/lib/foo';\nexport default x;\n";
    for (const filePath of [
      'packages/@openmaic/renderer/src/probe.ts',
      'packages/@openmaic/storage/src/probe.ts',
      'packages/@openmaic/generation/src/probe.ts',
      'lib/choreography/probe.ts',
    ]) {
      const errors = await errorsFor(filePath, hostPathImport);
      expect(errors, `${filePath} must still reject a host-app @/ import`).toContain(
        'no-restricted-syntax',
      );
    }

    const reactImport = "import 'react';\nexport const a = 1;\n";
    const choreographyErrors = await errorsFor('lib/choreography/probe.ts', reactImport);
    expect(choreographyErrors).toContain('no-restricted-imports');
  });
});
