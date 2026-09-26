import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Cookie parsing lives only inside the owner auth methods, and authorization
 * never reads meaning into the shape of an owner id.
 *
 * Owner identity is resolved in exactly one place (`lib/server/identity/`), so
 * a host that registers its own methods changes identity everywhere at once. A route that read the anonymous owner cookie itself, or decided
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
 * The retired runtime identity: a client-chosen learner key header behind a
 * development bearer token that shipped in the public bundle. The runtime
 * learner key is the resolved owner id now; code that read either of these
 * again would let a client choose whose runtime data it touches.
 */
const RETIRED_CLIENT_IDENTITY =
  /x-learner-key|PERSISTENCE_DEV_TOKEN|NEXT_PUBLIC_PERSISTENCE_TOKEN|PERSISTENCE_ALLOW_INSECURE_DEV_AUTH/i;

/**
 * Identity asserted by a gateway: the identity header families common gateways
 * set (oauth2-proxy, Authelia, Authentik, Azure App Service authentication,
 * Cloudflare Access, Google IAP, AWS ALB OIDC and similar). Such a header is
 * trustworthy only after a host auth method verified it (a signed assertion
 * checked against the identity provider's keys), and a host keeps that method
 * in `lib/server/identity/host/`; code that read one anywhere else — core
 * identity files included, which have no use for them — would take a
 * client-chosen user at its word.
 */
const GATEWAY_IDENTITY = new RegExp(
  [
    String.raw`x-forwarded-(?:user|groups|email|preferred-username|access-token)`,
    String.raw`x-auth-request-`,
    String.raw`\bremote-(?:user|groups|email|name)\b`,
    String.raw`x-authentik-`,
    String.raw`x-ms-client-principal`,
    String.raw`x-webauth-`,
    String.raw`cf-access-`,
    String.raw`x-goog-authenticated-user-`,
    String.raw`x-goog-iap-jwt-assertion`,
    String.raw`x-amzn-oidc-`,
  ].join('|'),
  'i',
);

/**
 * The internals of owner resolution: the built-in methods, the anonymous
 * cookie parser and clearer, and the resolved method list. Only
 * `lib/server/identity/` may use them: anywhere else could ask a method
 * directly (and read its credential) outside core's ordering and 401 rules,
 * or pin that code to the built-in identity. Hosts use the index
 * (`configureOwnerAuthentication`, `sharedTeamAuthMethod`).
 */
