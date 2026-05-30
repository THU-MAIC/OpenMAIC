import { defineI18n } from 'fumadocs-core/i18n';
import { uiTranslations } from 'fumadocs-ui/i18n';

export const i18n = defineI18n({
  defaultLanguage: 'en',
  languages: ['en', 'zh-cn', 'zh-tw', 'ja', 'ru', 'ar'],
  // Default locale (en) has NO path prefix: /docs/getting-started.
  // Other locales are prefixed: /docs/zh-cn/getting-started.
  hideLocale: 'default-locale',
});

// RTL locales
export const rtlLocales = new Set(['ar']);

export const localeLabels: Record<string, string> = {
  en: 'English',
  'zh-cn': '简体中文',
  'zh-tw': '繁體中文',
  ja: '日本語',
  ru: 'Русский',
  ar: 'العربية',
};

// Translations API with the built-in fumadocs-ui namespace.
// `displayName` drives the labels in the language switcher.
export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add('ui', {
    en: { displayName: localeLabels.en },
    'zh-cn': { displayName: localeLabels['zh-cn'] },
    'zh-tw': { displayName: localeLabels['zh-tw'] },
    ja: { displayName: localeLabels.ja },
    ru: { displayName: localeLabels.ru },
    ar: { displayName: localeLabels.ar },
  });
