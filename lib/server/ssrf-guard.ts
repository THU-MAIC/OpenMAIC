/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Validates URLs to prevent requests to internal/private network addresses.
 * Used by any API route that fetches a user-supplied URL server-side.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

function normalizeAddress(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\.+$/, '');
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN;
    }
    return Number.parseInt(part, 10);
  });

  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
}

function extractMappedIPv4(ip: string): string | null {
  const normalized = normalizeAddress(ip);
  if (!normalized.startsWith('::ffff:')) {
    return null;
  }

  const suffix = normalized.slice('::ffff:'.length);
  const dottedIPv4 = parseIPv4(suffix);
  if (dottedIPv4) {
    return dottedIPv4.join('.');
  }

  const parts = suffix.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }

  const [high, low] = parts.map((part) => Number.parseInt(part, 16));
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function getFirstIPv6Hextet(ip: string): number | null {
  const normalized = normalizeAddress(ip);
  if (!normalized.includes(':')) {
    return null;
  }

  if (normalized.startsWith('::')) {
    return 0;
  }

  const [firstHextet] = normalized.split(':');
  if (!firstHextet || !/^[0-9a-f]{1,4}$/.test(firstHextet)) {
    return null;
  }

  return Number.parseInt(firstHextet, 16);
}

/** Expand an IPv6 address into 8 numeric hextets. Returns null for invalid input. */
function expandIPv6(ip: string): number[] | null {
  const normalized = normalizeAddress(ip);
  if (!normalized.includes(':')) return null;

  // Skip IPv4-suffix forms (handled separately by extractMappedIPv4)
  const lastPart = normalized.split(':').pop() || '';
  if (lastPart.includes('.')) return null;

  const sides = normalized.split('::');
  if (sides.length > 2) return null;

  let parts: string[];
  if (sides.length === 2) {
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    parts = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    parts = normalized.split(':');
  }

  if (parts.length !== 8) return null;
  if (parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;

  return parts.map((p) => Number.parseInt(p, 16));
}

export function isPrivateIP(ip: string): boolean {
  const normalized = normalizeAddress(ip);
  const mappedIPv4 = extractMappedIPv4(normalized);
  if (mappedIPv4) {
    return isPrivateIP(mappedIPv4);
  }

  const ipv4 = parseIPv4(normalized);
  if (ipv4) {
    const [first, second, third, fourth] = ipv4;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 0 && second === 0 && third === 0 && fourth === 0)
    );
  }

  const ipv6FirstHextet = getFirstIPv6Hextet(normalized);
  if (ipv6FirstHextet === null) {
    return false;
  }

  if (normalized === '::' || normalized === '::1') {
    return true;
  }

  if (
    (ipv6FirstHextet & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (ipv6FirstHextet & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (ipv6FirstHextet & 0xffc0) === 0xfec0 // fec0::/10 site-local (deprecated)
  ) {
    return true;
  }

  // 6to4 tunnel: 2002::/16 — embedded IPv4 sits in bits 16-47
  if (ipv6FirstHextet === 0x2002) {
    const hextets = expandIPv6(normalized);
    if (hextets) {
      const embedded = `${hextets[1] >> 8}.${hextets[1] & 0xff}.${hextets[2] >> 8}.${hextets[2] & 0xff}`;
      if (isPrivateIP(embedded)) return true;
    }
  }

  // Teredo tunnel: 2001:0000::/32 — client IPv4 in last 32 bits, XOR-inverted
  if (ipv6FirstHextet === 0x2001) {
    const hextets = expandIPv6(normalized);
    if (hextets && hextets[1] === 0x0000) {
      const high = hextets[6] ^ 0xffff;
      const low = hextets[7] ^ 0xffff;
      const embedded = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      if (isPrivateIP(embedded)) return true;
    }
  }

  return false;
}

/**
 * Validate a URL against SSRF attacks.
 * Returns null if the URL is safe, or an error message string if blocked.
 */
export async function validateUrlForSSRF(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only HTTP(S) URLs are allowed';
  }

  // Self-hosted deployments can set ALLOW_LOCAL_NETWORKS=true to skip private-IP checks
  const allowLocal = process.env.ALLOW_LOCAL_NETWORKS;
  if (allowLocal === 'true' || allowLocal === '1') {
    return null;
  }

  const hostname = normalizeAddress(parsed.hostname);
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    isPrivateIP(hostname)
  ) {
    return 'Local/private network URLs are not allowed';
  }

  if (isIP(hostname)) {
    return null;
  }

  let resolvedAddresses: Array<{ address: string; family: number }>;
  try {
    resolvedAddresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return 'Unable to verify hostname safety';
  }

  if (resolvedAddresses.length === 0) {
    return 'Unable to verify hostname safety';
  }

  if (resolvedAddresses.some(({ address }) => isPrivateIP(address))) {
    return 'Local/private network URLs are not allowed';
  }

  return null;
}
