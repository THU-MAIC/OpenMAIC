export interface BrowserStorageSnapshot {
  supported: boolean;
  persistenceSupported: boolean;
  persisted: boolean | null;
  usage: number;
  quota: number;
  usageRatio: number | null;
  available: number;
  usageDetails: Record<string, number>;
}

function emptySnapshot(): BrowserStorageSnapshot {
  return {
    supported: false,
    persistenceSupported: false,
    persisted: null,
    usage: 0,
    quota: 0,
    usageRatio: null,
    available: 0,
    usageDetails: {},
  };
}

export async function getBrowserStorageSnapshot(): Promise<BrowserStorageSnapshot> {
  if (typeof navigator === 'undefined' || !navigator.storage) return emptySnapshot();

  const storage = navigator.storage;
  const [estimate, persisted] = await Promise.all([
    storage.estimate().catch(() => ({ usage: 0, quota: 0 }) as StorageEstimate),
    typeof storage.persisted === 'function' ? storage.persisted().catch(() => null) : null,
  ]);

  const usage = estimate.usage ?? 0;
  const quota = estimate.quota ?? 0;
  const rawDetails = (
    estimate as StorageEstimate & {
      usageDetails?: Record<string, number>;
    }
  ).usageDetails;

  return {
    supported: true,
    persistenceSupported: typeof storage.persist === 'function',
    persisted,
    usage,
    quota,
    usageRatio: quota > 0 ? Math.min(usage / quota, 1) : null,
    available: Math.max(quota - usage, 0),
    usageDetails: rawDetails ? { ...rawDetails } : {},
  };
}

/**
 * Ask the browser not to evict local course data under storage pressure.
 * Call this directly from a user gesture; browsers may reject silent requests.
 */
export async function requestPersistentStorage(): Promise<BrowserStorageSnapshot> {
  if (typeof navigator === 'undefined' || !navigator.storage) return emptySnapshot();

  if (typeof navigator.storage.persist === 'function') {
    await navigator.storage.persist();
  }

  return getBrowserStorageSnapshot();
}

export function formatStorageBytes(bytes: number, locale = 'zh-CN'): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value >= 10 || unitIndex === 0 ? 0 : 1,
  }).format(value)} ${units[unitIndex]}`;
}