const BUILT_IN_IMPORT =
  /anonymousCookieMethod|readAnonymousOwnerId|clearAnonymousCookieHeader|isAnonymousCookieOwnerId|resolveSharedOwnerId|isSharedTeamAuthMethod|ownerAuthConfigurationForResolution|identity\/(?:anonymous-cookie|shared-team)['"]/;

/**
 * Reading an incoming request's `Authorization` (or `Proxy-Authorization`)
 * header: a bearer credential, which only a host auth method may interpret.
 * The app sets `Authorization` on its own outgoing provider requests (API
 * keys), which is not a read and is not matched; no current code reads the
 * incoming header with `.get()`, so this has no allowlist outside the host
 * directory.
 */
const AUTHORIZATION_READ = /\.get\(\s*['"`](?:proxy-)?authorization['"`]\s*\)/i;

/**
 * The configuration of the removed built-in gateway-header authenticator.
 * Nothing may read it any more. The one module that names it,
 * `retired-config.ts`, only fails the boot when one is set, and is checked
 * separately to read names, never values.
 */
const RETIRED_GATEWAY_CONFIG = /TRUSTED_PROXY_|\bOWNER_AUTHENTICATOR\b/;
const RETIRED_CONFIG_MODULE = join('lib', 'server', 'identity', 'retired-config.ts');
/** Where a host keeps its own auth methods: the only place identity headers may be read. */
const HOST_METHODS = ['lib', 'server', 'identity', 'host'].join(sep) + sep;

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

const allFiles = SCANNED.flatMap(sourceFiles);
/** Everything outside `lib/server/identity/`. */
const files = allFiles.filter((file) => !file.startsWith(IDENTITY_MODULE));
/** Everything but the host methods directory: core identity files included. */
const outsideHostMethods = allFiles.filter((file) => !file.startsWith(HOST_METHODS));
/** Outside core identity: app code plus the host methods, which use only the public surface. */
const outsideCore = allFiles.filter(
  (file) => !file.startsWith(IDENTITY_MODULE) || file.startsWith(HOST_METHODS),
);

function offenders(pattern: RegExp, scanned: readonly string[] = files): string[] {
  return scanned
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
    expect('const x = process.env.TRUSTED_PROXY_SECRET;').toMatch(RETIRED_GATEWAY_CONFIG);
    expect("env('OWNER_AUTHENTICATOR')").toMatch(RETIRED_GATEWAY_CONFIG);
    expect('import { readAnonymousOwnerId }').toMatch(BUILT_IN_IMPORT);
    expect(allFiles).toContain(join('lib', 'server', 'identity', 'resolve.ts'));
    expect(outsideHostMethods).toContain(join('lib', 'server', 'identity', 'resolve.ts'));
    expect(readdirSync(join(ROOT, HOST_METHODS))).toContain('README.md');
  });

  it.each([
    "req.headers.get('x-forwarded-user')",
    "headers.get('X-Forwarded-Groups')",
    "headers.get('x-forwarded-email')",
    "headers.get('x-auth-request-user')",
    "headers.get('Remote-User')",
    "headers.get('X-Forwarded-Preferred-Username')",
    "headers.get('x-authentik-username')",
    "headers.get('X-authentik-groups')",
    "headers.get('x-ms-client-principal')",
    "headers.get('X-MS-CLIENT-PRINCIPAL-NAME')",
    "headers.get('x-webauth-user')",
    "headers.get('cf-access-authenticated-user-email')",
    "headers.get('Cf-Access-Jwt-Assertion')",
    "headers.get('x-goog-authenticated-user-email')",
    "headers.get('x-goog-iap-jwt-assertion')",
    "headers.get('x-amzn-oidc-identity')",
    "headers.get('X-Amzn-Oidc-Data')",
  ])('recognizes the gateway identity read %s', (code) => {
    expect(code).toMatch(GATEWAY_IDENTITY);
  });

  it.each([
    "req.headers.get('authorization')",
    'headers.get("Authorization")',
    'request.headers.get(`proxy-authorization`)',
  ])('recognizes the credential read %s', (code) => {
    expect(code).toMatch(AUTHORIZATION_READ);
  });

  it('does not flag setting Authorization on an outgoing request', () => {
    expect('headers: { Authorization: `Bearer ${apiKey}` }').not.toMatch(AUTHORIZATION_READ);
    expect("headers.set('Authorization', value)").not.toMatch(AUTHORIZATION_READ);
    expect('const { authorization: _a, ...safe } = headers;').not.toMatch(AUTHORIZATION_READ);
  });

  it('does not flag unrelated forwarding headers', () => {
    expect("headers.get('x-forwarded-for')").not.toMatch(GATEWAY_IDENTITY);
    expect("headers.get('x-forwarded-proto')").not.toMatch(GATEWAY_IDENTITY);
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

  it('reads gateway identity headers only in the host methods directory', () => {
    expect(offenders(GATEWAY_IDENTITY, outsideHostMethods)).toEqual([]);
  });

  it('reads an incoming Authorization header only in the host methods directory', () => {
    expect(offenders(AUTHORIZATION_READ, outsideHostMethods)).toEqual([]);
  });

  it('keeps the built-in methods and resolution internals inside core identity', () => {
    expect(offenders(BUILT_IN_IMPORT, outsideCore)).toEqual([]);
  });

  it('reads no configuration of the removed gateway-header authenticator anywhere', () => {
    const everywhere = [...allFiles, '.env.example'].filter(
      (file) => file !== RETIRED_CONFIG_MODULE,
    );
    expect(everywhere.some((file) => file.startsWith(IDENTITY_MODULE))).toBe(true);
    expect(offenders(RETIRED_GATEWAY_CONFIG, everywhere)).toEqual([]);
    // The one module that names the variables matches only their names.
    const retired = readFileSync(join(ROOT, RETIRED_CONFIG_MODULE), 'utf8');
    expect(retired).toMatch(RETIRED_GATEWAY_CONFIG);
    expect(retired).not.toMatch(/process\.env\s*(?:\.|\[)/);
  });
});
