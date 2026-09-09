/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Validates URLs to prevent requests to internal/private network addresses.
 * Used by any API route that fetches a user-supplied URL server-side.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

const CLOUD_METADATA_HOSTNAMES = new Set(['metadata.google.internal']);
// Instance metadata and credential endpoints. A fixed list, not a general
// link-local block: AWS/Azure/GCP/OCI/DigitalOcean/Hetzner/OpenStack IMDS,
// AWS ECS task credentials, EKS Pod Identity, AWS IMDS over IPv6, Alibaba
// Cloud metadata, Azure WireServer and the legacy OCI IMDS address.
const CLOUD_METADATA_ADDRESSES = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '169.254.170.23',
  'fd00:ec2::254',
  'fd00:ec2::23',
  '100.100.100.200',
  '168.63.129.16',
  '192.0.0.192',
]);
/** Upper bound on the DNS lookup done under ALLOW_LOCAL_NETWORKS; on expiry the target is allowed. */
const ALLOW_LOCAL_DNS_TIMEOUT_MS = 3_000;

export class UnsafeNetworkTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeNetworkTargetError';
  }
}

function normalizeAddress(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\.+$/, '');
}

/**
 * Canonical textual form of an IP literal, unwrapping IPv4-mapped IPv6 so that
 * `::ffff:169.254.169.254` compares equal to `169.254.169.254`. Returns null
 * when the value is not a parseable IP literal.
 */
function canonicalizeIp(value: string): string | null {
  const normalized = normalizeAddress(value);
  let address: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    address = ipaddr.parse(normalized);
  } catch {
    return null;
  }
  if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
    address = (address as ipaddr.IPv6).toIPv4Address();
  }
  return address.toString().toLowerCase();
}

/**
 * IPv4 addresses carried inside an IPv6 literal by a transition mechanism:
 * 6to4 (2002::/16), Teredo (2001:0::/32, XOR-inverted), ISATAP interface
 * identifiers and NAT64 (64:ff9b::/96). Empty when none applies.
 */
