import { defineI18n } from 'fumadocs-core/i18n';
import { uiTranslations } from 'fumadocs-ui/i18n';
import { DEFAULT_LANGUAGE, LANGUAGES, LOCALE_LABELS, RTL_LOCALES } from './locales.mjs';

export const i18n = defineI18n({
  defaultLanguage: DEFAULT_LANGUAGE,
  languages: LANGUAGES,
  // Default locale (en) has NO path prefix: /docs/getting-started.
  // Other locales are prefixed: /docs/zh-cn/getting-started.
  hideLocale: 'default-locale',
});

export const rtlLocales = new Set(RTL_LOCALES);
export const localeLabels = LOCALE_LABELS;

// Translations API with the built-in fumadocs-ui namespace. `displayName` drives
// the labels in the language switcher; build it from the single locale source.
export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add(
    'ui',
    Object.fromEntries(
      LANGUAGES.map((lang) => [lang, { displayName: LOCALE_LABELS[lang] }]),
    ),
  );
