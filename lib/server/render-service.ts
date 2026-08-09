/**
 * Server-side config + helpers for the isolated MP4 render service (issue #866).
 *
 * The render service is an opt-in capability: it's only reachable when
 * `RENDER_SERVICE_URL` is set. When unset, the app degrades to letting the user
 * download the project ZIP for local CLI rendering, so callers treat "not
 * configured" as a normal, expected state — not an error.
 */
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { createLogger } from '@/lib/logger';

const log = createLogger('RenderService');

/** The configured base URL of the render service, or null when the capability is off. */
export function getRenderServiceUrl(): string | null {
  const raw = process.env.RENDER_SERVICE_URL?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

/** Whether the render service is configured (URL present — not a reachability check). */
export function isRenderServiceConfigured(): boolean {
  return getRenderServiceUrl() !== null;
}

/**
 * Resolve the render service base URL, or `{ error: 'not_configured' }`.
 *
 * `RENDER_SERVICE_URL` is operator-supplied deployment config, not user input,
 * so it is deliberately NOT run through the SSRF guard: the guard exists to stop
 * user-controlled URLs from reaching internal hosts, whereas this URL is
 * *meant* to point at an internal service (e.g. `http://render-service:9000`
 * on the compose network). Running the guard here would reject the intended
 * deployment unless the operator globally weakened SSRF via
 * `ALLOW_LOCAL_NETWORKS`, which we do not want to require.
 */
export function resolveRenderServiceUrl(): { url: string } | { error: 'not_configured' } {
  const url = getRenderServiceUrl();
  return url ? { url } : { error: 'not_configured' };
}

/**
 * Whether the configured render service is actually reachable and healthy.
 * Probes `GET /health` with a short timeout. Returns false (rather than
 * throwing) when unconfigured or unreachable, so the capability endpoint can
 * report a truthful enabled/disabled state and the UI degrades cleanly.
 */
export async function checkRenderServiceHealth(): Promise<boolean> {
  const url = getRenderServiceUrl();
  if (!url) return false;
  try {
    const res = await proxyFetch(`${url}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch (error) {
    log.info('Render service health check failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
