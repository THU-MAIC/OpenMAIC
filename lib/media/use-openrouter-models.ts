'use client';

/**
 * Live OpenRouter model list for the image/video settings pickers.
 *
 * Every other media provider ships a fixed `models` array. OpenRouter's catalog
 * is large and moves, so the picker reads OpenRouter's public catalog directly
 * instead of a shortlist baked in here. The catalog supports browser CORS and
 * does not require authentication, so a server proxy would only add another
 * deployment function and another credential boundary. Returns `fallback`
 * untouched for every other provider, so callers use it as a drop-in for
 * `currentProvider.models`.
 *
 * On any failure the seeded registry list stays in place — a picker with three
 * usable entries beats an empty one.
 */
import { useEffect, useState } from 'react';

import { createLogger } from '@/lib/logger';

import { openRouterBaseUrl } from './adapters/openrouter-image-adapter';
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
    const catalogBaseUrl = openRouterBaseUrl(baseUrl);
    const isOfficialCatalog = catalogBaseUrl === 'https://openrouter.ai/api/v1';
    fetch(`${catalogBaseUrl}/${kind}s/models`, {
      // OpenRouter's official catalog is public. A custom gateway may require
      // the caller's own credential; it is sent only to the URL they entered.
      headers: !isOfficialCatalog && apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !Array.isArray(data?.data)) {
          log.warn(`Could not load OpenRouter ${kind} models; keeping the seeded list`, data);
          return;
        }
        const models = data.data
          .map((model: { id?: string; slug?: string; name?: string }) => {
            const id = model.id || model.slug || '';
            return { id, name: model.name || id };
          })
          .filter((model: ImageModelInfo) => model.id)
          .sort((a: ImageModelInfo, b: ImageModelInfo) => a.name.localeCompare(b.name));
        setLive(models);
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
