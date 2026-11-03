'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { MOBILE_LAYOUT_QUERY } from './media-queries';
import { useMediaQuery } from '@/lib/hooks/use-media-query';

const InitialMobileLayout = createContext(false);

/** Only a hydration hint; this provider owns no runtime or page state. */
export function AdaptiveProvider({
  initialMobileLayout,
  children,
}: {
  initialMobileLayout: boolean;
  children?: ReactNode;
}) {
  return (
    <InitialMobileLayout.Provider value={initialMobileLayout}>
      {children}
    </InitialMobileLayout.Provider>
  );
}

export function useMobileLayout(): boolean {
  return useMediaQuery(MOBILE_LAYOUT_QUERY, useContext(InitialMobileLayout));
}
