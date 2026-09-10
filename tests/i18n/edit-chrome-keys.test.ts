import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { workbenchResourceFor } from '@/lib/i18n/workbench';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import deDE from '@/lib/i18n/locales/de-DE.json';
import enUS from '@/lib/i18n/locales/en-US.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import frFR from '@/lib/i18n/locales/fr-FR.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import viVN from '@/lib/i18n/locales/vi-VN.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';

/**
 * Guard for the editor-chrome locale contract.
 *
 * The ported editor chrome (`components/edit/**`, `components/workbench/**`,
 * `lib/workbench/**`) renders its copy through `t('...')`. When a key is
 * missing from a locale, i18next falls back to the raw key string and the user
 * sees `edit.roster.shortTitle` instead of text. That regression shipped once;
 * this test makes it impossible to ship again.
 *
 * It statically extracts the `t(...)` string literals from those directories,
 * resolves each against the SAME merged resource the runtime uses — the locale
 * JSON deep-merged with the hook-free `workbench.*` map from
 * `lib/i18n/workbench.ts` (mirroring `lib/i18n/config.ts`) — and asserts the
 * key resolves to a non-empty string in every one of the 12 locales.
 *
 * Dynamic keys are NOT guessed. The two bounded dynamic prefixes are expanded
 * from explicit static tables below (the `SceneType` union and the FONTS
 * registry's `labelKey`), each with the file that owns the mapping; everything
 * truly data-driven (server-provided copy keys such as `node.copyKey` or
 * `snapshot.error`) is out of scope and resolves against server-side locales.
 */
const SCAN_DIRS = ['components/edit', 'components/workbench', 'lib/workbench'] as const;

/**
 * `t('edit.sceneType.' + scene.type)` in
 * `components/edit/SlideNavRail/ThumbItem.tsx` — one key per `SceneType` value
 * (`packages/@openmaic/dsl/src/stage.ts`).
 */
const SCENE_TYPE_VALUES = ['slide', 'quiz', 'interactive', 'pbl'] as const;

/**
 * `t(f.labelKey)` in `components/edit/surfaces/slide/text-format-bar.tsx`
 * reads `labelKey` from the FONTS registry (`configs/font.ts`), which lives
 * outside the scanned directories.
 */
const FONT_LABEL_KEYS = ['edit.text.fontDefault'] as const;

const LOCALE_RESOURCES: Record<string, unknown> = {
  'ar-SA': arSA,
  'de-DE': deDE,
  'en-US': enUS,
  'es-MX': esMX,
  'fr-FR': frFR,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'vi-VN': viVN,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

const LOCALES = Object.keys(LOCALE_RESOURCES);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else if (path.endsWith('.ts') || path.endsWith('.tsx')) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Collect every i18n key the scanned code can ask for: direct `t('...')`
 * literals, ternary literals inside `t(...)`, the `labelKey:` values the
 * registries resolve through `t(some.labelKey)`, and the statically known
 * values of the bounded dynamic prefixes.
 */
function extractKeys(): string[] {
  const keys = new Set<string>();
  const labelKeyPattern = /labelKey:\s*'([^']+)'/g;
  const directPattern = /(?:^|[^a-zA-Z0-9_])t\(\s*'([^']*)'/g;
  const doubleQuotePattern = /(?:^|[^a-zA-Z0-9_])t\(\s*"([^"]*)"/g;
  // `t(condition ? 'a' : 'b')` — both arms are keys.
  const ternaryPattern = /\bt\([^)]*\?\s*'([^']*)'\s*:\s*'([^']*)'/g;
  const concatPrefixPattern = /(?:^|[^a-zA-Z0-9_])t\(\s*'([^']+)'\s*\+/g;

  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of [directPattern, doubleQuotePattern]) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
          const key = match[1];
          // A trailing dot marks a dynamic prefix (`'edit.sceneType.' + ...`),
          // expanded below; it is not a key on its own.
          if (key && !key.endsWith('.')) keys.add(key);
        }
      }
      ternaryPattern.lastIndex = 0;
      for (const match of source.matchAll(ternaryPattern)) {
        keys.add(match[1]);
        keys.add(match[2]);
      }
      labelKeyPattern.lastIndex = 0;
      for (const match of source.matchAll(labelKeyPattern)) {
        keys.add(match[1]);
      }
      concatPrefixPattern.lastIndex = 0;
      for (const match of source.matchAll(concatPrefixPattern)) {
        const prefix = match[1];
        if (prefix === 'edit.sceneType.') {
          for (const value of SCENE_TYPE_VALUES) keys.add(`${prefix}${value}`);
        } else {
          // A new dynamic prefix would be flagged here instead of guessed.
          throw new Error(`unexpected dynamic i18n prefix '${prefix}' in ${file}`);
        }
      }
    }
  }

  for (const key of FONT_LABEL_KEYS) keys.add(key);
  return [...keys].sort();
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The merged view the React `t` actually resolves against: the locale JSON
 * deep-merged with `{ workbench: workbenchResourceFor(language) }` — the same
 * merge `lib/i18n/config.ts` performs for i18next.
 */
function mergedResource(localeCode: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...(LOCALE_RESOURCES[localeCode] as Record<string, unknown>),
  };
  const overlay = { workbench: workbenchResourceFor(localeCode) };
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] =
      isRecord(value) && isRecord(result[key]) ? mergedResourceMerge(result[key], value) : value;
  }
  return result;
}

function mergedResourceMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] =
      isRecord(value) && isRecord(result[key]) ? mergedResourceMerge(result[key], value) : value;
  }
  return result;
}

describe('editor chrome i18n keys', () => {
  const keys = extractKeys();

  it('finds a non-trivial set of keys to guard', () => {
    // Sanity: the scan must actually see the chrome's copy calls, including the
    // keys the acceptance test found leaking.
    expect(keys).toContain('edit.roster.shortTitle');
    expect(keys).toContain('edit.elementRef.startPicking');
    expect(keys).toContain('edit.elementRef.exitPicking');
    expect(keys.length).toBeGreaterThan(100);
  });

  it.each(LOCALES)('resolves every extracted key in %s', (locale) => {
    const resource = mergedResource(locale);
    const unresolved = keys.filter((key) => {
      const value = readPath(resource, key.split('.'));
      return typeof value !== 'string' || value.length === 0;
    });
    expect(unresolved, `unresolved keys in ${locale}`).toEqual([]);
  });
});
