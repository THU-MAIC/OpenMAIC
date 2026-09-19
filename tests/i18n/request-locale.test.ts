import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequestLocale } from '@/lib/i18n/request-locale';

const cookieValue: { current?: string } = {};
const acceptLanguage: { current?: string | null } = {};

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'locale' && cookieValue.current ? { value: cookieValue.current } : undefined,
  }),
  headers: async () => ({
    get: (name: string) => (name === 'accept-language' ? (acceptLanguage.current ?? null) : null),
  }),
}));

describe('getRequestLocale', () => {
  beforeEach(() => {
    cookieValue.current = undefined;
    acceptLanguage.current = undefined;
  });

  it('reads a supported locale cookie before Accept-Language', async () => {
    cookieValue.current = 'en-US';
    acceptLanguage.current = 'zh-CN,zh;q=0.9';
    await expect(getRequestLocale()).resolves.toBe('en-US');
  });

  it('maps an Accept-Language tag when no cookie is set', async () => {
    acceptLanguage.current = 'ja,en;q=0.8';
    await expect(getRequestLocale()).resolves.toBe('ja-JP');
  });

  it('falls back to defaultLocale when neither source matches', async () => {
    await expect(getRequestLocale()).resolves.toBe('zh-CN');
  });
});
