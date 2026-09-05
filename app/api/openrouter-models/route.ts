/**
 * /api/openrouter-models — live OpenRouter image/video model catalogs.
 *
 * The other media providers ship a hardcoded `models` array. OpenRouter hosts
 * dozens of models across many upstream vendors and adds more continuously, so
 * pinning a shortlist here would decide for the user which models exist. This
 * route proxies OpenRouter's own catalog instead:
 *
 * - GET /api/openrouter-models?kind=image → GET {base}/images/models
 * - GET /api/openrouter-models?kind=video → GET {base}/videos/models
 *
 * The key never reaches the browser: it is read from the server env when
 * configured, and otherwise taken from the caller's own settings via the
 * `x-api-key` header (the same pattern `/api/verify-image-provider` uses).
 * Both catalog endpoints are readable with any valid key and cost nothing.
 */
import type { NextRequest } from 'next/server';

import {
  OPENROUTER_DEFAULT_BASE_URL,
  openRouterBaseUrl,
} from '@/lib/media/adapters/openrouter-image-adapter';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

/** Cache the upstream catalog briefly — it changes on the order of days. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; models: Array<{ id: string; name: string }> }>();

interface OpenRouterCatalogEntry {
  id?: string;
  slug?: string;
  name?: string;
}

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get('kind');
  if (kind !== 'image' && kind !== 'video') {
    return apiError('INVALID_REQUEST', 400, "kind must be 'image' or 'video'");
  }

  // Both catalogs answer 200 unauthenticated, so the picker fills before a key
  // is pasted. A key is still forwarded when there is one, since a self-hosted
  // or proxied base URL may well require it.
  const apiKey =
    (kind === 'image'
      ? process.env.IMAGE_OPENROUTER_API_KEY?.trim()
      : process.env.VIDEO_OPENROUTER_API_KEY?.trim()) ||
    req.headers.get('x-api-key')?.trim() ||
    '';

  // Same normalisation the adapters use: a saved base URL that already ends in
  // /images or /videos would otherwise ask for `/images/images/models` and 404.
  const baseUrl = openRouterBaseUrl(
    req.headers.get('x-base-url')?.trim() ||
      (kind === 'image'
        ? process.env.IMAGE_OPENROUTER_BASE_URL?.trim()
        : process.env.VIDEO_OPENROUTER_BASE_URL?.trim()),
  );

  const cacheKey = `${kind}:${baseUrl}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json({ models: hit.models, cached: true });
  }

  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const read = (base: string) =>
    fetch(`${base}/${kind}s/models`, { method: 'GET', headers }).catch(() => null);

  // A saved base URL is a free-text field, so any typo would otherwise empty
  // the model picker. Fall back to the public catalog rather than fail: the
  // list is read-only, and a wrong base URL still surfaces at generation time.
  let upstream = await read(baseUrl);
  if ((!upstream || !upstream.ok) && baseUrl !== OPENROUTER_DEFAULT_BASE_URL) {
    upstream = await read(OPENROUTER_DEFAULT_BASE_URL);
  }

  if (!upstream || !upstream.ok) {
    const text = upstream ? await upstream.text().catch(() => '') : 'unreachable';
    return apiError('UPSTREAM_ERROR', 502, `OpenRouter ${kind} catalog failed: ${text}`);
  }

  const body = (await upstream.json()) as { data?: OpenRouterCatalogEntry[] };
  const models = (body.data ?? [])
    .map((m) => {
      const id = m.id || m.slug || '';
      return { id, name: m.name || id };
    })
    .filter((m) => m.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  cache.set(cacheKey, { at: Date.now(), models });
  return Response.json({ models, cached: false });
}
