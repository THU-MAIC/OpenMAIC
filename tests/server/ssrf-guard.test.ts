import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock('node:dns', () => ({
  promises: {
    lookup: lookupMock,
  },
}));

const PRIVATE_NETWORK_BLOCK_MESSAGE =
  'Local/private network URLs are not allowed. If this is a self-hosted deployment or internal gateway (including split-horizon DNS), set ALLOW_LOCAL_NETWORKS=true to allow local network targets.';
const ALLOW_LOCAL_NETWORKS_GUIDANCE = 'ALLOW_LOCAL_NETWORKS=true';
const originalAllowLocalNetworks = process.env.ALLOW_LOCAL_NETWORKS;

describe('validateUrlForSSRF', () => {
  beforeEach(() => {
    vi.resetModules();
    lookupMock.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
  });

  afterEach(() => {
    if (originalAllowLocalNetworks === undefined) {
      delete process.env.ALLOW_LOCAL_NETWORKS;
    } else {
      process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocalNetworks;
    }
  });

  it('allows a public hostname when DNS resolves to a public IP', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://api.openai.com')).resolves.toBeNull();
    expect(lookupMock).toHaveBeenCalledWith('api.openai.com', { all: true, verbatim: true });
  });

  it('allows a public IP literal without DNS lookup', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://8.8.8.8')).resolves.toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows a public IPv6 literal without DNS lookup', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://[2606:4700:4700::1111]')).resolves.toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects invalid URLs and non-http protocols', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('not-a-url')).resolves.toBe('Invalid URL');
    await expect(validateUrlForSSRF('ftp://example.com')).resolves.toBe(
      'Only HTTP(S) URLs are allowed',
    );
    await expect(validateUrlForSSRF('file:///etc/passwd')).resolves.toBe(
      'Only HTTP(S) URLs are allowed',
    );
    await expect(validateUrlForSSRF('javascript:alert(1)')).resolves.toBe(
      'Only HTTP(S) URLs are allowed',
    );
  });

  it('rejects blocked hostnames immediately', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    const localhostResult = await validateUrlForSSRF('http://localhost');
    expect(localhostResult).toBe(PRIVATE_NETWORK_BLOCK_MESSAGE);
    expect(localhostResult).toContain(ALLOW_LOCAL_NETWORKS_GUIDANCE);
    await expect(validateUrlForSSRF('http://printer.local')).resolves.toBe(
      PRIVATE_NETWORK_BLOCK_MESSAGE,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects private IPv4 literals', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    const urls = [
      'http://127.0.0.1',
      'http://10.0.0.42',
      'http://172.16.5.4',
      'http://172.31.255.255',
      'http://192.168.1.10',
      'http://169.254.169.254',
      'http://0.0.0.0',
    ];

    for (const url of urls) {
      await expect(validateUrlForSSRF(url)).resolves.toBe(PRIVATE_NETWORK_BLOCK_MESSAGE);
    }

    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects private IPv6 literals and mapped loopback addresses', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    const urls = [
      'http://[::1]',
      'http://[fd00::1234]',
      'http://[fe80::1]',
      'http://[fec0::1]',
      'http://[::ffff:127.0.0.1]',
    ];

    for (const url of urls) {
      await expect(validateUrlForSSRF(url)).resolves.toBe(PRIVATE_NETWORK_BLOCK_MESSAGE);
    }

    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('detects private IPv4 embedded in expanded and compressed ISATAP addresses', async () => {
    const { isPrivateIP } = await import('@/lib/server/ssrf-guard');

    const addresses = [
      '2001:db8:0:1:0:5efe:7f00:1',
      '2001:db8:0:1:200:5efe:a00:1',
      '2001:db8:0:1::5efe:c0a8:101',
      '2001:db8::200:5efe:ac10:1',
    ];

    for (const address of addresses) {
      expect(isPrivateIP(address)).toBe(true);
    }
  });

  it('classifies direct dotted-tail ISATAP addresses by their embedded IPv4', async () => {
    const { isPrivateIP } = await import('@/lib/server/ssrf-guard');

    expect(isPrivateIP('2001:db8:0:1::5efe:192.168.1.1')).toBe(true);
    expect(isPrivateIP('2001:db8::200:5efe:10.0.0.1')).toBe(true);
    expect(isPrivateIP('2001:db8:0:1::5efe:8.8.8.8')).toBe(false);
  });

  it('does not match ISATAP lookalikes with invalid flags, markers, or positions', async () => {
    const { isPrivateIP } = await import('@/lib/server/ssrf-guard');

    const addresses = [
      '2001:db8::100:5efe:127.0.0.1',
      '2001:db8::300:5efe:127.0.0.1',
      '2001:db8::beef:127.0.0.1',
      '2001:db8::5efe:0:127.0.0.1',
    ];

    for (const address of addresses) {
      expect(isPrivateIP(address)).toBe(false);
    }
  });

  it('does not classify zero-width IPv6 compression as ISATAP', async () => {
    const { isPrivateIP } = await import('@/lib/server/ssrf-guard');

    expect(isPrivateIP('2001:db8:0:1:0:5efe::127.0.0.1')).toBe(false);
  });

  it('preserves 6to4 and Teredo classification for mixed dotted-tail notation', async () => {
    const { isPrivateIP } = await import('@/lib/server/ssrf-guard');

    expect(isPrivateIP('2002:7f00:0001::192.0.2.1')).toBe(true);
    expect(isPrivateIP('2002:0808:0808::127.0.0.1')).toBe(false);
    expect(isPrivateIP('2001:0000:4136:e378:8000:63bf:128.255.255.254')).toBe(true);
    expect(isPrivateIP('2001:0000:4136:e378:8000:63bf:247.247.247.247')).toBe(false);
  });

  it('rejects 6to4 tunnel addresses embedding private IPv4', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    // 2002:7f00:0001:: embeds 127.0.0.1
    await expect(validateUrlForSSRF('http://[2002:7f00:0001::]')).resolves.toBe(
      PRIVATE_NETWORK_BLOCK_MESSAGE,
    );
    // 2002:0a00:0001:: embeds 10.0.0.1
    await expect(validateUrlForSSRF('http://[2002:0a00:0001::]')).resolves.toBe(
      PRIVATE_NETWORK_BLOCK_MESSAGE,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows 6to4 tunnel addresses embedding public IPv4', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    // 2002:0808:0808:: embeds 8.8.8.8
    await expect(validateUrlForSSRF('http://[2002:0808:0808::]')).resolves.toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects Teredo tunnel addresses embedding private IPv4', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    // Client IPv4 127.0.0.1 XOR 0xFFFFFFFF = 0x80FFFFFE → hextets 80ff:fffe
    await expect(
      validateUrlForSSRF('http://[2001:0000:4136:e378:8000:63bf:80ff:fffe]'),
    ).resolves.toBe(PRIVATE_NETWORK_BLOCK_MESSAGE);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows Teredo tunnel addresses embedding public IPv4', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    // Client IPv4 8.8.8.8 XOR 0xFFFFFFFF = 0xF7F7F7F7 → hextets f7f7:f7f7
    await expect(
      validateUrlForSSRF('http://[2001:0000:4136:e378:8000:63bf:f7f7:f7f7]'),
    ).resolves.toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects hostnames that resolve to a private IP', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    const result = await validateUrlForSSRF('https://attacker.com');
    expect(result).toBe(PRIVATE_NETWORK_BLOCK_MESSAGE);
    expect(result).toContain(ALLOW_LOCAL_NETWORKS_GUIDANCE);
  });

  it('rejects hostnames when any DNS answer is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://mixed.example')).resolves.toBe(
      PRIVATE_NETWORK_BLOCK_MESSAGE,
    );
  });

  it('rejects a hostname that resolves to an ISATAP address embedding private IPv4', async () => {
    lookupMock.mockResolvedValue([{ address: '2001:db8::200:5efe:192.168.1.10', family: 6 }]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://isatap.example')).resolves.toBe(
      PRIVATE_NETWORK_BLOCK_MESSAGE,
    );
  });

  it('allows local network targets when ALLOW_LOCAL_NETWORKS=true', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('http://192.168.1.10')).resolves.toBeNull();
    await expect(validateUrlForSSRF('https://internal.example')).resolves.toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('fails closed when DNS lookup errors', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://missing.example')).resolves.toBe(
      'Unable to verify hostname safety',
    );
  });
});

