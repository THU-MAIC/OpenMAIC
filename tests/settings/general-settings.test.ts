import { describe, expect, it } from 'vitest';
import { clearCacheErrorMessage } from '@/components/settings/clear-cache-error-message';
import { AssetPoolDeletionDeferredError } from '@/lib/media/asset-pool';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import enUS from '@/lib/i18n/locales/en-US.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';

const locales = { arSA, enUS, esMX, jaJP, koKR, ptBR, ruRU, zhCN, zhTW } as const;

describe('general settings clear-cache errors', () => {
  it.each(Object.entries(locales))('%s defines the blocked-by-tabs guidance', (_code, locale) => {
    expect(locale.settings.clearCacheBlockedByOtherTabs.trim()).not.toBe('');
  });

  it('maps the deferred deletion error to the actionable English guidance', () => {
    const t = (key: string) => {
      if (key === 'settings.clearCacheBlockedByOtherTabs') {
        return enUS.settings.clearCacheBlockedByOtherTabs;
      }
      return enUS.settings.clearCacheFailed;
    };

    expect(clearCacheErrorMessage(new AssetPoolDeletionDeferredError(), t)).toBe(
      'Close other app tabs and retry.',
    );
  });
});