function tunnelEmbeddedIPv4(normalized: string): string[] {
  const hextets = expandIPv6(normalized);
  if (!hextets) return [];
  const dotted = (high: number, low: number) =>
    `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  const embedded: string[] = [];
  if (hextets[0] === 0x2002) embedded.push(dotted(hextets[1], hextets[2]));
  if (hextets[0] === 0x2001 && hextets[1] === 0x0000) {
    embedded.push(dotted(hextets[6] ^ 0xffff, hextets[7] ^ 0xffff));
  }
  if ((hextets[4] === 0x0000 || hextets[4] === 0x0200) && hextets[5] === 0x5efe) {
    embedded.push(dotted(hextets[6], hextets[7]));
  }
  if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((h) => h === 0)) {
    embedded.push(dotted(hextets[6], hextets[7]));
  }
  return embedded;
}

/**
 * True when an IP literal (URL host or DNS answer) is a cloud metadata address,
 * directly, as IPv4-mapped IPv6, or embedded through a tunnel prefix.
 */
function isCloudMetadataAddress(value: string): boolean {
  const canonical = canonicalizeIp(value);
  if (canonical === null) return false;
  if (CLOUD_METADATA_ADDRESSES.has(canonical)) return true;
  return tunnelEmbeddedIPv4(canonical).some((embedded) => CLOUD_METADATA_ADDRESSES.has(embedded));
}

/** dns.lookup bounded by a timer; resolves to null on timeout so the caller decides. */
async function lookupWithTimeout(
  hostname: string,
  timeoutMs: number,
): Promise<Array<{ address: string; family: number }> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([dns.lookup(hostname, { all: true, verbatim: true }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Assert that a connection address is globally routable unicast.
 * IPv4-mapped IPv6 is classified as IPv4 so ::ffff:127.0.0.1 cannot hide.
 */
export function assertSafeIp(value: string): void {
  const canonical = canonicalizeIp(value);
  if (canonical === null) {
    throw new UnsafeNetworkTargetError(`Unable to classify network address: ${value}`);
  }
  if (
    isCloudMetadataAddress(canonical) ||
    isPrivateIP(canonical) ||
    ipaddr.parse(canonical).range() !== 'unicast'
  ) {
    throw new UnsafeNetworkTargetError('Local/private/reserved network URLs are not allowed');
  }
}

/** Strict URL-layer validation for outbound material fetches (no DNS side effects). */
export function normalizeUrlForStrictFetch(value: string): URL {
  let parsed: URL;
  try {
    // WHATWG parsing canonicalizes legacy decimal/octal IPv4 spellings before checks.
    parsed = new URL(value);
  } catch {
    throw new UnsafeNetworkTargetError('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeNetworkTargetError('Only HTTP(S) URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeNetworkTargetError('URLs containing userinfo are not allowed');
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new UnsafeNetworkTargetError('Only ports 80 and 443 are allowed');
  }
  const hostname = normalizeAddress(parsed.hostname);
  if (
    CLOUD_METADATA_HOSTNAMES.has(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.local')
  ) {
    throw new UnsafeNetworkTargetError('Local/private/reserved network URLs are not allowed');
  }
  // IP literals never invoke lookup in Node/undici, so this branch is mandatory.
  if (isIP(hostname)) assertSafeIp(hostname);
  return parsed;
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
  let normalized = normalizeAddress(ip);
  if (!normalized.includes(':')) return null;

  const lastPart = normalized.split(':').pop() || '';
  if (lastPart.includes('.')) {
    const dottedIPv4 = parseIPv4(lastPart);
    if (!dottedIPv4) return null;

    const [first, second, third, fourth] = dottedIPv4;
    const high = ((first << 8) | second).toString(16);
    const low = ((third << 8) | fourth).toString(16);
    normalized = `${normalized.slice(0, -lastPart.length)}${high}:${low}`;
  }

  const sides = normalized.split('::');
  if (sides.length > 2) return null;

  let parts: string[];
  if (sides.length === 2) {
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing <= 0) return null;
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

  // Transition mechanisms (6to4, Teredo, ISATAP, NAT64) carry an IPv4
  // address inside the IPv6 literal; classify by the embedded address.
  if (tunnelEmbeddedIPv4(normalized).some((embedded) => isPrivateIP(embedded))) {
    return true;
  }

  return false;
}

const CLOUD_METADATA_BLOCK_MESSAGE =
  'Cloud instance metadata endpoints are never allowed as outbound targets, even with ALLOW_LOCAL_NETWORKS=true.';

const LOCAL_NETWORK_BLOCK_MESSAGE =
  'Local/private network URLs are not allowed. If this is a self-hosted deployment or internal gateway (including split-horizon DNS), set ALLOW_LOCAL_NETWORKS=true to allow local network targets.';

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

  // Self-hosted deployments can set ALLOW_LOCAL_NETWORKS=true to skip private-IP
  // checks. Cloud instance metadata endpoints stay blocked either way.
  const allowLocal =
    process.env.ALLOW_LOCAL_NETWORKS === 'true' || process.env.ALLOW_LOCAL_NETWORKS === '1';
  const hostname = normalizeAddress(parsed.hostname);

  // Cloud metadata endpoints are never allowed, with or without the flag.
  if (CLOUD_METADATA_HOSTNAMES.has(hostname) || isCloudMetadataAddress(hostname)) {
    return CLOUD_METADATA_BLOCK_MESSAGE;
  }

  if (allowLocal) {
    // The flag is for loopback/RFC1918/.local targets (local Ollama, compose
    // networks, split-horizon DNS).
    if (isIP(hostname)) {
      return null;
    }
    // Non-IP hostname: fail open when DNS errors, times out or returns nothing
    // (split-horizon DNS is an explicit flag use case), but never when an
    // answer is a metadata address. This is a best-effort check against
    // misconfiguration, not a defence against DNS rebinding: the provider
    // fetch resolves the name again.
    let resolvedAddresses: Array<{ address: string; family: number }> | null;
    try {
      resolvedAddresses = await lookupWithTimeout(hostname, ALLOW_LOCAL_DNS_TIMEOUT_MS);
    } catch {
      return null;
    }
    if (resolvedAddresses?.some(({ address }) => isCloudMetadataAddress(address))) {
      return CLOUD_METADATA_BLOCK_MESSAGE;
    }
    return null;
  }

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    isPrivateIP(hostname)
  ) {
    return LOCAL_NETWORK_BLOCK_MESSAGE;
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

  if (resolvedAddresses.some(({ address }) => isCloudMetadataAddress(address))) {
    return CLOUD_METADATA_BLOCK_MESSAGE;
  }

  if (resolvedAddresses.some(({ address }) => isPrivateIP(address))) {
    return LOCAL_NETWORK_BLOCK_MESSAGE;
  }

  return null;
}