const STRICT_BLOCK_MESSAGE = 'Local/private/reserved network URLs are not allowed';

describe('assertSafeIp', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('accepts globally routable unicast addresses', async () => {
    const { assertSafeIp } = await import('@/lib/server/ssrf-guard');
    expect(() => assertSafeIp('8.8.8.8')).not.toThrow();
    expect(() => assertSafeIp('1.1.1.1')).not.toThrow();
    expect(() => assertSafeIp('2606:4700:4700::1111')).not.toThrow();
  });

  it('rejects private and reserved IPv4 addresses', async () => {
    const { assertSafeIp } = await import('@/lib/server/ssrf-guard');
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.100.100.200',
      '255.255.255.255',
    ]) {
      expect(() => assertSafeIp(ip)).toThrow(STRICT_BLOCK_MESSAGE);
    }
  });

  it('rejects private, link-local and metadata IPv6 addresses', async () => {
    const { assertSafeIp } = await import('@/lib/server/ssrf-guard');
    for (const ip of [
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      'fec0::1',
      'fd00:ec2::254',
      '2002:7f00:0001::', // 6to4 embedding 127.0.0.1
    ]) {
      expect(() => assertSafeIp(ip)).toThrow(STRICT_BLOCK_MESSAGE);
    }
  });

  it('classifies IPv4-mapped IPv6 as IPv4 so ::ffff:127.0.0.1 cannot hide', async () => {
    const { assertSafeIp } = await import('@/lib/server/ssrf-guard');
    expect(() => assertSafeIp('::ffff:127.0.0.1')).toThrow(STRICT_BLOCK_MESSAGE);
    expect(() => assertSafeIp('::ffff:8.8.8.8')).not.toThrow();
  });

  it('rejects ISATAP addresses that embed private IPv4 beneath a public IPv6 prefix', async () => {
    const { assertSafeIp } = await import('@/lib/server/ssrf-guard');
    expect(() => assertSafeIp('2001:4860:0:1:200:5efe:7f00:1')).toThrow(STRICT_BLOCK_MESSAGE);
    expect(() => assertSafeIp('2001:4860:0:1:0:5efe:a00:1')).toThrow(STRICT_BLOCK_MESSAGE);
    expect(() => assertSafeIp('2001:4860:0:1:200:5efe:808:808')).not.toThrow();
  });

  it('throws a classified error for unparseable input', async () => {
    const { assertSafeIp, UnsafeNetworkTargetError } = await import('@/lib/server/ssrf-guard');
    expect(() => assertSafeIp('not-an-ip')).toThrow(UnsafeNetworkTargetError);
  });
});

