export type LocaleEntry = {
  code: string;
  /** Native name shown in dropdown, e.g. '简体中文' */
  label: string;
  /** Short label shown on the toggle button, e.g. 'CN' */
  shortLabel: string;
};

/**
 * Supported locales registry.
 *
 * To add a new language:
 *   1. Create `lib/i18n/locales/<code>.json` (copy an existing file as template)
 *   2. Add an entry here
 */
export const supportedLocales = [
  { code: 'zh-CN', label: '简体中文', shortLabel: 'CN' },
  { code: 'en-US', label: 'English', shortLabel: 'EN' },
  { code: 'ja-JP', label: '日本語', shortLabel: 'JA' },
  { code: 'ru-RU', label: 'Русский', shortLabel: 'RU' },
] as const satisfies readonly LocaleEntry[];
