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
/** App code, plus the server-side sources of every workspace package. */
const SCANNED = [
  'app',
  'lib',
  'components',
  'middleware.ts',
  'instrumentation.ts',
  ...packageSourceDirs(),
];
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IDENTITY_MODULE = ['lib', 'server', 'identity'].join(sep) + sep;

/**
 * Deciding something from the `anon:` shape of an owner id. The spellings
 * policed are: `startsWith('anon:')`, a `/^anon:/` regex, `indexOf` /
 * `lastIndexOf` / `includes` with an `anon:` argument, and any `==` / `===` /
 * `!=` / `!==` comparison against the exact literal `'anon:'` (which is what
 * `slice(0, 5)`, `substring(0, 5)` and `substr(0, 5)` checks reduce to).
 * Building an id with a template such as `` `anon:${uuid}` `` is not a check
 * and is not matched.
 */
const ANON_PREFIX_CHECK = new RegExp(
  [
    String.raw`startsWith\(\s*['"${'`'}]anon:`,
    String.raw`\/\^anon:`,
    String.raw`(?:lastIndexOf|indexOf|includes)\(\s*['"${'`'}]anon:`,
    String.raw`[!=]==?\s*['"${'`'}]anon:['"${'`'}]`,
    String.raw`['"${'`'}]anon:['"${'`'}]\s*[!=]==?`,
  ].join('|'),
);

/**
 * The concrete built-ins. Only the registry's default wiring (inside
 * `lib/server/identity/`) may use them: anywhere else would pin that code to
 * the built-in identity and bypass a host's configured authenticator.
 */
/**
 * The retired runtime identity: a client-chosen learner key header behind a
 * development bearer token that shipped in the public bundle. The runtime
 * learner key is the resolved owner id now; code that read either of these
 * again would let a client choose whose runtime data it touches.
 */
const RETIRED_CLIENT_IDENTITY =
  /x-learner-key|PERSISTENCE_DEV_TOKEN|NEXT_PUBLIC_PERSISTENCE_TOKEN|PERSISTENCE_ALLOW_INSECURE_DEV_AUTH/i;

const BUILT_IN_IMPORT =
  /createAnonymousCookieAuthenticator|createSharedTeamAuthenticator|resolveSharedOwnerId|identity\/(?:anonymous-cookie|shared-team)['"]/;

function packageSourceDirs(): string[] {
  const dirs: string[] = [];
  const visit = (path: string, depth: number) => {
    for (const entry of readdirSync(join(ROOT, path))) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const child = join(path, entry);
      if (!statSync(join(ROOT, child)).isDirectory()) continue;
      if (entry === 'src') dirs.push(child);
      else if (depth < 2) visit(child, depth + 1);
    }
  };
  visit('packages', 0);
  return dirs;
}

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
    expect(files).toContain(join('packages', '@openmaic', 'storage', 'src', 'index.ts'));
    // And the patterns match what they are meant to catch.
    const cookieModule = readFileSync(join(ROOT, IDENTITY_MODULE, 'anonymous-cookie.ts'), 'utf8');
    expect(cookieModule).toMatch(/anonymous_id/);
    const registry = readFileSync(join(ROOT, IDENTITY_MODULE, 'registry.ts'), 'utf8');
    expect(registry).toMatch(BUILT_IN_IMPORT);
  });

  it.each([
    "ownerId.startsWith('anon:')",
    'ownerId.startsWith(`anon:`)',
    '/^anon:/.test(ownerId)',
    "ownerId.slice(0, 5) === 'anon:'",
    'ownerId.substring(0,5) == "anon:"',
    "ownerId.substr(0, 5) !== 'anon:'",
    "'anon:' === ownerId.slice(0, 5)",
    "ownerId.indexOf('anon:') === 0",
    "ownerId.lastIndexOf('anon:', 0) === 0",
    "ownerId.includes('anon:')",
  ])('recognizes the id-shape check %s', (code) => {
    expect(code).toMatch(ANON_PREFIX_CHECK);
  });

  it('does not flag building an anonymous id', () => {
    expect('return `anon:${uuid}`;').not.toMatch(ANON_PREFIX_CHECK);
  });

  it('keeps the anonymous owner cookie inside lib/server/identity', () => {
    expect(offenders(/anonymous_id/)).toEqual([]);
  });

  it('never authorizes from an anon: owner id prefix', () => {
    expect(offenders(ANON_PREFIX_CHECK)).toEqual([]);
  });

  it('never reads a client-chosen learner key or the retired development token', () => {
    expect(offenders(RETIRED_CLIENT_IDENTITY)).toEqual([]);
  });

  it('keeps the concrete built-in authenticators inside lib/server/identity', () => {
    expect(offenders(BUILT_IN_IMPORT)).toEqual([]);
  });
});
