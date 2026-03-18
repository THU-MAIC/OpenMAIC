/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Validates URLs to prevent requests to internal/private network addresses.
 * Used by any API route that fetches a user-supplied URL server-side.
 */

/** Check if hostname is in the 172.16.0.0 - 172.31.255.255 private range */
function isPrivate172(hostname: string): boolean {
  if (!hostname.startsWith('172.')) return false;
  const second = parseInt(hostname.split('.')[1], 10);
  return second >= 16 && second <= 31;
}

/** Check if hostname is an IPv6 Unique Local Address (fd00::/8) */
function isIPv6ULA(hostname: string): boolean {
  // ULA range: fd00:: - fdff::
  return /^fd[0-9a-f]{2}:/.test(hostname);
}

/** Check if hostname contains IPv4-mapped IPv6 address (::ffff:x.x.x.x) */
function isIPv4MappedIPv6(hostname: string): boolean {
  return hostname.startsWith('::ffff:');
}

/**
 * Validate a URL against SSRF attacks.
 * Returns null if the URL is safe, or an error message string if blocked.
 */
export function validateUrlForSSRF(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only HTTP(S) URLs are allowed';
  }

  // Strip square brackets from IPv6 hostnames (URL parser keeps them)
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||
    isPrivate172(hostname) ||
    hostname.endsWith('.local') ||
    isIPv6ULA(hostname) ||
    hostname.startsWith('fe80') ||
    isIPv4MappedIPv6(hostname)
  ) {
    return 'Local/private network URLs are not allowed';
  }

  return null;
}
