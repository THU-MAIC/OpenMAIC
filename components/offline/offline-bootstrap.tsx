'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import {
  registerOpenMaicServiceWorker,
  warmOpenMaicOfflinePages,
} from '@/lib/offline/service-worker';

const WORKSPACE_SHELL_PAGES = ['/', '/courses', '/imports', '/offline', '/library', '/create'];

/** Mount once near the application root to enable the production PWA shell. */
export function OfflineBootstrap() {
  const pathname = usePathname();

  useEffect(() => {
    void registerOpenMaicServiceWorker();
  }, []);

  useEffect(() => {
    warmOpenMaicOfflinePages([...WORKSPACE_SHELL_PAGES, pathname]);
  }, [pathname]);

  return null;
}
