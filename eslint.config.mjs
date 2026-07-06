import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Third-party / vendored packages (not our code):
    'packages/docs/**',
    'packages/mathml2omml/**',
    'packages/pptxgenjs/**',
    // Our own @openmaic/* packages: lint the source, but skip build output,
    // installed deps, and the vendored JS sources under importer/src1.
    'packages/@openmaic/*/dist/**',
    'packages/@openmaic/*/node_modules/**',
    'packages/@openmaic/importer/src1/**',
    // Generated importer bundle copied into public/ by the sync script (postinstall):
    'public/vendor/**',
    // Claude Code local files:
    '.claude/**',
    '.superpowers/**',
    '.worktrees/**',
    // Playwright e2e tests (not React code):
    'e2e/**',
  ]),
  {
    rules: {
      // Dynamic AI-generated image URLs from various providers are incompatible
      // with next/image (requires known dimensions and whitelisted domains).
      '@next/next/no-img-element': 'off',
      // Allow unused vars/args prefixed with _ (common convention for intentionally
      // unused destructured values, callback params, etc.)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  // Package boundary (machine-enforced): @openmaic/renderer is a standalone,
  // app-agnostic package. It must never reach back into the host app through
  // the `@/…` path alias, so a deadline can't punch a "temporary"
  // store/undo/media dependency through the package API. Host concerns
  // (document + undo ownership, media resolution, i18n, hotkeys) are injected
  // via props/callbacks instead.
  //
  // Policy: the package must contain NO `@/…` path-alias string at all. `@/` is
  // exclusively the host-app import alias, and the package authors zero such
  // strings, so we match the string prefix wherever it appears rather than
  // chasing individual call shapes. This is complete against every single-literal
  // module-reference form — static / `import type` / `export … from`, dynamic
  // `import()`, `require()`, `require.resolve()`, `import.meta.resolve()`, their
  // computed-property (`require['resolve']`) and template-literal variants, and
  // string-concatenation operands (`'@/lib/' + x`) — because all of them contain
  // a `@/` literal. One rule, one report per violation.
  //
  // Out of scope (undecidable by lint, evasion-only): a specifier assembled
  // entirely from non-`@/` pieces (`'@' + '/x'`, a variable) and relative parent
  // escapes (`../../app`). Those are caught by building/publishing the package in
  // isolation (only `@openmaic/dsl` + declared peers external), not by this rule.
  {
    files: ['packages/@openmaic/renderer/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            '@openmaic/renderer must not reference a host-app path (@/…). This package authors no `@/…` strings — depend only on @openmaic/dsl and declared peers, and inject host concerns (stores, undo, media resolution, i18n, hotkeys) via props/callbacks.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            '@openmaic/renderer must not reference a host-app path (@/…) in a template literal. Depend only on @openmaic/dsl and declared peers; inject host concerns via props/callbacks.',
        },
      ],
    },
  },
  // Package boundary (machine-enforced): @openmaic/storage is a standalone,
  // app-agnostic persistence package. Same policy as the @openmaic/renderer
  // boundary above — it must contain NO `@/…` host-app path-alias string, so a
  // deadline can't punch a "temporary" host dependency through the package API.
  // It depends only on @openmaic/dsl; host wiring (which store persists where)
  // lives in the app, which imports the package, never the reverse.
  {
    files: ['packages/@openmaic/storage/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            '@openmaic/storage must not reference a host-app path (@/…). This package authors no `@/…` strings — depend only on @openmaic/dsl. The app wires its stores through the package, not the reverse.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            '@openmaic/storage must not reference a host-app path (@/…) in a template literal. Depend only on @openmaic/dsl.',
        },
      ],
    },
  },
]);

export default eslintConfig;
