/**
 * GET /api/model-config/plan-status?provider=<id> — the quota a workspace
 * token plan's vendor reports for the plan's saved key (see
 * lib/server/plan-status). Only the requesting owner's own workspace provider
 * is asked about, with the key stored for it: the browser names the provider,
 * never a key, an endpoint or an owner. The answer never includes the key.
 * Capabilities are settled when the key is saved, not here.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import type { PlanQuota } from '@/lib/model-settings/plan-status';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readWorkspaceModelConfig } from '@/lib/persistence/workspace-model-config';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { fetchPlanStatus, hasPlanStatus } from '@/lib/server/plan-status';

export const runtime = 'nodejs';

const UNAVAILABLE: PlanQuota = { status: 'unavailable' };

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  const providerId = req.nextUrl.searchParams.get('provider');
  if (!providerId || providerId.length > 128) {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'Expected ?provider=<id>' } },
      { status: 400 },
    );
  }
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const pool = (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;
    const stored = await readWorkspaceModelConfig(pool, ownerId);
    const providers = stored?.config.providers ?? {};
    const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
    // A custom endpoint is not the plan's own: its vendor is not asked.
    const quota =
      provider?.apiKey && !provider.baseUrl && hasPlanStatus(provider.preset)
        ? (await fetchPlanStatus(provider.preset, provider.apiKey)).quota
        : UNAVAILABLE;
    return NextResponse.json({ quota }, { headers });
  });
}
