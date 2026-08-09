// Single source of truth for the docs site's locale configuration.
//
// This file is plain JS (.mjs) on purpose: scripts/postexport.mjs runs under
// bare `node` and cannot import a .ts module. A sibling `locales.d.mts` provides
// the TypeScript types so the .ts/.tsx files that import this stay typed.
//
// Importers: lib/i18n.ts, app/static.json/route.ts, components/search-dialog.tsx,
// scripts/postexport.mjs.

/** Default locale. It is served WITHOUT a path prefix (/docs/getting-started). */
export const DEFAULT_LANGUAGE = 'en';

/** All locales, in sidebar / language-switcher order. */
export const LANGUAGES = ['en', 'zh-cn', 'zh-tw', 'ja', 'ru', 'ar'];

// Orama tokenizer discriminator per locale. Each search side (build index in
// app/static.json/route.ts and client query in components/search-dialog.tsx)
// maps this discriminator to the concrete tokenizer/language. Keep ONE source
// of the discriminator here so both sides always agree.
//   'mandarin' / 'japanese' -> custom @orama/tokenizers (CJK has no spaces, so
//                              the default whitespace tokenizer indexes a whole
//                              doc as one token and search returns nothing).
//   'english' / 'russian' / 'arabic' -> Orama built-in `language`.
/** @type {Record<string, 'mandarin' | 'japanese' | 'english' | 'russian' | 'arabic'>} */
export const ORAMA_TOKENIZER = {
  en: 'english',
  'zh-cn': 'mandarin',
  'zh-tw': 'mandarin',
  ja: 'japanese',
  ru: 'russian',
  ar: 'arabic',
};

/** Next.js basePath the docs site is mounted under. */
export const DOCS_BASE_PATH = '/docs';

/** Human label per locale, shown in the language switcher (displayName). */
export const LOCALE_LABELS = {
  en: 'English',
  'zh-cn': '简体中文',
  'zh-tw': '繁體中文',
  ja: '日本語',
  ru: 'Русский',
  ar: 'العربية',
};

/** Right-to-left locales. */
export const RTL_LOCALES = ['ar'];
