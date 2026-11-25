import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const locales = new URL('../../lib/i18n/locales/', import.meta.url);

describe('SearXNG deployment instructions', () => {
  it.each(readdirSync(locales).filter((name) => name.endsWith('.json')))(
    'points %s to the deployment provider and search slot',
    (name) => {
      const messages = JSON.parse(readFileSync(new URL(name, locales), 'utf8'));
      const hint = messages.settings.searxngServerOnlyNotice;
      for (const field of ['openmaic.yml', 'searxng', 'baseUrl', 'slots.webSearch']) {
        expect(hint).toContain(field);
      }
      expect(hint).not.toMatch(/SEARXNG_BASE_URL|server-providers\.yml/);
    },
  );
});
