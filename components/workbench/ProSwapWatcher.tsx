'use client';

/**
 * Reports route arrivals to `pro-swap`, from the root layout.
 *
 * The Pro swap has to know when the destination route has rendered, and the
 * component that started it (a badge on the page that is leaving) is gone by
 * then. This one is mounted in `app/layout.tsx`, above `children`, so it
 * survives every navigation and can be the one that says "we are there".
 *
 * Renders nothing.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { proSwapArrived } from '@/lib/workbench/pro-swap';

export function ProSwapWatcher() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname) proSwapArrived(pathname);
  }, [pathname]);

  return null;
}
