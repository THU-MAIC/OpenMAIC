'use client';

import { createContext, useContext } from 'react';

/**
 * Provides the current stageId to media-aware components (BaseImageElement, BaseVideoElement).
 *
 * When set, these components subscribe to the media generation store and only use
 * tasks whose stageId matches (preventing cross-course contamination).
 * When undefined (e.g. homepage thumbnails), store subscription is skipped entirely.
 */
const MediaStageContext = createContext<string | undefined>(undefined);

export const MediaStageProvider = MediaStageContext.Provider;

export function useMediaStageId(): string | undefined {
  return useContext(MediaStageContext);
}
