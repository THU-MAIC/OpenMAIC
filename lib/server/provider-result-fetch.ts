/**
 * Fetch a URL a media provider returned in its response (a generated image,
 * video or poster).
 *
 * The URL comes from the provider, not from configuration, so it is held to
 * the strict public policy whatever address policy the provider's own base URL
 * runs under: HTTPS only, public addresses only (never the operator's
 * ALLOW_LOCAL_NETWORKS opt-in). The strict transport re-validates every
 * redirect hop under the same policy and pins connect-time DNS to the vetted
 * answers. A `data:` URL (some adapters inline their result) is decoded locally
 * and never touches the network.
 *
 * Callers pass their byte limit: a `data:` URL is refused over it before it is
 * decoded, and a network body must still be read with a bounded reader.
 */
import { providerFetch, type ProviderFetchPolicy } from '@/lib/server/provider-fetch';
import { UnsafeNetworkTargetError, validateUrlForSSRFWithPolicy } from '@/lib/server/ssrf-guard';

export const PROVIDER_RESULT_URL_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: false,
  requireHttps: true,
};

function dataUrlTooLarge(maxBytes: number): Error {
  return new Error(`Download failed: data URL exceeds the ${maxBytes}-byte limit`);
}

/**
 * Decode a `data:` URL into its bytes and declared MIME type, refusing a payload
 * over `maxBytes`. The size is estimated from the encoded length first, so an
 * oversized payload is refused before any buffer is built: base64 decodes to
 * 3/4 of its length less padding, and a percent-encoded byte takes at most
 * three characters.
 */
export function decodeDataUrl(url: string, maxBytes: number): { bytes: Buffer; mimeType: string } {
  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) {
    throw new Error('Invalid data URL: missing comma');
  }
  const meta = url.slice(5, commaIndex);
  const rawData = url.slice(commaIndex + 1);
  const params = meta.split(';');
  const base64 = params.includes('base64');
  const estimated = base64
    ? Math.floor((rawData.length * 3) / 4) - (rawData.match(/=*$/)?.[0].length ?? 0)
    : Math.ceil(rawData.length / 3);
  if (estimated > maxBytes) throw dataUrlTooLarge(maxBytes);
  const bytes = base64
    ? Buffer.from(rawData, 'base64')
    : Buffer.from(decodeURIComponent(rawData), 'utf8');
  if (bytes.byteLength > maxBytes) throw dataUrlTooLarge(maxBytes);
  return { bytes, mimeType: params[0]?.trim().toLowerCase() || 'application/octet-stream' };
}

export async function fetchProviderResultUrl(
  url: string,
  init: { signal?: AbortSignal; maxBytes: number },
): Promise<Response> {
  if (url.startsWith('data:')) {
    const { bytes, mimeType } = decodeDataUrl(url, init.maxBytes);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': mimeType, 'content-length': String(bytes.byteLength) },
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Download failed: invalid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Download failed: URL must use https (${parsed.protocol})`);
  }

  const ssrfError = await validateUrlForSSRFWithPolicy(parsed.href, { allowLocalNetworks: false });
  if (ssrfError) throw new UnsafeNetworkTargetError(ssrfError);

  return providerFetch(url, init.signal ? { signal: init.signal } : {}, PROVIDER_RESULT_URL_POLICY);
}
