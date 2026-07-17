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
  // Module boundary (machine-enforced): lib/choreography is the shared
  // orchestration spec (timing + action timeline). It lives in the app (not a
  // package) because its semantics co-evolve with the playback engine, but it
  // must stay pure so the classroom-video exporter can interpret it in a pure
  // Node environment. Two guards, mirroring the package boundaries above:
  //   1. NO `@/…` host-app path-alias string — it authors none; it depends only
  //      on @openmaic/dsl (types + the fire-and-forget partition) and relative
  //      siblings. The app and exporter import it, never the reverse.
  //   2. NO React / DOM / render-backend runtime import (react, react-dom, gsap,
  //      framer-motion, motion) — these are bare specifiers the `@/` rule can't
  //      see. A descriptor describes animation; it never renders it.
  {
    files: ['lib/choreography/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            'lib/choreography must not reference a host-app path (@/…). It authors no `@/…` strings — depend only on @openmaic/dsl and relative siblings, so the exporter can interpret it in pure Node. The app and exporter import it, not the reverse.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            'lib/choreography must not reference a host-app path (@/…) in a template literal. Depend only on @openmaic/dsl and relative siblings.',
        },
        // Import allowlist (static imports/re-exports): the ONLY permitted
        // sources are `@openmaic/dsl`(/subpaths), `zod`, and in-folder relatives
        // (`./…`). Anything else — a parent-escape `../…` reaching back into the
        // app, or any other bare package — fails. Enforced on Import/Export
        // source string nodes via a negative-lookahead so the guard is a true
        // allowlist, not a blocklist of known-bad names.
        {
          selector:
            'ImportDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/).+/]',
          message:
            'lib/choreography may import only from @openmaic/dsl, zod, or in-folder relatives (./…). No parent-escape (../…) into the app and no other packages — keep it pure so the exporter runs in plain Node.',
        },
        {
          selector:
            'ExportNamedDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/).+/]',
          message:
            'lib/choreography may re-export only from @openmaic/dsl, zod, or in-folder relatives (./…).',
        },
        {
          selector:
            'ExportAllDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/).+/]',
          message:
            'lib/choreography may re-export only from @openmaic/dsl, zod, or in-folder relatives (./…).',
        },
        // No dynamic import() or require() — they bypass the static allowlist and
        // can pull in a render backend at runtime.
        {
          selector: 'ImportExpression',
          message:
            'lib/choreography must not use dynamic import() — it bypasses the static import allowlist. Use a top-level import from @openmaic/dsl, zod, or a relative sibling.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            'lib/choreography must not use require() — it bypasses the static import allowlist.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                'react/*',
                'react-dom/*',
                'gsap',
                'gsap/*',
                'framer-motion',
                'motion',
                'motion/*',
              ],
              message:
                'lib/choreography must stay render-backend-agnostic (pure Node): no React / DOM / GSAP / framer-motion. It describes timing and animation as data; the app effect components and the exporter render it.',
            },
          ],
        },
      ],
    },
  },
  // Module boundary (machine-enforced): lib/video-export is the classroom-video
  // compiler (issue #864). It produces the VideoTimeline IR with pure passes and
  // must stay interpretable in pure Node (no FFmpeg / Chrome / DOM), so runtime
  // app state enters only through the injected TimingProbe / AssetSource. Guards,
  // mirroring lib/choreography: no `@/…` host path, no React/DOM/render backend,
  // no dynamic import()/require(), and an import-source allowlist.
  //
  // The relative-path allowance is DEPTH-SPECIFIC, because a single `../…` means
  // different things at different depths: from a module-root file it escapes the
  // module (`lib/video-export/../action` = `lib/action`), but from `passes/` it
  // stays inside (`lib/video-export/passes/../ir` = `lib/video-export/ir`). So
  // the boundary is split into two disjoint file scopes (root `*` does not match
  // `passes/`), each with its own source allowlist; everything else is shared and
  // duplicated verbatim.
  //
  // Root files — lib/video-export/*.ts: relative imports may only be `./…`
  // (children) or the declared cross-module dep `../choreography`. Any other
  // `../…` (e.g. `../action/engine`) escapes the module and is rejected.
  {
    files: ['lib/video-export/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            'lib/video-export must not reference a host-app path (@/…). Live app state enters only through the injected TimingProbe / AssetSource — depend only on @openmaic/dsl, zod, ../choreography, and relative siblings, so the compiler runs in pure Node.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            'lib/video-export must not reference a host-app path (@/…) in a template literal. Depend only on @openmaic/dsl, zod, ../choreography, and relative siblings.',
        },
        {
          selector:
            'ImportDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/choreography(\\/|$)).+/]',
          message:
            'lib/video-export root files may import only from @openmaic/dsl, zod, ../choreography, or in-module children (./…). A ../… into anything but ../choreography escapes the module and is rejected.',
        },
        {
          selector:
            'ExportNamedDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/choreography(\\/|$)).+/]',
          message:
            'lib/video-export root files may re-export only from @openmaic/dsl, zod, ../choreography, or in-module children (./…).',
        },
        {
          selector:
            'ExportAllDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/choreography(\\/|$)).+/]',
          message:
            'lib/video-export root files may re-export only from @openmaic/dsl, zod, ../choreography, or in-module children (./…).',
        },
        {
          selector: 'ImportExpression',
          message:
            'lib/video-export must not use dynamic import() — it bypasses the static import allowlist. Use a top-level import from @openmaic/dsl, zod, ../choreography, or a relative sibling.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            'lib/video-export must not use require() — it bypasses the static import allowlist.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                'react/*',
                'react-dom/*',
                'gsap',
                'gsap/*',
                'framer-motion',
                'motion',
                'motion/*',
              ],
              message:
                'lib/video-export must stay render-backend-agnostic (pure Node): no React / DOM / GSAP / framer-motion. The compiler emits the IR as data; the downstream Hyperframes emitter renders it.',
            },
          ],
        },
      ],
    },
  },
  // Pass files — lib/video-export/passes/**: one level deeper, so a single `../…`
  // reaches a module-root file and STAYS inside the module; only a two-level
  // `../../…` escapes, and that is allowed solely for `../../choreography`.
  {
    files: ['lib/video-export/passes/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            'lib/video-export must not reference a host-app path (@/…). Live app state enters only through the injected TimingProbe / AssetSource — depend only on @openmaic/dsl, zod, ../../choreography, and relative siblings, so the compiler runs in pure Node.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            'lib/video-export must not reference a host-app path (@/…) in a template literal. Depend only on @openmaic/dsl, zod, ../../choreography, and relative siblings.',
        },
        // `./…` (children) and a single `../…` (a pass reaching a module-root
        // file, which stays inside lib/video-export) are allowed; a two-level
        // `../../…` escape is rejected UNLESS it is exactly `../../choreography`.
        {
          selector:
            'ImportDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/\\.\\.\\/choreography(\\/|$)|\\.\\.\\/(?!\\.\\.\\/)).+/]',
          message:
            'lib/video-export passes may import only from @openmaic/dsl, zod, ../../choreography, or in-module relatives (./… or a single ../… that stays inside the module). A ../../ escape into the rest of the app is rejected.',
        },
        {
          selector:
            'ExportNamedDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/\\.\\.\\/choreography(\\/|$)|\\.\\.\\/(?!\\.\\.\\/)).+/]',
          message:
            'lib/video-export passes may re-export only from @openmaic/dsl, zod, ../../choreography, or in-module relatives.',
        },
        {
          selector:
            'ExportAllDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/\\.\\.\\/choreography(\\/|$)|\\.\\.\\/(?!\\.\\.\\/)).+/]',
          message:
            'lib/video-export passes may re-export only from @openmaic/dsl, zod, ../../choreography, or in-module relatives.',
        },
        {
          selector: 'ImportExpression',
          message:
            'lib/video-export must not use dynamic import() — it bypasses the static import allowlist. Use a top-level import from @openmaic/dsl, zod, ../../choreography, or a relative sibling.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            'lib/video-export must not use require() — it bypasses the static import allowlist.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                'react/*',
                'react-dom/*',
                'gsap',
                'gsap/*',
                'framer-motion',
                'motion',
                'motion/*',
              ],
              message:
                'lib/video-export must stay render-backend-agnostic (pure Node): no React / DOM / GSAP / framer-motion. The compiler emits the IR as data; the downstream Hyperframes emitter renders it.',
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
