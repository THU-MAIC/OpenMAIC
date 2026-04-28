import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock('node:dns', () => ({
  promises: {
    lookup: lookupMock,
  },
}));

describe('validateUrlForSSRF', () => {
  beforeEach(() => {
    vi.resetModules();
    lookupMock.mockReset();
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

    await expect(validateUrlForSSRF('http://localhost')).resolves.toBe(
      'Local/private network URLs are not allowed',
    );
    await expect(validateUrlForSSRF('http://printer.local')).resolves.toBe(
      'Local/private network URLs are not allowed',
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
      await expect(validateUrlForSSRF(url)).resolves.toBe(
        'Local/private network URLs are not allowed',
      );
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
      await expect(validateUrlForSSRF(url)).resolves.toBe(
        'Local/private network URLs are not allowed',
      );
    }

    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects 6to4 tunnel addresses embedding private IPv4', async () => {
    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    // 2002:7f00:0001:: embeds 127.0.0.1
    await expect(validateUrlForSSRF('http://[2002:7f00:0001::]')).resolves.toBe(
      'Local/private network URLs are not allowed',
    );
    // 2002:0a00:0001:: embeds 10.0.0.1
    await expect(validateUrlForSSRF('http://[2002:0a00:0001::]')).resolves.toBe(
      'Local/private network URLs are not allowed',
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
    ).resolves.toBe('Local/private network URLs are not allowed');
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

    await expect(validateUrlForSSRF('https://attacker.com')).resolves.toBe(
      'Local/private network URLs are not allowed',
    );
  });

  it('rejects hostnames when any DNS answer is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ]);

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://mixed.example')).resolves.toBe(
      'Local/private network URLs are not allowed',
    );
  });

  it('fails closed when DNS lookup errors', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    const { validateUrlForSSRF } = await import('@/lib/server/ssrf-guard');

    await expect(validateUrlForSSRF('https://missing.example')).resolves.toBe(
      'Unable to verify hostname safety',
    );
  });
});
