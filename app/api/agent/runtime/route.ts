/**
 * Server-side agent runtime status probe.
 *
 *   GET /api/agent/runtime
 *     -> { enabled: boolean, runtimeEnabled: boolean, persistence: boolean }
 *
 * `enabled` reports usability, not intent: the workbench client gates its
 * entry on this field, so it is true only when the runtime can actually serve
 * a request — the flag AND a `DATABASE_URL` (the runner and the agent routes
 * need the store). `runtimeEnabled` carries the raw intent flag so a client can
 * tell "off by choice" (`runtimeEnabled: false`) from "on but unusable"
 * (`runtimeEnabled: true`, missing DATABASE_URL).
 *
 * `persistence` reports server persistence on its own (a non-empty
 * `DATABASE_URL`). The course library and folder routes (`/api/stages/**`,
 * `/api/folders/**`) gate on this, not on the runtime, so they serve whenever
 * it is true — with the agent runtime on or off.
 */
import {
  isAgentRuntimeConfigured,
  isAgentRuntimeEnabled,
  isServerPersistenceConfigured,
} from '@/lib/config/feature-flags';

export const runtime = 'nodejs';

export async function GET() {
  // Intentionally no materials flag: isAgentMaterialsEnabled does not exist in
  // this repo (the materials routes gate on the runtime itself).
  return Response.json({
    enabled: isAgentRuntimeConfigured(),
    runtimeEnabled: isAgentRuntimeEnabled(),
    persistence: isServerPersistenceConfigured(),
  });
}
