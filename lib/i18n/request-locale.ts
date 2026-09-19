import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE_NAME, resolveRequestLocale } from './resolve-locale';
import type { Locale } from './types';

/**
 * Resolve the request's UI locale for SSR: locale cookie, then
 * `Accept-Language`, then `defaultLocale`.
 */
export async function getRequestLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  return resolveRequestLocale({
    cookie: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: headerStore.get('accept-language'),
  });
}
