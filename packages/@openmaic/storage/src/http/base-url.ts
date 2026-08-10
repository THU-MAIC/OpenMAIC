/**
 * The base-URL rule the HTTP clients share.
 *
 * They build request URLs by string concatenation (`${baseUrl}${path}`), which
 * makes the base URL's shape a correctness question rather than a style one,
 * and the two clients drifting apart on it would be a security difference
 * hiding as a duplication.
 */

/** A URL carrying an explicit scheme, i.e. one that is not a bare path. */
export const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

/** Schemes a client may speak. Anything else is a mis-configuration, not a mode. */
export const RESOLVABLE_SCHEMES = new Set(['http:', 'https:']);

/** The unambiguous absolute form: scheme, `//`, then an authority. */
const SCHEME_AUTHORITY_FORM = /^https?:\/\//i;

/**
 * C0 controls and DEL. The URL parser strips tab, LF and CR outright and
 * percent-encodes the rest, so a base URL containing one never means what it
 * looks like it means.
 */
const URL_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/**
 * Validate a base URL and return it without its trailing slashes.
 *
 * A base URL is either a full `http(s)://host[/path]` or a bare path (the
 * app-mounted shape, e.g. `/api/persistence`, which the browser resolves
 * against the document). Everything else is refused at construction, where the
 * deployment can still fix it:
 *
 * - A non-http(s) scheme would put `file:` or `ftp:` one string-join away from
 *   every request the client makes.
 * - A scheme without `//` — `https:api.example/x` — parses standalone to the
 *   host `api.example`, but `fetch` on a same-scheme page reads it as a path
 *   relative to the current document. The client would then send its requests,
 *   and its credentials, somewhere other than where the operator wrote.
 * - A base carrying a query or fragment silently swallows the path appended to
 *   it: `https://host/api?v=1` + `/kv/keys` is not a route anyone intended.
 * - A "path" that opens an authority — `//host`, `/\host` — is not a path at
 *   all. The browser resolves it cross-origin, taking the client's requests and
 *   credentials with it.
 * - A control character anywhere, since the URL parser strips or re-encodes
 *   them and the string then stops meaning what it reads as, and surrounding
 *   whitespace for the same reason.
 * - Embedded credentials, which `fetch` refuses to build a request from at all.
 */
export function assertHttpBaseUrl(baseUrl: string, label: string): string {
  if (baseUrl === '') {
    throw new Error(`@openmaic/storage: ${label} baseUrl must be non-empty`);
  }
  // `new URL` strips surrounding whitespace, so a base with a trailing space
  // validates cleanly and then breaks every request: the concatenation puts the
  // space *inside* the URL, where it is no longer trailing and no longer
  // stripped. Refuse rather than silently repair, so the configuration is fixed
  // where it was written.
  if (baseUrl !== baseUrl.trim()) {
    throw new Error(`@openmaic/storage: ${label} baseUrl must not begin or end with whitespace`);
  }
  const trimmed = baseUrl.replace(/\/+$/, '');
  // Before any shape check, because the URL parser strips these and would then
  // disagree with everything below about what it is looking at. Same reasoning
  // as the guard on resolved asset URLs, widened to every C0 control and DEL:
  // none of them belongs in a base URL under any encoding.
  if (URL_CONTROL_CHARACTERS.test(trimmed)) {
    throw new Error(`@openmaic/storage: ${label} baseUrl must not contain control characters`);
  }
  // On the raw string, not on a parsed `search`/`hash`: a base ending in a bare
  // `?` or `#` parses to empty ones and would slip through, then swallow the
  // path concatenated onto it into a query or fragment.
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error(`@openmaic/storage: ${label} baseUrl must not carry a query or fragment`);
  }
  if (!ABSOLUTE_URL.test(trimmed)) {
    // Trimming leaves `''` for a root mount (`/`), which concatenates correctly.
    if (trimmed === '') return trimmed;
    if (!trimmed.startsWith('/')) {
      throw new Error(
        `@openmaic/storage: ${label} baseUrl must be an absolute http(s) URL or a path ` +
          `beginning with "/"`,
      );
    }
    // `//host` and `/\host` are not paths. A browser reads them as an authority,
    // so every request built on such a base — and every credential on it — goes
    // to another origin. Structurally the same refusal the resolved-URL check
    // makes, for the same reason.
    if (trimmed[1] === '/' || trimmed[1] === '\\') {
      throw new Error(
        `@openmaic/storage: ${label} baseUrl must be a path, not a reference to another origin`,
      );
    }
    return trimmed;
  }
  // Scheme first, so a `file:` base is reported as the wrong scheme rather than
  // as the wrong shape — the two failures have different fixes.
  const scheme = trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase();
  if (!RESOLVABLE_SCHEMES.has(scheme)) {
    throw new Error(
      `@openmaic/storage: ${label} baseUrl scheme ${JSON.stringify(scheme)} is not http(s)`,
    );
  }
  if (!SCHEME_AUTHORITY_FORM.test(trimmed)) {
    throw new Error(
      `@openmaic/storage: ${label} baseUrl must be http(s) in the "scheme://host" form ` +
        `(a scheme without "//" is resolved relative to the current document)`,
    );
  }
  let parsed: URL;
  try {
    // The query and fragment were already refused on the raw string, which is
    // the check that holds — `parsed.search` is empty for a base ending in a
    // bare `?`, so reading it would pass exactly the case that swallows the path.
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`@openmaic/storage: ${label} baseUrl must be a valid URL`);
  }
  // Fetch forbids building a request from a URL carrying credentials, so a base
  // like `https://user:pass@host` constructs a client that throws a native
  // TypeError on every single operation. Refusing here turns a per-call runtime
  // failure into one legible error where the deployment is configured.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      `@openmaic/storage: ${label} baseUrl must not carry userinfo — fetch refuses to build a ` +
        `request from a URL with embedded credentials`,
    );
  }
  return trimmed;
}
