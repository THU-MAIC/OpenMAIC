import { AsyncLocalStorage } from 'node:async_hooks';
import postcss from 'postcss';

// Producer's distributed plan() looks up every family without an @font-face on
// Google Fonts (also the families it bundles, for extra weights) and exposes no
// fetch hook. Behind the entrypoint's egress lockdown those connections are
// dropped, so a lookup scope opened around chunk planning answers them locally
// with 404: Producer embeds its bundled faces and leaves every other family to
// the authored stack in Chromium. Only these two hosts, and only inside a
// scope, are answered; everything else passes through unchanged.
const GOOGLE_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

const scopes = new AsyncLocalStorage<Set<string>>();
let wrapper: typeof fetch | undefined;

/**
 * True once `docker-entrypoint.sh` has installed the egress lockdown. The
 * entrypoint sets `RENDER_EGRESS_LOCKDOWN_ACTIVE`; it is not an operator
 * setting, and a service started any other way keeps Producer's downloads.
 */
export function egressLockdownActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RENDER_EGRESS_LOCKDOWN_ACTIVE === 'true';
}

function requestUrl(input: RequestInfo | URL): URL | undefined {
  try {
    return new URL(input instanceof Request ? input.url : input);
  } catch {
    return undefined;
  }
}

/** Reinstall the hook whenever something else has taken over `globalThis.fetch`. */
function ensureLookupHook(): void {
  if (globalThis.fetch === wrapper) return;
  const delegate = globalThis.fetch;
  wrapper = (input, init) => {
    const requested = scopes.getStore();
    const url = requestUrl(input);
    if (!requested || !url || !GOOGLE_FONT_HOSTS.has(url.hostname)) {
      return delegate(input, init);
    }
    // Producer builds `css2?family=<name>:ital,wght@...`; keep any colon in the name.
    const family = url.searchParams
      .get('family')
      ?.replace(/:ital,wght@.*$/, '')
      .trim();
    if (family) requested.add(family);
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  globalThis.fetch = wrapper;
}

/**
 * Run a Producer compilation with Google Fonts answered locally and return the
 * families it looked up. Which of them are missing is decided against the
 * compiled output, see {@link unembeddedFamilies}.
 */
export async function withOfflineFontLookup<T>(
  compile: () => Promise<T>,
): Promise<{ result: T; requestedFamilies: string[] }> {
  ensureLookupHook();
  const requested = new Set<string>();
  const result = await scopes.run(requested, compile);
  return { result, requestedFamilies: [...requested] };
}

function unquote(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

/**
 * The requested families that have no @font-face in the compiled HTML, i.e.
 * the ones Chromium renders with the next family in the stack. Producer embeds
 * a bundled face under the name the page used (an alias such as Calibri gets
 * Inter's glyphs), so the compiled output is the source of truth.
 */
export function unembeddedFamilies(compiledHtml: string, requested: Iterable<string>): string[] {
  const embedded = new Set<string>();
  for (const [, css] of compiledHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    let root;
    try {
      root = postcss.parse(css ?? '');
    } catch {
      continue;
    }
    root.walkAtRules(/^font-face$/i, (face) => {
      face.walkDecls(/^font-family$/i, (decl) => {
        embedded.add(unquote(decl.value).toLowerCase());
      });
    });
  }
  const missing = new Map<string, string>();
  for (const family of requested) {
    const key = family.toLowerCase();
    if (!embedded.has(key) && !missing.has(key)) missing.set(key, family);
  }
  return [...missing.values()].sort();
}
