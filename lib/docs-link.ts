/**
 * Links into the docs site (packages/docs), which is mounted under `/docs` and
 * serves English without a prefix and every other language under its own one.
 */

const DEFAULT_DOCS_BASE = '/docs';

/** App locale → docs path prefix. A locale the docs do not cover falls back to English. */
const DOCS_LOCALE_PREFIX: Readonly<Record<string, string>> = {
  'en-US': '',
  'zh-CN': '/zh-cn',
  'zh-TW': '/zh-tw',
  'ja-JP': '/ja',
  'ru-RU': '/ru',
  'ar-SA': '/ar',
};

/** Where the docs live: `NEXT_PUBLIC_DOCS_URL` when set, else `/docs` on this origin. */
function docsBase(): string {
  const configured = process.env.NEXT_PUBLIC_DOCS_URL?.trim().replace(/\/+$/, '');
  return configured || DEFAULT_DOCS_BASE;
}

/** The docs' getting-started page in the language closest to `locale`. */
export function docsHref(locale: string): string {
  return `${docsBase()}${DOCS_LOCALE_PREFIX[locale] ?? ''}/getting-started`;
}
