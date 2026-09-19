import { workbenchResourceFor } from './workbench';

export type TranslationResource = Record<string, unknown>;

function isRecord(value: unknown): value is TranslationResource {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The workbench chat surface's product copy lives in `lib/i18n/workbench.ts`
 * (a hook-free en/zh map, see `workbenchResourceFor`) rather than in the
 * per-locale JSON files. This loader merges it under the `workbench.*` namespace
 * so the React `t` and the hook-free `WorkbenchTranslator` resolve the same
 * keys: `t('workbench.chat.jumpToBottom')` works everywhere `t` works.
 */
function deepMerge(base: TranslationResource, overlay: TranslationResource): TranslationResource {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = isRecord(value) && isRecord(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

/** Load one locale's JSON and merge the workbench overlay. Safe for Server Components. */
export async function loadLocaleResource(language: string): Promise<TranslationResource> {
  const localeModule = await import(`./locales/${language}.json`);
  return deepMerge(localeModule.default as TranslationResource, {
    workbench: workbenchResourceFor(language),
  });
}
