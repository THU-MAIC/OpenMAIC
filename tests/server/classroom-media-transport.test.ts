import { describe, expect, it, vi } from 'vitest';
import { downloadToBuffer, DOWNLOAD_MAX_SIZE } from '@/lib/server/classroom-media-generation';
import * as providerFetchModule from '@/lib/server/provider-fetch';

describe('classroom media download transport', () => {
  describe('data: URLs', () => {
    it('decodes a base64 data: URL without network requests', async () => {
      const fetchSpy = vi.spyOn(providerFetchModule, 'providerFetch');
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const dataUrl = `data:image/png;base64,${pngBase64}`;

      const buf = await downloadToBuffer(dataUrl);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(buf).toEqual(Buffer.from(pngBase64, 'base64'));
      fetchSpy.mockRestore();
    });

    it('decodes a URI-encoded data: URL without network requests', async () => {
      const fetchSpy = vi.spyOn(providerFetchModule, 'providerFetch');
      const dataUrl = 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E';

      const buf = await downloadToBuffer(dataUrl);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(buf.toString('utf8')).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      fetchSpy.mockRestore();
    });

    it('rejects an invalid data: URL without a comma', async () => {
      await expect(downloadToBuffer('data:image/png;base64')).rejects.toThrow(
        /invalid data url/i,
      );
    });

    it('rejects a data: URL that exceeds DOWNLOAD_MAX_SIZE', async () => {
      const hugeData = 'data:text/plain;base64,' + Buffer.alloc(DOWNLOAD_MAX_SIZE + 1).toString('base64');
      await expect(downloadToBuffer(hugeData)).rejects.toThrow(/File too large/);
    });
  });

  describe('address-policy refusals', () => {
    it('refuses plain http URLs before fetching', async () => {
      await expect(downloadToBuffer('http://cdn.example.com/image.png')).rejects.toThrow(
        'Download failed: URL must use https (http:)',
      );
    });

    it('refuses loopback IP URLs', async () => {
      await expect(downloadToBuffer('https://127.0.0.1/image.png')).rejects.toThrow(
        /Local\/private network URLs are not allowed/,
      );
    });

    it('refuses private IP URLs', async () => {
      await expect(downloadToBuffer('https://192.168.1.1/image.png')).rejects.toThrow(
        /Local\/private network URLs are not allowed/,
      );
    });

    it('refuses cloud instance metadata URLs', async () => {
      await expect(downloadToBuffer('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(
        /Cloud instance metadata endpoints are never allowed/,
      );
    });
  });

  describe('transport policy and streaming bounds', () => {
    it('passes strict options (allowLocalNetworks: false, requireHttps: true) to providerFetch', async () => {
      const fetchSpy = vi.spyOn(providerFetchModule, 'providerFetch').mockResolvedValueOnce(
        new Response(Buffer.from('ok'), { status: 200 }),
      );

      const buf = await downloadToBuffer('https://example.com/image.png');
      expect(buf).toEqual(Buffer.from('ok'));
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/image.png',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
        { allowLocalNetworks: false, requireHttps: true },
      );
      fetchSpy.mockRestore();
    });

    it('refuses an HTTPS to HTTP redirect hop via providerFetch policy', async () => {
      const fetchSpy = vi.spyOn(providerFetchModule, 'providerFetch').mockRejectedValueOnce(
        new Error('Redirect to non-HTTPS URL refused by policy: http://cdn.example.com/image.png'),
      );

      await expect(downloadToBuffer('https://example.com/image.png')).rejects.toThrow(
        /Redirect to non-HTTPS URL refused/,
      );
      fetchSpy.mockRestore();
    });

    it('rejects an oversized Content-Length before reading the body', async () => {
      const fetchSpy = vi.spyOn(providerFetchModule, 'providerFetch').mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'content-length': String(DOWNLOAD_MAX_SIZE + 1024) },
        }),
      );

      await expect(downloadToBuffer('https://example.com/image.png')).rejects.toThrow(
        /File too large/,
      );
      fetchSpy.mockRestore();
    });

    it('rejects an oversized body without Content-Length while streaming', async () => {
      const chunk = new Uint8Array(10 * 1024 * 1024); // 10MB
      let chunksRead = 0;
      let cancelled = false;

      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksRead += 1;
          controller.enqueue(chunk);
          if (chunksRead > 15) {
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      });

      const mockResponse = new Response(stream, {
        status: 200,
        headers: {}, // No Content-Length
      });

      const fetchSpy = vi.spyOn(providerFetchModule, 'providerFetch').mockResolvedValueOnce(mockResponse);

      await expect(downloadToBuffer('https://example.com/image.png')).rejects.toThrow(
        /File too large: \d+ bytes \(max 104857600\)/,
      );
      expect(cancelled).toBe(true);
      fetchSpy.mockRestore();
    });
  });
});
