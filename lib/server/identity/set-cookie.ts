/**
 * One answer per cookie in a response's `Set-Cookie` values.
 *
 * Owner resolution attaches its `Set-Cookie` values to every response of the
 * request (`./with-owner.ts`), and a valid anonymous cookie is renewed on each
 * of them (`./anonymous-cookie.ts`). Some responses also clear a credential:
 * a claim drops the anonymous cookie it spent, and every `403 OWNER_RETIRED`
 * drops the retired one. Such a response must not renew what it clears. The
 * browser applies `Set-Cookie` values in order, so whether a renewal appended
 * after the clearing value would resurrect the cookie depends on how a route
 * happened to merge its headers; this makes it independent of that order.
 *
 * Generic over cookie names: a value that clears a cookie (`Max-Age` zero or
 * negative, or an `Expires` in the past) wins over every other value for the
 * same name in the same response.
 */

function cookieName(value: string): string {
  const separator = value.indexOf('=');
  return (separator < 0 ? value : value.slice(0, separator)).trim();
}

function isClearing(value: string): boolean {
  const attributes = value.split(';').slice(1);
  for (const attribute of attributes) {
    const separator = attribute.indexOf('=');
    const key = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    const raw = separator < 0 ? '' : attribute.slice(separator + 1).trim();
    if (key === 'max-age' && /^-?\d+$/.test(raw) && Number(raw) <= 0) return true;
    if (key === 'expires') {
      const at = Date.parse(raw);
      if (!Number.isNaN(at) && at <= Date.now()) return true;
    }
  }
  return false;
}

/** The values with every non-clearing value dropped for a cookie that a value clears. */
export function resolveSetCookieValues(values: readonly string[]): string[] {
  const cleared = new Set(values.filter(isClearing).map(cookieName));
  return values.filter((value) => !cleared.has(cookieName(value)) || isClearing(value));
}

/**
 * Apply {@link resolveSetCookieValues} to `headers` in place. Returns
 * `headers`; a no-op unless a cookie is both set and cleared.
 */
export function resolveSetCookies(headers: Headers): Headers {
  const values = headers.getSetCookie();
  const kept = resolveSetCookieValues(values);
  if (kept.length === values.length) return headers;
  headers.delete('set-cookie');
  for (const value of kept) headers.append('set-cookie', value);
  return headers;
}

/**
 * {@link resolveSetCookies} on a response's headers. A response whose headers
 * are immutable (`Response.redirect`, a fetched response) is rebuilt around
 * the same body.
 */
export function resolveResponseSetCookies(response: Response): Response {
  const values = response.headers.getSetCookie();
  if (resolveSetCookieValues(values).length === values.length) return response;
  try {
    resolveSetCookies(response.headers);
    return response;
  } catch {
    const headers = resolveSetCookies(new Headers(response.headers));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
