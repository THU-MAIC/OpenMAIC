/**
 * Proxy-aware fetch for server-side use.
 *
 * Automatically routes requests through HTTP/HTTPS proxy when
 * the standard environment variables are set:
 *   - https_proxy / HTTPS_PROXY
 *   - http_proxy / HTTP_PROXY
 *
 * Node.js's built-in fetch does NOT respect these env vars,
 * so we use undici's ProxyAgent when a proxy is configured.
 *
 * Usage: import { proxyFetch } from '@/lib/server/proxy-fetch';
 *        const res = await proxyFetch('https://api.openai.com/v1/...', { ... });
 */

import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { createLogger } from '@/lib/logger';

const log = createLogger('ProxyFetch');

function getProxyUrl(): string | undefined {
  return (
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    undefined
  );
}

let cachedAgent: ProxyAgent | null = null;
let cachedProxyUrl: string | undefined;

function getProxyAgent(): ProxyAgent | undefined {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return undefined;

  // Reuse agent if proxy URL hasn't changed
  if (cachedAgent && cachedProxyUrl === proxyUrl) {
    return cachedAgent;
  }

  cachedAgent = new ProxyAgent(proxyUrl);
  cachedProxyUrl = proxyUrl;
  return cachedAgent;
}

/**
 * Drop-in replacement for fetch() that respects proxy env vars.
 * Falls back to global fetch when no proxy is configured.
 */
export async function proxyFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const agent = getProxyAgent();
  const url = typeof input === 'string' ? input : input.toString();

  if (!agent) {
    log.info('No proxy configured, using direct fetch for:', url.slice(0, 80));
    return fetch(input, init);
  }

  log.info('Using proxy', cachedProxyUrl, 'for:', url.slice(0, 80));
  // Use undici's fetch with the proxy dispatcher
  const res = await undiciFetch(input, {
    ...(init as UndiciRequestInit),
    dispatcher: agent,
  });

  // undici's Response is compatible with the global Response
  return res as unknown as Response;
}
