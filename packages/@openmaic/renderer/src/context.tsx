'use client';

import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import type {
  PPTElement,
  PPTImageElement,
  PPTVideoElement,
  Slide,
  SlideBackground,
} from '@openmaic/dsl';
import type { SlideEffects } from './types/effects';

export interface SlideContextValue {
  slide: Slide;
  scale?: number;
  background?: SlideBackground;
  effects?: SlideEffects;
  renderImage?: (element: PPTImageElement, resolvedSrc: string) => ReactNode;
  renderVideo?: (element: PPTVideoElement) => ReactNode;
  onElementClick?: (element: PPTElement, event: React.MouseEvent) => void;
}

const SlideContext = createContext<SlideContextValue | null>(null);

export interface SlideRendererProviderProps extends SlideContextValue {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function SlideRendererProvider({
  children,
  className,
  style,
  ...value
}: SlideRendererProviderProps) {
  return (
    <SlideContext.Provider value={value}>
      {className || style ? (
        <div className={className} style={style}>
          {children}
        </div>
      ) : (
        children
      )}
    </SlideContext.Provider>
  );
}

/**
 * Read the closest SlideRendererProvider value.
 * Throws if used outside a provider — use `useOptionalSlideContext` for nullable access.
 */
export function useSlideContext(): SlideContextValue {
  const value = useContext(SlideContext);
  if (!value) {
    throw new Error(
      'useSlideContext must be used inside a <SlideRendererProvider>. ' +
        'Pass props directly to <SlideCanvas> if you do not need the provider.',
    );
  }
  return value;
}

/** Nullable variant; returns null when outside a provider. */
export function useOptionalSlideContext(): SlideContextValue | null {
  return useContext(SlideContext);
}
