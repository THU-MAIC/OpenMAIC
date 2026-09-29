/**
 * GET/PUT /api/model-config — the workspace's model settings (RFC #1701).
 *
 * GET answers the slot tree as this workspace sees it: every slot with its own
 * assignment, its effective model and where that comes from, and whether the
 * deployment locks it; and the providers it can use, with keys masked. PUT
 * applies one change (slot assignments, a workspace provider, or removing one)
 * against the revision the caller read, and answers the new view. The owner is
 * the request's, through the owner identity seam, never a parameter.
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
  WorkspaceConfigInvalidError,
} from '@/lib/persistence/workspace-model-config';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  applyModelSettingsChange,
  keysClearedBy,
  modelSettingsView,
  ModelSettingsError,
  type ModelSettingsChange,
} from '@/lib/server/model-config/settings';

export const runtime = 'nodejs';

function jsonError(status: number, code: string, message: string, headers: Headers) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

async function pool() {
  return (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;
}

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const stored = await readWorkspaceModelConfig(await pool(), ownerId);
    return NextResponse.json(modelSettingsView(stored), { headers });
  });
}

const id = z.string().min(1).max(128);
/** An assignment's own shape is checked with the whole configuration it lands in. */
const assignment = z.union([z.string().min(1), z.null(), z.record(z.string(), z.unknown())]);

const bodySchema = z
  .object({
    revision: z.number().int().nonnegative().nullable(),
    change: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('slots'),
          set: z.record(id, assignment).optional(),
          clear: z.array(id).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('provider'),
          id,
          preset: id,
          apiKey: z.string().optional(),
          baseUrl: z.string().min(1).nullable().optional(),
          models: z.array(z.string().min(1)).nullable().optional(),
        })
        .strict(),
      z.object({ kind: z.literal('remove-provider'), id }).strict(),
    ]),
  })
  .strict();

export async function PUT(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'Body must be JSON' } },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'Expected { revision, change }' } },
      { status: 400 },
    );
  }
  const revision = parsed.data.revision;
  const change = parsed.data.change as ModelSettingsChange;

  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const queryable = await pool();
    try {
      const current = await readWorkspaceModelConfig(queryable, ownerId);
      if ((current?.revision ?? null) !== revision) {
        return jsonError(409, 'CONFLICT', 'The settings changed; reload them', headers);
      }
      const next = await applyModelSettingsChange(current?.config ?? null, change);
      await saveWorkspaceModelConfig(queryable, ownerId, next, revision, {
        clearKeys: keysClearedBy(change),
      });
      const stored = await readWorkspaceModelConfig(queryable, ownerId);
      return NextResponse.json(modelSettingsView(stored), { headers });
    } catch (error) {
      if (error instanceof ModelSettingsError) {
        return jsonError(
          error.code === 'SLOT_LOCKED' ? 409 : 400,
          error.code,
          error.message,
          headers,
        );
      }
      if (error instanceof WorkspaceConfigConflictError) {
        return jsonError(409, 'CONFLICT', 'The settings changed; reload them', headers);
      }
      if (error instanceof WorkspaceConfigInvalidError) {
        return jsonError(400, 'INVALID_SETTINGS', error.message, headers);
      }
      const refused = ownerWriteErrorResponse(error, headers);
      if (refused) return refused;
      throw error;
    }
  });
}
