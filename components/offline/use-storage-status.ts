'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getBrowserStorageSnapshot,
  requestPersistentStorage,
  type BrowserStorageSnapshot,
} from '@/lib/offline/storage';

export interface StorageStatusState {
  snapshot: BrowserStorageSnapshot | null;
  loading: boolean;
  requestingPersistence: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  requestPersistence: () => Promise<void>;
}

export function useStorageStatus(): StorageStatusState {
  const [snapshot, setSnapshot] = useState<BrowserStorageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestingPersistence, setRequestingPersistence] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await getBrowserStorageSnapshot());
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('无法读取浏览器存储状态'));
    } finally {
      setLoading(false);
    }
  }, []);

  const requestPersistence = useCallback(async () => {
    setRequestingPersistence(true);
    setError(null);
    try {
      setSnapshot(await requestPersistentStorage());
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('无法申请持久存储'));
    } finally {
      setRequestingPersistence(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { snapshot, loading, requestingPersistence, error, refresh, requestPersistence };
}
