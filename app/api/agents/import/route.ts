/**
 * POST /api/agents/import — add the custom agents an earlier build kept in a
 * browser to the request owner's (the one-way legacy browser import,
 * `lib/legacy-browser-import/agents-import.ts`). Body: `{ agents }`.
 *
 * Each agent is checked like a create (`customAgentSchema`); one that fails,
 * names a built-in id, or uses an id the owner already has (whose agent is
 * kept) is skipped with the reason, and the rest are imported in one
 * transaction. The importer sends at most `MAX_IMPORT_BATCH_AGENTS` agents in
 * a body under `MAX_IMPORT_BODY_BYTES` per request, in as many requests as it
 * needs. Safe to repeat: a second import finds every agent there. The
 * importer's requests carry its browser id, so owner resolution refuses them
 * for an owner that does not hold the browser (`FENCED_ENDPOINTS`).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { isBuiltInAgentId } from '@/lib/orchestration/registry/built-in';
import {
  customAgentSchema,
  describeAgentIssue,
  MAX_IMPORT_BATCH_AGENTS,
  MAX_IMPORT_BODY_BYTES,
  type CustomAgent,
} from '@/lib/orchestration/registry/schema';
import {
  agentsJsonError,
  agentsPool,
  agentWriteErrorResponse,
  bodyTooLargeResponse,
  readCappedJson,
} from '@/lib/server/agents/http';
import { importOwnerAgents } from '@/lib/server/agents/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const read = await readCappedJson(req, MAX_IMPORT_BODY_BYTES);
    if (!read.ok && read.tooLarge) return bodyTooLargeResponse(MAX_IMPORT_BODY_BYTES, headers);
    const body = (read.ok ? read.value : undefined) as { agents?: unknown } | undefined;
    const agents = body && typeof body === 'object' ? body.agents : undefined;
    if (!Array.isArray(agents) || agents.length > MAX_IMPORT_BATCH_AGENTS) {
      return agentsJsonError(
        400,
        'INVALID_REQUEST',
        `expected { agents } with at most ${MAX_IMPORT_BATCH_AGENTS} agents`,
        headers,
      );
    }

    const valid: CustomAgent[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const candidate of agents) {
      const rawId = (candidate as { id?: unknown } | null)?.id;
      const id = typeof rawId === 'string' ? rawId : '';
      if (isBuiltInAgentId(id)) {
        skipped.push({ id, reason: 'built-in' });
        continue;
      }
      const parsed = customAgentSchema.safeParse(candidate);
      if (parsed.success) valid.push(parsed.data);
      else skipped.push({ id, reason: `invalid: ${describeAgentIssue(parsed.error)}` });
    }

    try {
      const result = valid.length
        ? await importOwnerAgents(await agentsPool(), ownerId, valid)
        : { imported: [], skipped: [] };
      return NextResponse.json(
        { imported: result.imported, skipped: [...skipped, ...result.skipped] },
        { headers },
      );
    } catch (error) {
      const refused = agentWriteErrorResponse(error, headers);
      if (refused) return refused;
      throw error;
    }
  });
}
