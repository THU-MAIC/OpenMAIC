import { withAbort } from '../abort';
import { PROVIDERS } from '@/lib/ai/providers';
import type { WebFetchProvider } from '../types';

import { deepseekToolsEndpoint } from '@/lib/web-search/deepseek-endpoint';

/** Only fetch transport failures qualify; HTTP and response parsing stay outside the retry. */
function isTransportError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    if (error instanceof TypeError) return true;
    seen.add(error);
    const { code, cause } = error as { code?: unknown; cause?: unknown };
    if (
      typeof code === 'string' &&
      (/^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/.test(
        code,
      ) ||
        /^(ERR_TLS_|ERR_SSL_|CERT_)/.test(code))
    )
      return true;
    error = cause;
  }
  return false;
}

export const deepseek: Extract<WebFetchProvider, { hosted: true }> = {
  id: 'deepseek',
  name: 'DeepSeek',
  icon: PROVIDERS.deepseek.icon,
  hosted: true,
  requiresApiKey: true,
  credentialPresets: ['deepseek'],
  // This only permits workspace overrides; deployment bases are always preserved.
  acceptsWorkspaceBaseUrl: (baseUrl) =>
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(
      baseUrl.replace(/\/+$/, ''),
    ),
  defaultBaseUrl: PROVIDERS.deepseek.defaultBaseUrl,
  resolveCredentials: (credentials = {}) => ({
    ...credentials,
    baseUrl: credentials.baseUrl ?? PROVIDERS.deepseek.defaultBaseUrl,
  }),
  extract: async (url, options) => {
    const target = new URL(url);
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username ||
      target.password ||
      Array.from(url).length > 8192
    )
      throw new Error('Invalid DeepSeek fetch URL');
    const credentials = deepseek.resolveCredentials(options.credentials);
    if (!credentials.apiKey) throw new Error('Web fetch provider requires an API key');
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.bodyTimeoutMs ?? 30_000)])
      : AbortSignal.timeout(options.bodyTimeoutMs ?? 30_000);
    signal.throwIfAborted();
    const { Agent } = await import('undici');
    const { proxyFetch } = await import('@/lib/server/proxy-fetch');
    const agent = new Agent({
      connect: { timeout: 5_000 },
      headersTimeout: 10_000,
      bodyTimeout: options.bodyTimeoutMs ?? 30_000,
    });
    const headersDeadline = new AbortController();
    const requestSignal = AbortSignal.any([signal, headersDeadline.signal]);
    const headerTimer = setTimeout(
      () => headersDeadline.abort(new Error('Web fetch headers timed out')),
      10_000,
    );
    headerTimer.unref?.();
    try {
      const endpoint = deepseekToolsEndpoint(credentials.baseUrl!, 'fetch');
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        requestSignal.throwIfAborted();
        try {
          response = await withAbort(
            proxyFetch(
              endpoint,
              {
                method: 'POST',
                redirect: 'error',
                headers: {
                  Authorization: `Bearer ${credentials.apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url }),
                signal: requestSignal,
                dispatcher: agent,
              } as RequestInit & { dispatcher: typeof agent },
              {
                proxy: credentials.proxy,
                timeouts: {
                  connectTimeout: 5_000,
                  headersTimeout: 10_000,
                  bodyTimeout: options.bodyTimeoutMs ?? 30_000,
                },
              },
            ),
            requestSignal,
          );
          break;
        } catch (error) {
          requestSignal.throwIfAborted();
          if (attempt !== 0 || !isTransportError(error)) throw error;
          // Both attempts share the original header and overall deadlines.
        }
      }
      clearTimeout(headerTimer);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // Do not relay vendor messages, which can echo credentials or request data.
        if (response.status === 403)
          throw new Error(
            'Unable to fetch page: DeepSeek safety policy refused the URL (HTTP 403)',
          );
        if (response.status === 404)
          throw new Error('Unable to fetch page: DeepSeek found no usable content (HTTP 404)');
        throw new Error(`Web fetch provider returned HTTP ${response.status}`);
      }
      const { readWithTruncation } = await import('../builtin-extraction');
      const body = await readWithTruncation(
        response,
        4 * (options.maxBytes ?? 5 * 1024 * 1024) + 65_536,
        signal,
        options.bodyTimeoutMs,
      );
      if (body.truncated) throw new Error('Web fetch response exceeds the transport byte limit');
      let result: unknown;
      try {
        result = JSON.parse(body.bytes.toString('utf8'));
      } catch {
        throw new Error('Invalid web fetch JSON response');
      }
      signal.throwIfAborted();
      if (!result || typeof result !== 'object') throw new Error('Invalid web fetch response');
      const data = result as Record<string, unknown>;
      const markdown = data.content;
      if (typeof markdown !== 'string')
        throw new Error('Web fetch response has no Markdown content');
      return {
        markdown,
        ...(typeof data.title === 'string' && data.title.trim() ? { title: data.title } : {}),
      };
    } finally {
      clearTimeout(headerTimer);
      await agent.destroy();
    }
  },
};

export default deepseek;
