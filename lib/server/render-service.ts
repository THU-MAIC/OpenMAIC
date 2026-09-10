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
 * The render service's answer to `GET /health`, reduced to what callers need.
 *
 * `accepting` mirrors the service's aggregate-only flag: whether its render
 * queue cap currently has room for another video render (#1348). It is
 * advisory — the service's own 429 remains authoritative — so it is `true`
 * whenever the probe cannot read the flag (older service build, non-JSON body),
 * which keeps the button enabled rather than blocking a render that would have
 * succeeded. It is only ever `false` when the service explicitly said so.
 */
export interface RenderServiceHealth {
  /** The service is configured AND its `/health` responded OK. */
  enabled: boolean;
  /** The service's queue cap has room for another video render. */
  accepting: boolean;
}

/**
 * Probe the configured render service's `GET /health`.
 *
 * Never throws: unconfigured, unreachable, or non-OK responses come back as
 * `enabled: false` so the capability endpoint can report a truthful state and
 * the UI degrades cleanly to the ZIP path (#866). A reachable service that
 * omits `accepting` is reported as accepting, per {@link RenderServiceHealth}.
 */
export async function checkRenderServiceHealth(): Promise<RenderServiceHealth> {
  const url = getRenderServiceUrl();
  if (!url) return { enabled: false, accepting: true };
  try {
    const res = await proxyFetch(`${url}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { enabled: false, accepting: true };
    // The body is read best-effort: `enabled` comes from the status alone, so a
    // malformed or unreadable body must not turn a healthy service into a
    // disabled one.
    const body = (await res.json().catch(() => null)) as { accepting?: unknown } | null;
    return {
      enabled: true,
      accepting: typeof body?.accepting === 'boolean' ? body.accepting : true,
    };
  } catch (error) {
    log.info('Render service health check failed:', error instanceof Error ? error.message : error);
    return { enabled: false, accepting: true };
  }
}
