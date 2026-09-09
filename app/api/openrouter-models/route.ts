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
 * Credential boundary: the operator's server key is only ever sent to the
 * operator's own base URL. A client-supplied `x-base-url` is SSRF-validated and
 * carries only that client's own `x-api-key` — the server key is dropped — so no
 * request can steer an operator credential to an attacker-chosen host. Both
 * catalogs answer 200 unauthenticated, so the picker still fills without a key.
 */
import { createHash } from 'node:crypto';

import type { NextRequest } from 'next/server';

import {
  OPENROUTER_DEFAULT_BASE_URL,
  openRouterBaseUrl,
} from '@/lib/media/adapters/openrouter-image-adapter';
import { apiError } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

export const runtime = 'nodejs';

/** Cache the upstream catalog briefly — it changes on the order of days. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Bound the map: client-supplied base URLs would otherwise grow it without limit. */
const CACHE_MAX_ENTRIES = 64;
const UPSTREAM_TIMEOUT_MS = 10_000;
const cache = new Map<string, { at: number; models: Array<{ id: string; name: string }> }>();

/** Cache-key discriminator for a credential. Never logged, never returned. */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function cacheSet(key: string, models: Array<{ id: string; name: string }>): void {
  // Oldest-first eviction: Map preserves insertion order.
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), models });
}

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

  // Same normalisation the adapters use: a saved base URL that already ends in
  // /images or /videos would otherwise ask for `/images/images/models` and 404.
  const envBaseUrl = openRouterBaseUrl(
    kind === 'image'
      ? process.env.IMAGE_OPENROUTER_BASE_URL?.trim()
      : process.env.VIDEO_OPENROUTER_BASE_URL?.trim(),
  );
  const clientBaseUrl = req.headers.get('x-base-url')?.trim();

  // CREDENTIAL BOUNDARY. The server key is operator property: it may only ever
  // travel to the operator's own base URL. A client-supplied URL is paired
  // exclusively with that client's own key, so no request can steer the
  // server's credential to an attacker-chosen host.
  let baseUrl = envBaseUrl;
  let apiKey =
    (kind === 'image'
      ? process.env.IMAGE_OPENROUTER_API_KEY?.trim()
      : process.env.VIDEO_OPENROUTER_API_KEY?.trim()) || '';

  if (clientBaseUrl) {
    const normalized = openRouterBaseUrl(clientBaseUrl);
    if (normalized !== envBaseUrl) {
      // Untrusted destination: validate it, then drop the server key entirely.
      const ssrfError = await validateUrlForSSRF(normalized);
      if (ssrfError) return apiError('INVALID_URL', 403, ssrfError);
      baseUrl = normalized;
      apiKey = req.headers.get('x-api-key')?.trim() || '';
    }
  } else if (!apiKey) {
    // No server key configured: the caller's own key may be used against the
    // operator's own base URL, which is not attacker-controlled.
    apiKey = req.headers.get('x-api-key')?.trim() || '';
  }

  // Cache per destination *and* per credential source, so one caller's
  // key-authorised catalog can never be served to another caller.
  const cacheKey = `${kind}:${baseUrl}:${apiKey ? hashKey(apiKey) : 'anon'}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json({ models: hit.models, cached: true });
  }

  const read = (base: string, key: string) =>
    fetch(`${base}/${kind}s/models`, {
      method: 'GET',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      // A redirect could otherwise carry the Authorization header to another
      // host, re-opening the exfiltration path the checks above close.
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }).catch(() => null);

  // A saved base URL is a free-text field, so any typo would otherwise empty
  // the model picker. Fall back to the public catalog rather than fail: the
  // list is read-only, and a wrong base URL still surfaces at generation time.
  // The fallback is unauthenticated — the catalogs answer 200 without a key,
  // and a credential chosen for one host must not follow to another.
  let upstream = await read(baseUrl, apiKey);
  if ((!upstream || !upstream.ok) && baseUrl !== OPENROUTER_DEFAULT_BASE_URL) {
    upstream = await read(OPENROUTER_DEFAULT_BASE_URL, '');
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

  cacheSet(cacheKey, models);
  return Response.json({ models, cached: false });
}
