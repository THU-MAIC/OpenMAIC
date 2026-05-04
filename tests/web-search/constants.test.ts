import { describe, expect, it } from 'vitest';
import { getWebSearchProviderDisplayName } from '@/lib/web-search/constants';

describe('web search provider constants', () => {
  it('uses translated provider names when available', () => {
    const t = (key: string) => (key === 'settings.providerNames.bocha' ? '博查' : key);

    expect(getWebSearchProviderDisplayName('bocha', t)).toBe('博查');
  });

  it('falls back to provider metadata name when no translation exists', () => {
    const t = (key: string) => key;

    expect(getWebSearchProviderDisplayName('tavily', t)).toBe('Tavily');
  });
});
