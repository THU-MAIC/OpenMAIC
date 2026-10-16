/**
 * Proxy-aware fetch for server-side use.
 *
 * Automatically routes requests through HTTP/HTTPS proxy when
 * the standard environment variables are set:
 *   - https_proxy / HTTPS_PROXY
 *   - http_proxy / HTTP_PROXY
 *
 * Requests are sent directly (bypassing the proxy) when:
 *   - the target host is a loopback address (localhost, 127.0.0.0/8, ::1) —
 *     routing loopback through an external proxy resolves to the *proxy's*
 *     localhost, which is never what the caller means; or
 *   - the target host matches the standard no_proxy / NO_PROXY env var
 *     (comma-separated hosts, `*` wildcard, optional `:port`, and
 *     domain-suffix matching à la curl: `example.com` also matches
 *     `api.example.com`).
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

function getNoProxyEntries(): string[] {
  const raw = process.env.no_proxy || process.env.NO_PROXY || '';
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // URL.hostname strips the brackets from IPv6 literals on parse, but be
  // lenient and accept both forms.
  if (host === '::1' || host === '[::1]') return true;
  return /^127(\.\d{1,3}){3}$/.test(host);
}

function matchesNoProxyEntry(hostname: string, port: string, entry: string): boolean {
  if (entry === '*') return true;

  let entryHost = entry;
  let entryPort = '';
  // Split a trailing `:port`. Skip IPv6 literals (multiple colons).
  const colonIndex = entry.lastIndexOf(':');
  if (colonIndex !== -1 && entry.indexOf(':') === colonIndex) {
    entryHost = entry.slice(0, colonIndex);
    entryPort = entry.slice(colonIndex + 1);
  }
  if (entryPort && entryPort !== port) return false;

  // A leading dot (`.example.com`) means the same as `example.com`:
  // match the host itself and any subdomain.
  entryHost = entryHost.replace(/^\./, '');
  if (!entryHost) return false;
  return hostname === entryHost || hostname.endsWith(`.${entryHost}`);
}

/**
 * Whether a request to `url` should skip the configured proxy.
 * Exported for tests.
 */
export function shouldBypassProxy(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (isLoopbackHost(hostname)) return true;

  const entries = getNoProxyEntries();
  if (entries.length === 0) return false;

  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return entries.some((entry) => matchesNoProxyEntry(hostname, port, entry));
}

// Retain independent transport profiles without growing indefinitely as providers change.
const PROXY_AGENT_CACHE_LIMIT = 8;
const proxyAgents = new Map<string, ProxyAgent>();

export interface ProxyFetchOptions {
  /** An operator-configured provider proxy takes precedence over the environment. */
  proxy?: string;
  timeouts?: { connectTimeout: number; headersTimeout: number; bodyTimeout: number };
}

function getProxyAgent(options?: ProxyFetchOptions): ProxyAgent | undefined {
  const proxyUrl = options?.proxy ?? getProxyUrl();
  if (!proxyUrl) return undefined;

  const timeouts = options?.timeouts;
  const key = JSON.stringify([
    proxyUrl,
    timeouts ? [timeouts.connectTimeout, timeouts.headersTimeout, timeouts.bodyTimeout] : null,
  ]);
  const cached = proxyAgents.get(key);
  if (cached) {
    // Refresh insertion order so the least recently used profile is evicted first.
    proxyAgents.delete(key);
    proxyAgents.set(key, cached);
    return cached;
  }

  const agent = new ProxyAgent({
    uri: proxyUrl,
    ...(options?.timeouts
      ? {
          requestTls: { timeout: options.timeouts.connectTimeout },
          proxyTls: { timeout: options.timeouts.connectTimeout },
          headersTimeout: options.timeouts.headersTimeout,
          bodyTimeout: options.timeouts.bodyTimeout,
        }
      : {}),
  });
  proxyAgents.set(key, agent);
  if (proxyAgents.size > PROXY_AGENT_CACHE_LIMIT) {
    const oldestKey = proxyAgents.keys().next().value!;
    const oldest = proxyAgents.get(oldestKey)!;
    proxyAgents.delete(oldestKey);
    // Graceful close lets active requests finish before releasing their sockets.
    void oldest.close().catch(() => log.warn('Could not close an evicted proxy agent'));
  }
  return agent;
}

/**
 * Drop-in replacement for fetch() that respects proxy env vars.
 * Falls back to global fetch when no proxy is configured, when the target
 * is a loopback address, or when the target matches no_proxy / NO_PROXY.
 */
export async function proxyFetch(
  input: string | URL,
  init?: RequestInit,
  options?: ProxyFetchOptions,
): Promise<Response> {
  const agent = getProxyAgent(options);
  const url = typeof input === 'string' ? input : input.toString();

  if (!agent) {
    log.info('No proxy configured, using direct fetch for:', url.slice(0, 80));
    return fetch(input, init);
  }

  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable input — let fetch surface the real error below.
  }
  if (!options?.proxy && parsed && shouldBypassProxy(parsed)) {
    log.info('Bypassing proxy (loopback/NO_PROXY) for:', url.slice(0, 80));
    return fetch(input, init);
  }

  log.info('Using proxy for:', url.slice(0, 80));
  // Use undici's fetch with the proxy dispatcher
  const res = await undiciFetch(input, {
    ...(init as UndiciRequestInit),
    dispatcher: agent,
  });

  // undici's Response is compatible with the global Response
  return res as unknown as Response;
}
