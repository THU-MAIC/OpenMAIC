import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOTS = ['app', 'components', 'lib', 'packages', 'scripts'];
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const ALIASED_GET_POOL_IMPORT =
  /import\s*\{[^}]*\bgetAssetPool\s+as\s+\w+[^}]*\}\s*from\s*['"](?:@\/lib\/media\/asset-pool|(?:\.\.?\/)+(?:[\w.-]+\/)*asset-pool(?:\.[cm]?[jt]s)?)['"]/;
const NAMESPACE_POOL_IMPORT =
  /import\s+\*\s+as\s+\w+\s+from\s*['"](?:@\/lib\/media\/asset-pool|(?:\.\.?\/)+(?:[\w.-]+\/)*asset-pool(?:\.[cm]?[jt]s)?)['"]/;
const FORBIDDEN = [
  { pattern: /\bnew\s+BrowserAssetStore\s*\(/, allowed: new Set(['lib/media/asset-pool.ts']) },
  {
    pattern: /\bgetAssetPool\s*\(/,
    allowed: new Set(['lib/media/asset-pool.ts', 'lib/media/use-asset-url.ts']),
  },
  {
    pattern: /\bpool\.(?:resolve|release)\s*\(/,
    allowed: new Set(['lib/media/use-asset-url.ts']),
  },
  {
    pattern: ALIASED_GET_POOL_IMPORT,
    allowed: new Set(['lib/media/use-asset-url.ts']),
  },
  { pattern: NAMESPACE_POOL_IMPORT, allowed: new Set<string>() },
] as const;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !['dist', 'node_modules', 'test', 'tests'].includes(entry.name)) {
      files.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSION.test(entry.name)) files.push(path);
  }
  return files;
}

describe('asset URL ownership boundary', () => {
  it('recognizes aliased and namespace imports of the pool module', () => {
    expect(
      ALIASED_GET_POOL_IMPORT.test(
        "import { putAsset, getAssetPool as acquirePool } from '@/lib/media/asset-pool';",
      ),
    ).toBe(true);
    expect(NAMESPACE_POOL_IMPORT.test("import * as poolApi from '../media/asset-pool';")).toBe(
      true,
    );
  });

  it('keeps pool URL resolution and release inside the shared owner module', () => {
    const cwd = process.cwd();
    const sources = SOURCE_ROOTS.flatMap((root) => sourceFiles(join(cwd, root))).map((path) => ({
      path: relative(cwd, path),
      source: readFileSync(path, 'utf8'),
    }));
    // Best-effort static guard: dynamic import(), require aliases, and computed
    // property access can still bypass a regex and remain review responsibilities.
    const violations = FORBIDDEN.flatMap(({ pattern, allowed }) =>
      sources
        .filter(({ path, source }) => !allowed.has(path) && pattern.test(source))
        .map(({ path }) => path),
    );

    expect(violations).toEqual([]);
  });
});
