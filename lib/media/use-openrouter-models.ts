'use client';

/**
 * Live OpenRouter model list for the image/video settings pickers.
 *
 * Every other media provider ships a fixed `models` array. OpenRouter's catalog
 * is large and moves, so the picker reads it from `/api/openrouter-models`
 * instead of a shortlist baked in here. Returns `fallback` untouched for every
 * other provider, so callers use it as a drop-in for `currentProvider.models`.
 *
 * On any failure the seeded registry list stays in place — a picker with three
 * usable entries beats an empty one.
 */
import { useEffect, useState } from 'react';

import { createLogger } from '@/lib/logger';

import type { ImageModelInfo } from './types';

const log = createLogger('OpenRouterModels');

export function useOpenRouterModels(
  kind: 'image' | 'video',
  isOpenRouter: boolean,
  fallback: ImageModelInfo[],
  apiKey?: string,
  baseUrl?: string,
): { models: ImageModelInfo[] } {
  const [live, setLive] = useState<ImageModelInfo[] | null>(null);

  useEffect(() => {
    if (!isOpenRouter) return;
    let cancelled = false;
    fetch(`/api/openrouter-models?kind=${kind}`, {
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(baseUrl ? { 'x-base-url': baseUrl } : {}),
      },
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !Array.isArray(data?.models)) {
          log.warn(`Could not load OpenRouter ${kind} models; keeping the seeded list`, data);
          return;
        }
        setLive(data.models as ImageModelInfo[]);
      })
      .catch((err) => {
        if (!cancelled) log.warn(`OpenRouter ${kind} model fetch failed`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, isOpenRouter, apiKey, baseUrl]);

  return { models: isOpenRouter && live ? live : fallback };
}
