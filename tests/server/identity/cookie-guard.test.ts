import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Cookie parsing lives only inside the authenticator, and authorization never
 * reads meaning into the shape of an owner id.
 *
 * Owner identity is resolved in exactly one place (`lib/server/identity/`), so
 * a host that registers its own authenticator changes identity everywhere at
 * once. A route that read the anonymous owner cookie itself, or decided
 * something from an `anon:` prefix, would silently keep the old identity in
 * that one place. These scans make such a regression fail here instead.
 */

const ROOT = join(__dirname, '..', '..', '..');
const SCANNED = ['app', 'lib', 'components', 'middleware.ts', 'instrumentation.ts'];
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IDENTITY_MODULE = ['lib', 'server', 'identity'].join(sep) + sep;

const ANON_PREFIX_CHECK = /startsWith\(\s*['"`]anon:|\/\^anon:/;

function sourceFiles(path: string): string[] {
  const absolute = join(ROOT, path);
  if (statSync(absolute).isFile()) return SOURCE.test(path) ? [path] : [];
  return readdirSync(absolute).flatMap((entry) =>
    entry === 'node_modules' ? [] : sourceFiles(join(path, entry)),
  );
}

const files = SCANNED.flatMap(sourceFiles).filter((file) => !file.startsWith(IDENTITY_MODULE));

function offenders(pattern: RegExp): string[] {
  return files
    .filter((file) => pattern.test(readFileSync(join(ROOT, file), 'utf8')))
    .map((file) => relative(ROOT, join(ROOT, file)));
}

describe('owner identity boundary', () => {
  it('scans a non-trivial source tree', () => {
    // An empty scan would pass every assertion below.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(join('app', 'api', 'stages', 'route.ts'));
    // And the patterns match what they are meant to catch.
    const cookieModule = readFileSync(join(ROOT, IDENTITY_MODULE, 'anonymous-cookie.ts'), 'utf8');
    expect(cookieModule).toMatch(/anonymous_id/);
    expect("ownerId.startsWith('anon:')").toMatch(ANON_PREFIX_CHECK);
  });

  it('keeps the anonymous owner cookie inside lib/server/identity', () => {
    expect(offenders(/anonymous_id/)).toEqual([]);
  });

  it('never authorizes from an anon: owner id prefix', () => {
    expect(offenders(ANON_PREFIX_CHECK)).toEqual([]);
  });
});
