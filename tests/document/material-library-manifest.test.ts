import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Browser-safety contract for the material library manifest (RFC #1153 part 2).
 *
 * `lib/materials/library.ts` is a client-reachable module: the upload page
 * (`app/page.tsx`) mints entries at ingest, and `lib/document/extraction-cache.ts`
 * (also client-reachable) records derivation pointers. If it — or anything it
 * transitively imports — ever reaches a server-only dependency, the
 * server-only chain (sharp / @alicloud/* / child_process / fs / net, pulled in
 * through the provider implementations or the server persistence backend)
 * leaks back into the client bundle and the production build breaks exactly
 * like the failure the extractor manifest was created to fix. This test pins
 * the library's import GRAPH, mirroring
 * `tests/document/extractor-manifest.test.ts`.
 *
 * One deliberate relaxation vs. the extractor-manifest guard: the library
 * legitimately depends on the persistence bootstrap (`NEXT_PUBLIC_PERSISTENCE`
 * env reads) and the shared logger (`LOG_LEVEL` / `LOG_FORMAT` env reads),
 * both of which already ship to the client bundle today through the
 * extraction-cache module. `process.env.NEXT_PUBLIC_*` is inlined by Next.js;
 * the others degrade to `undefined` at runtime. Those specific patterns are
 * stripped before the `process.` global check; a `process` reference that
 * names something else (e.g. `DATABASE_URL`) would still fail.
 */

const REPO_ROOT = resolve(process.cwd());
const LIBRARY_PATH = resolve(REPO_ROOT, 'lib/materials/library.ts');

/** Import signatures that must never appear in the library's transitive import graph. */
const FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /from\s+['"]sharp['"]/,
  /require\(['"]sharp['"]\)/,
  /@alicloud\//,
  /child_process/,
  /from\s+['"](?:node:)?fs['"]/,
  /require\(['"](?:node:)?fs['"]\)/,
  /from\s+['"](?:node:)?net['"]/,
  /require\(['"](?:node:)?net['"]\)/,
  /from\s+['"](?:node:)?stream['"]/,
  /require\(['"](?:node:)?stream['"]\)/,
  /from\s+['"]unpdf['"]/,
  /from\s+['"]detect-libc['"]/,
];

/**
 * Node-only globals: a browser bundle cannot provide these at runtime. Only
 * enforced in files with actual runtime code — a type-only module is erased at
 * compile time. `process.env.NEXT_PUBLIC_*` and `process.env.LOG_*` reads are
 * the documented, already-shipping client-safe exceptions (see the file
 * docstring) and are stripped before matching.
 */
const FORBIDDEN_RUNTIME_GLOBALS: RegExp[] = [
  /\bprocess\.(?!env\.NEXT_PUBLIC_|env\.LOG_)/,
  /\bBuffer\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
];

/** Whether the file contains runtime code (as opposed to pure type declarations). */
const HAS_RUNTIME_CODE = /\b(?:const|let|var|function|class|enum)\b/;

/** Strip block and line comments so docstring mentions can't trip the guard. */
function stripComments(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Line comments, keeping `https://`-style sequences (a `//` preceded by `:`) intact.
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  );
}

/** Every static and dynamic import specifier in a source file. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticRe = /import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = staticRe.exec(source)) !== null) specifiers.push(match[1]);
  const dynamicRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicRe.exec(source)) !== null) specifiers.push(match[1]);
  // `export … from '…'` re-exports are import-graph edges too: a server-only
  // module re-exported through a client-reachable file would otherwise slip
  // past the graph scan entirely and rely on `pnpm build` alone.
  const reexportRe = /export\s+(?:type\s+)?(?:\*|\{[^}]*\})[^;]*?from\s+['"]([^'"]+)['"]/g;
  while ((match = reexportRe.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

function violationsIn(source: string): string[] {
  const stripped = stripComments(source);
  const importViolations = FORBIDDEN_IMPORT_PATTERNS.filter((pattern) =>
    pattern.test(stripped),
  ).map((pattern) => pattern.source);
  // Node globals only matter in runtime code; type-only modules are erased.
  if (!HAS_RUNTIME_CODE.test(stripped)) return importViolations;
  const globalViolations = FORBIDDEN_RUNTIME_GLOBALS.filter((pattern) =>
    pattern.test(stripped),
  ).map((pattern) => pattern.source);
  return [...importViolations, ...globalViolations];
}

/** Resolve a relative TS import specifier to a real file (extensions are implicit). */
function resolveTsImport(fromDir: string, specifier: string): string | null {
  const base = resolve(fromDir, specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return (
    candidates.find((candidate) => {
      try {
        readFileSync(candidate, 'utf8');
        return true;
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** Depth-first scan of the library's import graph; returns path → violations. */
function scanGraph(
  entryPath: string,
  visited = new Set<string>(),
  violations = new Map<string, string[]>(),
): Map<string, string[]> {
  const absolutePath = isAbsolute(entryPath) ? entryPath : resolve(REPO_ROOT, entryPath);
  if (visited.has(absolutePath)) return violations;
  visited.add(absolutePath);

  const source = readFileSync(absolutePath, 'utf8');
  const fileViolations = violationsIn(source);
  if (fileViolations.length > 0) violations.set(absolutePath, fileViolations);

  for (const specifier of importSpecifiers(source)) {
    if (!specifier.startsWith('.')) continue; // package imports are guarded above
    const child = resolveTsImport(dirname(absolutePath), specifier);
    if (child) scanGraph(child, visited, violations);
  }
  return violations;
}

describe('material library manifest — browser-safe import graph', () => {
  it('keeps the library and every transitive dependency free of server-only code', () => {
    const violations = scanGraph(LIBRARY_PATH);
    expect(
      [...violations.entries()].map(([file, patterns]) => `${file}: ${patterns.join(', ')}`),
    ).toEqual([]);
  });

  it('descends into `export … from` re-export specifiers (a re-exported server-only module is still a violation)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'material-library-manifest-'));
    try {
      const reexport = join(tmpDir, 'reexport.ts');
      const poison = join(tmpDir, 'poison.ts');
      // The forbidden dependency is reachable ONLY through an `export … from`
      // re-export — the exact edge the re-export scan must follow.
      writeFileSync(poison, `import sharp from 'sharp';\n`, 'utf8');
      writeFileSync(reexport, `export * from './poison';\n`, 'utf8');

      const violations = scanGraph(reexport);
      expect([...violations.entries()].some(([file]) => file === poison)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
