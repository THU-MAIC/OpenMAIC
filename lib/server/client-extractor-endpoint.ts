/**
 * Validation of a client-supplied document/media extractor base URL.
 *
 * Most extractors reach their base URL through the strict provider transport,
 * so the URL guard at the route plus connect-time pinning covers them. An
 * extractor whose vendor SDK connects on its own cannot be pinned; for those a
 * client-supplied endpoint must be one of the vendor's official hosts. The
 * routes stay provider-neutral: they call these helpers and map a refusal to
 * `403 INVALID_URL`.
 */
import {
  ALIDOCMIND_ENDPOINT_NOT_ALLOWED_MESSAGE,
  resolveSafeClientAliDocMindEndpoint,
} from '@/lib/server/alidocmind-endpoint';
import { validateClientBaseUrl } from '@/lib/server/ssrf-guard';

export type ClientEndpointCheck = { ok: true; baseUrl: string } | { ok: false; message: string };

/** Extractors whose SDK cannot be pinned, keyed by provider id. */
const OFFICIAL_ENDPOINT_ONLY: Record<string, (endpoint: string) => ClientEndpointCheck> = {
  alidocmind: (endpoint) => {
    const host = resolveSafeClientAliDocMindEndpoint(endpoint);
    return host
      ? { ok: true, baseUrl: host }
      : { ok: false, message: ALIDOCMIND_ENDPOINT_NOT_ALLOWED_MESSAGE };
  },
};

/** Check a client-supplied base URL for the document extractor `providerId`. */
export async function checkClientDocumentExtractorBaseUrl(
  providerId: string,
  clientBaseUrl: string,
): Promise<ClientEndpointCheck> {
  const officialOnly = OFFICIAL_ENDPOINT_ONLY[providerId];
  if (officialOnly) return officialOnly(clientBaseUrl);
  const ssrfError = await validateClientBaseUrl(clientBaseUrl);
  return ssrfError ? { ok: false, message: ssrfError } : { ok: true, baseUrl: clientBaseUrl };
}

/**
 * Check a client-supplied base URL for media extraction. The only media
 * extractor that reads a base URL is AliDocMind, whose SDK cannot be pinned,
 * so the official-endpoint rule applies whichever media extractor is chosen.
 */
export function checkClientMediaExtractorBaseUrl(clientBaseUrl: string): ClientEndpointCheck {
  return OFFICIAL_ENDPOINT_ONLY.alidocmind!(clientBaseUrl);
}
