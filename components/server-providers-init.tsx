'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Fetches server-configured providers on mount and merges into settings store.
 * Renders nothing — purely a side-effect component.
 */
export function ServerProvidersInit() {
  const fetchServerProviders = useSettingsStore((state) => state.fetchServerProviders);

  useEffect(() => {
    if (navigator.onLine) {
      void fetchServerProviders();
      return;
    }

    const fetchWhenOnline = () => void fetchServerProviders();
    window.addEventListener('online', fetchWhenOnline, { once: true });
    return () => window.removeEventListener('online', fetchWhenOnline);
  }, [fetchServerProviders]);

  return null;
}
