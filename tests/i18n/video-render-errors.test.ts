import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { supportedLocales } from '@/lib/i18n/locales';

describe('video render rejection messages', () => {
  it.each(supportedLocales)('provides all rejection messages in $code', ({ code }) => {
    const locale = JSON.parse(readFileSync(`lib/i18n/locales/${code}.json`, 'utf8'));
    for (const key of ['videoQueueFull', 'videoRenderInProgress', 'videoTooLarge']) {
      expect(locale.export[key], `${code}: export.${key}`).toBeTypeOf('string');
      expect(locale.export[key].trim()).not.toBe('');
      expect(locale.export[key]).not.toBe(`export.${key}`);
    }
  });
});
