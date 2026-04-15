export type LocaleEntry = {
  code: string;
  label: string;
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
  { code: 'en-US', label: 'English', shortLabel: 'EN' },
] as const satisfies readonly LocaleEntry[];