describe('normalizeUrlForStrictFetch', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('returns a parsed URL for a safe http(s) URL', async () => {
    const { normalizeUrlForStrictFetch } = await import('@/lib/server/ssrf-guard');
    expect(normalizeUrlForStrictFetch('https://example.com/a?b=1').toString()).toBe(
      'https://example.com/a?b=1',
    );
    expect(normalizeUrlForStrictFetch('http://example.com:80/').port).toBe('');
  });

  it('rejects non-http protocols, userinfo and unusual ports', async () => {
    const { normalizeUrlForStrictFetch, UnsafeNetworkTargetError } =
      await import('@/lib/server/ssrf-guard');
    expect(() => normalizeUrlForStrictFetch('ftp://example.com')).toThrow(UnsafeNetworkTargetError);
    expect(() => normalizeUrlForStrictFetch('file:///etc/passwd')).toThrow(
      UnsafeNetworkTargetError,
    );
    expect(() => normalizeUrlForStrictFetch('https://user:pass@example.com')).toThrow(
      UnsafeNetworkTargetError,
    );
    expect(() => normalizeUrlForStrictFetch('https://example.com:8443')).toThrow(
      UnsafeNetworkTargetError,
    );
  });

  it('rejects local and private IP literals without any DNS lookup', async () => {
    const { normalizeUrlForStrictFetch } = await import('@/lib/server/ssrf-guard');
    for (const url of [
      'http://127.0.0.1',
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://[::1]',
      'http://[fd00::1]',
      'http://[::ffff:127.0.0.1]',
      // WHATWG parsing canonicalizes legacy decimal IPv4 spellings.
      'http://2130706433',
      'http://0x7f000001',
    ]) {
      expect(() => normalizeUrlForStrictFetch(url)).toThrow(STRICT_BLOCK_MESSAGE);
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects local hostnames and cloud-metadata hosts', async () => {
    const { normalizeUrlForStrictFetch } = await import('@/lib/server/ssrf-guard');
    for (const url of [
      'http://localhost',
      'http://printer.local',
      'http://metadata.google.internal',
    ]) {
      expect(() => normalizeUrlForStrictFetch(url)).toThrow(STRICT_BLOCK_MESSAGE);
    }
  });

  it('accepts public hostnames and IP literals without DNS', async () => {
    const { normalizeUrlForStrictFetch } = await import('@/lib/server/ssrf-guard');
    expect(() => normalizeUrlForStrictFetch('https://example.com')).not.toThrow();
    expect(() => normalizeUrlForStrictFetch('https://8.8.8.8')).not.toThrow();
    expect(() => normalizeUrlForStrictFetch('https://[2606:4700:4700::1111]')).not.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
