/**
 * POST /api/model-config/import — merge settings a browser kept into the
 * workspace (RFC #1701): the one-way import of the provider settings earlier
 * builds stored in the browser. Body: `{ providers?, slots? }` as in
 * openmaic.yml. Existing settings always win; each item is checked like an
 * edit, and the answer lists what was imported and what was skipped and why,
 * with the new view. Safe to repeat: a second import finds everything there.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  readWorkspaceModelConfig,
  saveWorkspaceModelConfig,
  WorkspaceConfigConflictError,
} from '@/lib/persistence/workspace-model-config';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  importModelSettings,
  modelSettingsView,
  type ModelSettingsProposal,
} from '@/lib/server/model-config/settings';

export const runtime = 'nodejs';

const proposalSchema = z
  .object({
    providers: z
      // Each provider is checked on its own: a malformed one is skipped.
      .record(z.string().min(1).max(64), z.unknown())
      .optional(),
    slots: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .strict();

/** Attempts against a settings write that raced this one. */
const MAX_ATTEMPTS = 3;

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  let proposal: ModelSettingsProposal;
  try {
    const parsed = proposalSchema.safeParse(await req.json());
    if (!parsed.success) throw new Error('invalid');
    proposal = parsed.data as ModelSettingsProposal;
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'Expected { providers?, slots? }' } },
      { status: 400 },
    );
  }

  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const queryable = (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;
    try {
      for (let attempt = 1; ; attempt++) {
        const current = await readWorkspaceModelConfig(queryable, ownerId);
        const result = await importModelSettings(current?.config ?? null, proposal);
        try {
          if (result.imported.length) {
            await saveWorkspaceModelConfig(
              queryable,
              ownerId,
              result.config,
              current?.revision ?? null,
            );
          }
        } catch (error) {
          if (error instanceof WorkspaceConfigConflictError && attempt < MAX_ATTEMPTS) continue;
          throw error;
        }
        const stored = await readWorkspaceModelConfig(queryable, ownerId);
        return NextResponse.json(
          {
            imported: result.imported,
            skipped: result.skipped,
            view: modelSettingsView(stored),
          },
          { headers },
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceConfigConflictError) {
        return NextResponse.json(
          { error: { code: 'CONFLICT', message: 'The settings kept changing; try again' } },
          { status: 409, headers },
        );
      }
      const refused = ownerWriteErrorResponse(error, headers);
      if (refused) return refused;
      throw error;
    }
  });
}
