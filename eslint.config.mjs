import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// The AI SDK must be reached only through callLLM / streamLLM in lib/ai/llm.ts
// (#1003). Static and namespace imports are handled by
// @typescript-eslint/no-restricted-imports further down; a DYNAMIC import is an
// ImportExpression, which no-restricted-imports cannot see, so it needs
// no-restricted-syntax. That key is configured per-block and flat config replaces
// rule options rather than merging them, so the ban lives here and is spread into
// every block that sets the key, instead of one repo-wide block that would
// silently drop those blocks' own module boundaries.
const AI_SDK_DYNAMIC_IMPORT_BAN = [
  {
    selector: "ImportExpression > Literal[value='ai']",
    message:
      "Call the model through callLLM / streamLLM in @/lib/ai/llm instead of importing the AI SDK dynamically. A dynamic import('ai') reaches the same generateText / streamText and skips usage accounting, the LLM_THINKING_DISABLED kill switch and per-provider thinking resolution.",
  },
  {
    selector: "ImportExpression > TemplateLiteral > TemplateElement[value.cooked='ai']",
    message:
      'Call the model through callLLM / streamLLM in @/lib/ai/llm instead of importing the AI SDK dynamically (template-literal form of the same bypass).',
  },
];

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
    '.scratch/**',
    // Playwright e2e tests (not React code):
    'e2e/**',
    // Isolated MP4 render service: its own package, tsconfig, and Node-only
    // deps (@hyperframes/producer). Linted/typechecked under render-service/.
    'render-service/**',
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
        ...AI_SDK_DYNAMIC_IMPORT_BAN,
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
        ...AI_SDK_DYNAMIC_IMPORT_BAN,
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
  // Single LLM entry point (machine-enforced): server-side model calls go through
  // `callLLM` / `streamLLM` in lib/ai/llm.ts. That wrapper is where usage
  // accounting (`recordUsage`), the `LLM_THINKING_DISABLED` kill switch, and
  // per-provider thinking resolution live — a direct `generateText` / `streamText`
  // silently opts out of all three, and the opt-out is invisible at the call site.
  // The PBL v2 runtime drifted exactly this way (#1003): five direct calls meant
  // zero usage records for the busiest traffic in the product, plus three
  // different meanings for one thinking config.
  //
  // The rule uses the @typescript-eslint variant deliberately: the base
  // `no-restricted-imports` is already configured for lib/choreography and
  // lib/video-export, and flat config REPLACES a rule's options per key rather
  // than merging them, so reusing that key here would silently drop those
  // module-boundary bans. Different key, no interference.
  //
  // Every reachable import form is covered, verified by feeding each one to
  // eslint rather than assumed:
  //   - `import { streamText } from 'ai'`  → this rule
  //   - `import * as ai from 'ai'`         → this rule too; ESLint reports a
  //     namespace import when `importNames` is set, since the namespace would
  //     carry the restricted name
  //   - `require('ai')`                    → the repo-wide
  //     `@typescript-eslint/no-require-imports` (inherited from
  //     eslint-config-next/typescript) already forbids require() anywhere
  //   - `await import('ai')`               → the no-restricted-syntax block below
  // An `eslint-disable` comment defeats any of them, which is the point: the
  // bypass has to be written down where a reviewer sees it.
  //
  // Scope is every linted source extension, matching the module-boundary blocks
  // above — NOT just ts/tsx. An earlier revision guarded only ts/tsx, which left
  // `app/api/route.js` and `scripts/*.mjs` free to import the SDK; review caught
  // it. tests/lint-llm-entry-guard.test.ts pins the whole matrix so the scope
  // cannot quietly narrow again.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: [
      // The entry point itself.
      'lib/ai/llm.ts',
      // Offline harnesses and a test whose subject IS the SDK: not server request
      // paths, nothing to account for, and the integration test must be able to
      // call the raw SDK to assert what the wrapper is built on.
      'eval/**',
      'tests/**',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'ai',
              importNames: ['generateText', 'streamText'],
              message:
                'Call the model through callLLM / streamLLM in @/lib/ai/llm instead of the AI SDK directly — that is where usage accounting, the LLM_THINKING_DISABLED kill switch, and per-provider thinking resolution are applied. Both wrappers pass every SDK option straight through, and take an optional per-call thinking config.',
            },
          ],
        },
      ],
    },
  },
  // Same boundary, dynamic form. This block cannot match the files of the five
  // blocks above that also set no-restricted-syntax (flat config replaces rule
  // options per key, so it would drop their module boundaries), hence the ignores.
  // Every ignored directory is nonetheless covered, and covered by a rule rather
  // than by an argument:
  //   - packages/@openmaic/renderer, packages/@openmaic/storage — the same
  //     AI_SDK_DYNAMIC_IMPORT_BAN is spread into their own blocks above. An earlier
  //     revision left them out on the reasoning that they are built in isolation
  //     against @openmaic/dsl; review showed `void import('ai')` under the renderer
  //     source path passing lint, which is exactly why that reasoning was not good
  //     enough.
  //   - lib/choreography, lib/video-export — their blocks ban EVERY
  //     ImportExpression outright, which subsumes this one.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: [
      'lib/ai/llm.ts',
      'eval/**',
      'tests/**',
      // Blocks above that configure no-restricted-syntax for their own boundary.
      'lib/choreography/**',
      'lib/video-export/**',
      'packages/@openmaic/renderer/**',
      'packages/@openmaic/storage/**',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...AI_SDK_DYNAMIC_IMPORT_BAN],
    },
  },
]);

export default eslintConfig;
