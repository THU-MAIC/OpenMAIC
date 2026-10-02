import { describe, expect, it } from 'vitest';

import {
  resolveResponseSetCookies,
  resolveSetCookieValues,
} from '@/lib/server/identity/set-cookie';

const RENEW = 'anonymous_id=a652e716-0e2e-47f5-8432-4ee60f6f0977; Path=/; Max-Age=34560000';
const CLEAR = 'anonymous_id=; Path=/; Max-Age=0';
const OTHER = 'theme=dark; Path=/; Max-Age=60';

describe('one answer per cookie in Set-Cookie', () => {
  it('lets a clearing value win over a renewal of the same cookie, in either order', () => {
    expect(resolveSetCookieValues([RENEW, CLEAR, OTHER])).toEqual([CLEAR, OTHER]);
    expect(resolveSetCookieValues([CLEAR, OTHER, RENEW])).toEqual([CLEAR, OTHER]);
  });

  it('treats a past Expires and a negative Max-Age as clearing', () => {
    const expired = 'anonymous_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    expect(resolveSetCookieValues([RENEW, expired])).toEqual([expired]);
    const negative = 'anonymous_id=; Path=/; Max-Age=-1';
    expect(resolveSetCookieValues([negative, RENEW])).toEqual([negative]);
  });

  it('leaves values alone when nothing is cleared', () => {
    expect(resolveSetCookieValues([RENEW, OTHER])).toEqual([RENEW, OTHER]);
  });

  it('resolves a response in place, keeping its body', async () => {
    const headers = new Headers();
    headers.append('set-cookie', RENEW);
    headers.append('set-cookie', CLEAR);
    const resolved = resolveResponseSetCookies(new Response('hello', { status: 403, headers }));
    expect(resolved.status).toBe(403);
    expect(resolved.headers.getSetCookie()).toEqual([CLEAR]);
    expect(await resolved.text()).toBe('hello');
  });

  it('returns an immutable response untouched when there is nothing to resolve', () => {
    const redirect = Response.redirect('http://localhost/next', 302);
    expect(resolveResponseSetCookies(redirect)).toBe(redirect);
  });
});
