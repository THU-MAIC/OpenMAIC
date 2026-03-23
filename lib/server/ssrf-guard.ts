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

/**
 * Expand an IPv4-mapped IPv6 address (e.g. "::ffff:127.0.0.1" or "::ffff:7f00:1")
 * into its embedded IPv4 dotted-decimal form, or return null if not applicable.
 * Assumes the input has already been lowercased and brackets stripped by URL parsing.
 */
function extractIPv4FromMappedIPv6(hostname: string): string | null {
  // Dotted-decimal form: ::ffff:a.b.c.d or ::ffff:0:a.b.c.d (RFC 4291)
  const dottedMatch = hostname.match(
    /^(?:[0:]*:)?ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
  );
  if (dottedMatch) return dottedMatch[1];

  // Hex form: ::ffff:7f00:1 → 127.0.0.1
  // Each 16-bit group is always 0x0000–0xffff, so octets are always 0–255.
  const hexMatch = hostname.match(/^(?:[0:]*:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
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

  // URL.hostname for IPv6 addresses has brackets stripped (e.g. "::1", not "[::1]")
  const hostname = parsed.hostname.toLowerCase();

  // Resolve IPv4-mapped IPv6 addresses before applying IPv4 rules
  const embeddedIPv4 = extractIPv4FromMappedIPv6(hostname);
  if (embeddedIPv4 !== null) {
    if (isBlockedIPv4(embeddedIPv4)) {
      return 'Local/private network URLs are not allowed';
    }
    return null;
  }

  if (isBlockedHostname(hostname)) {
    return 'Local/private network URLs are not allowed';
  }

  return null;
}

/** Check whether an IPv4 dotted-decimal address is in a blocked range */
function isBlockedIPv4(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||
    isPrivate172(hostname)
  );
}

function isBlockedHostname(hostname: string): boolean {
  // Plain hostname / IPv4 checks
  if (
    hostname === 'localhost' ||
    isBlockedIPv4(hostname) ||
    hostname.endsWith('.local')
  ) {
    return true;
  }

  // IPv6-specific checks: only applied when the hostname looks like an IPv6
  // address (contains colons) to avoid false positives on regular domain names.
  if (hostname.includes(':')) {
    if (
      // Loopback ::1 and all-zeros ::
      hostname === '::1' ||
      hostname === '0:0:0:0:0:0:0:1' ||
      hostname === '::' ||
      hostname === '0:0:0:0:0:0:0:0' ||
      // Unique-local fc00::/7  (fc__ and fd__)
      /^f[cd][0-9a-f]{0,2}:/i.test(hostname) ||
      // Link-local fe80::/10  (fe80 – feBF)
      /^fe[89ab][0-9a-f]:/i.test(hostname)
    ) {
      return true;
    }
  }

  return false;
}
