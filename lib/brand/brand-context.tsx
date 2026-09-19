'use client';

/**
 * Brand context.
 *
 * The reference resolves the brand and the desktop flag on the server per
 * request (vendor UA parsing) and injects them through the provider. This
 * workspace is single-brand and has no desktop shell, so the provider accepts
 * the values as props (for future wiring) and defaults to the static brand /
 * non-desktop, which is also what the hooks read when no provider is mounted.
 */

import { createContext, useContext } from 'react';
import { DEFAULT_BRAND, type BrandConfig } from './brand-config';

interface BrandContextValue {
  brand: BrandConfig;
  /** Whether the request came from a desktop client (vendor UA marker). */
  isDesktop: boolean;
}

const BrandContext = createContext<BrandContextValue>({
  brand: DEFAULT_BRAND,
  isDesktop: false,
});

export function BrandProvider({
  brand = DEFAULT_BRAND,
  isDesktop = false,
  children,
}: {
  brand?: BrandConfig;
  isDesktop?: boolean;
  children: React.ReactNode;
}) {
  return <BrandContext.Provider value={{ brand, isDesktop }}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandConfig {
  return useContext(BrandContext).brand;
}

export function useIsDesktop(): boolean {
  return useContext(BrandContext).isDesktop;
}
