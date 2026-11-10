import { afterEach, describe, expect, it, vi } from 'vitest';

import { docsHref } from '@/lib/docs-link';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('docsHref', () => {
  it.each([
    ['en-US', '/docs/getting-started'],
    ['zh-CN', '/docs/zh-cn/getting-started'],
    ['zh-TW', '/docs/zh-tw/getting-started'],
    ['ja-JP', '/docs/ja/getting-started'],
    ['ru-RU', '/docs/ru/getting-started'],
    ['ar-SA', '/docs/ar/getting-started'],
    ['de-DE', '/docs/getting-started'],
    ['ko-KR', '/docs/getting-started'],
  ])('maps %s to %s on the same origin by default', (locale, expected) => {
    vi.stubEnv('NEXT_PUBLIC_DOCS_URL', '');
    expect(docsHref(locale)).toBe(expected);
  });

  it('uses NEXT_PUBLIC_DOCS_URL as the base when set', () => {
    vi.stubEnv('NEXT_PUBLIC_DOCS_URL', 'https://docs.example.com');
    expect(docsHref('zh-CN')).toBe('https://docs.example.com/zh-cn/getting-started');
    expect(docsHref('en-US')).toBe('https://docs.example.com/getting-started');
  });

  it('trims trailing slashes and whitespace from NEXT_PUBLIC_DOCS_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_DOCS_URL', ' https://example.com/docs// ');
    expect(docsHref('ja-JP')).toBe('https://example.com/docs/ja/getting-started');
  });
});
