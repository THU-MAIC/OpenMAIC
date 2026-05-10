import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Bug #1 (stop button): the classroom now exposes a "stop generation" UI affordance.
 *
 * The button label and the toast text shown after stopping must be translated in
 * every supported locale. CI's `pnpm check:i18n-keys` already enforces parity
 * against `en-US.json`, but this test gives us a tight TDD loop without depending
 * on the script: it fails if any locale is missing one of the new keys.
 */

const LOCALES_DIR = path.join(__dirname, '..', '..', 'lib', 'i18n', 'locales');

const REQUIRED_KEYS = [
  ['stage', 'stopGeneration'],
  ['generation', 'stopGenerationToast'],
] as const;

function getNested(obj: unknown, segments: readonly string[]): string | undefined {
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

const localeFiles = fs
  .readdirSync(LOCALES_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort();

describe('stop-generation i18n keys', () => {
  it('has at least the 6 known locales available to extend', () => {
    expect(localeFiles.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of localeFiles) {
    const fullPath = path.join(LOCALES_DIR, file);
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

    for (const segments of REQUIRED_KEYS) {
      const keyPath = segments.join('.');
      it(`${file} provides "${keyPath}" with a non-empty translation`, () => {
        const value = getNested(data, segments);
        expect(value, `Missing or non-string ${keyPath} in ${file}`).toBeTruthy();
        expect(typeof value).toBe('string');
        expect((value as string).trim().length).toBeGreaterThan(0);
      });
    }
  }
});
