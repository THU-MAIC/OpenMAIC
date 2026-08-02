import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOTS = ['app', 'components', 'lib', 'packages', 'scripts'];
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const ALLOWED = new Set(['lib/media/asset-pool.ts', 'lib/media/use-asset-url.ts']);
const FORBIDDEN =
  /\b(?:getAssetPool\s*\(|pool\.(?:resolve|release)\s*\(|new\s+BrowserAssetStore\s*\()/;

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
  it('keeps pool URL resolution and release inside the shared owner module', () => {
    const cwd = process.cwd();
    const violations = SOURCE_ROOTS.flatMap((root) => sourceFiles(join(cwd, root)))
      .map((path) => ({ path: relative(cwd, path), source: readFileSync(path, 'utf8') }))
      .filter(({ path, source }) => !ALLOWED.has(path) && FORBIDDEN.test(source))
      .map(({ path }) => path);

    expect(violations).toEqual([]);
  });
});
