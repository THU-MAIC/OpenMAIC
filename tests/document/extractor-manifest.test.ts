import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Browser-safety contract for the extractor manifest (RFC #1153 part 1).
 *
 * `lib/document/extractors/manifest.ts` is the ONLY module the client pages may
 * use to resolve expected-extractor identity/version — if it (or anything it
 * transitively imports) ever reaches a server-only dependency, the server-only
 * chain (sharp / @alicloud/* / child_process / fs / net, pulled in through the
 * provider implementations) leaks back into the client bundle and the
 * production build breaks exactly like the failure this manifest was created
 * to fix. The sync test pins the manifest's CONTENT to the registries; this
 * test pins its import GRAPH: the manifest and every transitive dependency
 * must stay free of Node-only imports and Node-only globals.
 */

const REPO_ROOT = resolve(process.cwd());
const MANIFEST_PATH = resolve(REPO_ROOT, 'lib/document/extractors/manifest.ts');

/** Import signatures that must never appear in the manifest's transitive import graph. */
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
 * enforced in files with actual runtime code — a type-only module (pure
 * `interface`/`type` declarations) is erased at compile time, so a `Buffer`
 * in a type position (e.g. `buffer: Buffer`) can never leak into a bundle.
 */
const FORBIDDEN_RUNTIME_GLOBALS: RegExp[] = [
  /\bprocess\./,
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

/** Depth-first scan of the manifest's import graph; returns path → violations. */
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

describe('extractor manifest — browser-safe import graph', () => {
  it('keeps the manifest and every transitive dependency free of server-only code', () => {
    const violations = scanGraph(MANIFEST_PATH);
    expect(
      [...violations.entries()].map(([file, patterns]) => `${file}: ${patterns.join(', ')}`),
    ).toEqual([]);
  });

  it('imports only plain-data/type modules (never the provider implementations)', () => {
    const source = readFileSync(MANIFEST_PATH, 'utf8');
    const relativeImports = importSpecifiers(source).filter((s) => s.startsWith('.'));
    for (const specifier of relativeImports) {
      expect(
        specifier,
        `manifest must not import a provider implementation module: ${specifier}`,
      ).not.toMatch(/^\.\/(?:pdf|text|media|registry|media-registry)$/);
    }
  });
});
