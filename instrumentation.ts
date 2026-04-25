/**
 * Next.js server instrumentation — runs once at server startup (Node.js runtime only).
 * Sets a global undici ProxyAgent so ALL fetch() calls automatically use the proxy
 * when HTTP_PROXY / HTTPS_PROXY environment variables are set.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;

  if (!proxyUrl) return;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ProxyAgent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`[Proxy] Global fetch proxy set: ${proxyUrl}`);
}
