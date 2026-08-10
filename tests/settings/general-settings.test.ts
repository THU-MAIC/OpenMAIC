import { describe, expect, it, vi } from 'vitest';
import { clearCacheErrorMessage } from '@/components/settings/clear-cache-error-message';
import { AssetPoolDeletionDeferredError } from '@/lib/media/asset-pool';
import { runClearCache, shouldReloadAfterClear } from '@/components/settings/clear-cache-workflow';
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
  it('finishes independent cleanup and reports a blocked asset-pool delete as deferred', async () => {
    const deferred = new AssetPoolDeletionDeferredError();
    const clearLocalStorage = vi.fn();
    const clearSessionStorage = vi.fn();
    const clearPersistedStores = vi.fn().mockResolvedValue(undefined);

    await expect(
      runClearCache({
        clearDatabase: vi.fn().mockRejectedValue(deferred),
        clearLocalStorage,
        clearSessionStorage,
        clearPersistedStores,
      }),
    ).resolves.toEqual({ status: 'asset-pool-deferred', error: deferred });
    expect(clearLocalStorage).toHaveBeenCalledOnce();
    expect(clearSessionStorage).toHaveBeenCalledOnce();
    expect(clearPersistedStores).toHaveBeenCalledOnce();
  });

  it('stops subsequent cleanup for a hard database failure', async () => {
    const clearLocalStorage = vi.fn();
    const clearSessionStorage = vi.fn();
    const clearPersistedStores = vi.fn().mockResolvedValue(undefined);

    await expect(
      runClearCache({
        clearDatabase: vi.fn().mockRejectedValue(new Error('hard failure')),
        clearLocalStorage,
        clearSessionStorage,
        clearPersistedStores,
      }),
    ).rejects.toThrow('hard failure');
    expect(clearLocalStorage).not.toHaveBeenCalled();
    expect(clearSessionStorage).not.toHaveBeenCalled();
    expect(clearPersistedStores).not.toHaveBeenCalled();
  });

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

describe('reload decision after clearing', () => {
  it('reloads only when the clear completed', () => {
    expect(shouldReloadAfterClear({ status: 'cleared' })).toBe(true);
  });

  it('stays on the page when the asset-pool deletion is deferred', () => {
    // Reloading would discard the guidance asking the user to close the other
    // tab and retry, while the pool database is still on disk.
    expect(
      shouldReloadAfterClear({
        status: 'asset-pool-deferred',
        error: new AssetPoolDeletionDeferredError(),
      }),
    ).toBe(false);
  });
});
