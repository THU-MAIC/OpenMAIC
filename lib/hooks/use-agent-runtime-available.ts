'use client';

import { useEffect, useState } from 'react';

let availableCache: boolean | null = null;
let availableProbe: Promise<boolean> | null = null;

/**
 * Ask the server once per tab whether the agent runtime can serve a request.
 *
 * Reads the `enabled` field of `GET /api/agent/runtime`: it is
 * `isAgentRuntimeConfigured()` (the flag AND a `DATABASE_URL`), the same
 * check the agent routes such as `/api/agent/skills` gate on. A failed probe
 * answers false without being cached, so a later mount asks again.
 */
function probeAgentRuntimeAvailable(): Promise<boolean> {
  if (availableCache !== null) return Promise.resolve(availableCache);
  if (!availableProbe) {
    availableProbe = fetch('/api/agent/runtime')
      .then((response) => {
        if (!response.ok) throw new Error(`agent runtime probe failed: ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((body) => {
        const enabled =
          !!body && typeof body === 'object' && (body as { enabled?: unknown }).enabled === true;
        availableCache = enabled;
        return enabled;
      })
      .catch(() => false)
      .finally(() => {
        availableProbe = null;
      });
  }
  return availableProbe;
}

/**
 * Whether the agent runtime is available on this deployment. False until the
 * server says otherwise, so a surface gated on it stays hidden while the
 * answer is unknown instead of flashing an error.
 */
export function useAgentRuntimeAvailable(): boolean {
  const [available, setAvailable] = useState(availableCache === true);
  useEffect(() => {
    let cancelled = false;
    void probeAgentRuntimeAvailable().then((value) => {
      if (!cancelled) setAvailable(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}
