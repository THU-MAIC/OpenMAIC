/**
 * Client-supplied AliDocMind endpoints are limited to the official service.
 *
 * DocMind calls go through the vendor SDK, which builds its own HTTPS agent and
 * resolves the endpoint itself, so the request cannot be pinned to a validated
 * address the way the strict provider transport pins other providers. A
 * caller-chosen endpoint is therefore accepted only when it names the official
 * regional DocMind host; everything else is refused before any SDK call.
 * Server-managed endpoints are operator configuration and are not restricted.
 */

// `docmind-api.<region>.aliyuncs.com`, where the region is a real region id
// (e.g. cn-hangzhou, ap-southeast-1). The region shape matters: a looser
// label would also match hosts such as an object storage bucket domain.
const OFFICIAL_DOCMIND_HOST =
  /^docmind-api\.(?:cn|ap|us|eu|me|na|sa)-[a-z]+(?:-\d+)?\.aliyuncs\.com$/;

export const ALIDOCMIND_ENDPOINT_NOT_ALLOWED_MESSAGE =
  'Only official AliDocMind endpoints (docmind-api.<region>.aliyuncs.com) are supported';

/**
 * The normalized host of a client-supplied AliDocMind endpoint, or `null` when
 * it is not an official DocMind endpoint. Accepts a bare host or an `https://`
 * URL without credentials, port, path, query or fragment.
 */
export function resolveSafeClientAliDocMindEndpoint(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  return OFFICIAL_DOCMIND_HOST.test(host) ? host : null;
}
