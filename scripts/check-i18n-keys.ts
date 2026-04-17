import fs from 'node:fs';
import path from 'node:path';

const LOCALES_DIR = path.join(process.cwd(), 'lib', 'i18n', 'locales');
const SOURCE_LOCALE = 'en-US.json';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectLeafKeys(
  value: unknown,
  prefix = '',
  keys: Set<string> = new Set<string>(),
): Set<string> {
  if (isPlainObject(value)) {
    const entries = Object.entries(value);

    if (entries.length === 0) {
      if (prefix) keys.add(prefix);
      return keys;
    }

    for (const [key, child] of entries) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      collectLeafKeys(child, nextPrefix, keys);
    }

    return keys;
  }

  if (!prefix) {
    throw new Error('Locale JSON root must be an object.');
  }

  keys.add(prefix);
  return keys;
}

function readLocaleKeys(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!isPlainObject(parsed)) {
    throw new Error(`${path.basename(filePath)} must contain a JSON object at the root.`);
  }

  return [...collectLeafKeys(parsed)].sort();
}

function main(): void {
  const localeFiles = fs
    .readdirSync(LOCALES_DIR)
    .filter((name: string) => name.endsWith('.json'))
    .sort();

  if (!localeFiles.includes(SOURCE_LOCALE)) {
    throw new Error(`Missing source locale: ${SOURCE_LOCALE}`);
  }

  const sourceKeys = new Set(readLocaleKeys(path.join(LOCALES_DIR, SOURCE_LOCALE)));
  const reports: Array<{ file: string; missing: string[]; extra: string[] }> = [];

  for (const localeFile of localeFiles) {
    if (localeFile === SOURCE_LOCALE) continue;

    const localeKeys = new Set(readLocaleKeys(path.join(LOCALES_DIR, localeFile)));
    const missing = [...sourceKeys].filter((key) => !localeKeys.has(key)).sort();
    const extra = [...localeKeys].filter((key) => !sourceKeys.has(key)).sort();

    if (missing.length > 0 || extra.length > 0) {
      reports.push({ file: localeFile, missing, extra });
    }
  }

  if (reports.length === 0) {
    console.log(
      `i18n key alignment check passed (${localeFiles.length} locale files, source: ${SOURCE_LOCALE}).`,
    );
    return;
  }

  console.error(`i18n key alignment check failed against ${SOURCE_LOCALE}:`);

  for (const report of reports) {
    console.error(`\n- ${report.file}`);

    if (report.missing.length > 0) {
      console.error(`  Missing keys (${report.missing.length}):`);
      for (const key of report.missing) {
        console.error(`    - ${key}`);
      }
    }

    if (report.extra.length > 0) {
      console.error(`  Extra keys (${report.extra.length}):`);
      for (const key of report.extra) {
        console.error(`    - ${key}`);
      }
    }
  }

  process.exit(1);
}

main();
