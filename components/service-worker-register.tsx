'use client';

import { useEffect } from 'react';

/**
 * Registers the PWA service worker (production only). The SW caches static
 * assets + visited pages so the app loads fast and survives flaky 3G/4G, and
 * keeps already-opened lessons available offline. Registration failures are
 * non-fatal — the app works without it.
 *
 * `basePath` is passed from the server layout so the SW path/scope are correct
 * both standalone (root) and when mounted under a prefix (e.g. `/maic`).
 */
export function ServiceWorkerRegister({ basePath = '' }: { basePath?: string }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const swUrl = `${basePath}/sw.js?base=${encodeURIComponent(basePath)}`;
    navigator.serviceWorker.register(swUrl, { scope: `${basePath}/` }).catch(() => {
      /* non-fatal: app works without the service worker */
    });
  }, [basePath]);

  return null;
}
