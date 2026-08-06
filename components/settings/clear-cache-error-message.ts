import { AssetPoolDeletionDeferredError } from '@/lib/media/asset-pool';

export function clearCacheErrorMessage(error: unknown, t: (key: string) => string): string {
  return t(
    error instanceof AssetPoolDeletionDeferredError
      ? 'settings.clearCacheBlockedByOtherTabs'
      : 'settings.clearCacheFailed',
  );
}
