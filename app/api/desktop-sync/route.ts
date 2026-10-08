import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  readWorkspaceModelConfig,
  saveWorkspaceModelConfig,
  WorkspaceConfigConflictError,
} from '@/lib/persistence/workspace-model-config';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';
import {
  DESKTOP_SETTINGS_SYNC_HEADER,
  DESKTOP_SETTINGS_SYNC_VERSION,
  isDesktopSyncAction,
} from '@/lib/store/settings-sync';

export const runtime = 'nodejs';

interface PendingTransfer {
  id: string;
  sourceOwnerId: string;
  sourceRevision: number | null;
  config: ModelConfigFile;
  expires: number;
  target?: { ownerId: string; revision: number | null };
  saved?: { revision: number | null };
  registering: boolean;
  applying: boolean;
}

interface Receipt {
  sourceOwnerId: string;
  targetOwnerId?: string;
  applied: boolean;
  error?: string;
  expires: number;
}

let pending: PendingTransfer | null = null;
let creating = false;
const receipts = new Map<string, Receipt>();
const MAX_BYTES = 4096;
const MAX_RECEIPTS = 32;
const TTL = 5 * 60 * 1000;

function enabled(request: NextRequest): boolean {
  if (process.env.OPENMAIC_DESKTOP_SYNC_ENABLED !== '1' || !isServerPersistenceConfigured()) {
    return false;
  }
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(request.nextUrl.hostname);
}

function desktopRequest(request: NextRequest): boolean {
  const expected = process.env.OPENMAIC_DESKTOP_SYNC_TOKEN;
  const received = request.headers.get(DESKTOP_SETTINGS_SYNC_HEADER);
  if (!expected || !received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reply(body: unknown, status = 200, headers = new Headers()): Response {
  headers.set('Cache-Control', 'no-store');
  return body === null
    ? new NextResponse(null, { status, headers })
    : NextResponse.json(body, { status, headers });
}

function expire(): void {
  const now = Date.now();
  if (pending && pending.expires <= now && !pending.registering && !pending.applying) {
    pending = null;
  }
  for (const [id, receipt] of receipts) {
    if (receipt.expires <= now) receipts.delete(id);
  }
}

async function pool() {
  return (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;
}

function failTransfer(transfer: PendingTransfer, error: string): void {
  receipts.set(transfer.id, {
    sourceOwnerId: transfer.sourceOwnerId,
    applied: false,
    error,
    expires: Date.now() + TTL,
  });
  if (pending === transfer) pending = null;
}

async function readBoundedBody(request: NextRequest): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new Error('format');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      throw new Error('size');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function OPTIONS() {
  return reply(null, 204);
}

/** Status reads and desktop discovery are read-only. */
export async function GET(request: NextRequest) {
  if (!enabled(request)) return reply(null, 404);
  expire();

  if (desktopRequest(request)) {
    return withRequestOwner(request, async (_principal, headers) =>
      pending
        ? reply({ version: DESKTOP_SETTINGS_SYNC_VERSION, id: pending.id }, 200, headers)
        : reply(null, 204, headers),
    );
  }

  const id = request.nextUrl.searchParams.get('id');
  if (!id) return reply(null, 403);
  return withRequestOwner(request, async ({ ownerId }, headers) => {
    const receipt = receipts.get(id);
    if (!receipt || receipt.sourceOwnerId !== ownerId) {
      return reply({ error: 'Transfer expired' }, 404, headers);
    }
    return reply(
      { applied: receipt.applied, ...(receipt.error ? { error: receipt.error } : {}) },
      200,
      headers,
    );
  });
}

export async function POST(request: NextRequest) {
  if (!enabled(request)) return reply(null, 404);
  expire();

  let body: unknown;
  try {
    body = await readBoundedBody(request);
  } catch (error) {
    return reply(
      { error: 'Invalid desktop sync request' },
      error instanceof Error && error.message === 'size' ? 413 : 400,
    );
  }
  if (!isDesktopSyncAction(body)) return reply({ error: 'Invalid desktop sync request' }, 400);

  if (body.action === 'create') {
    if (desktopRequest(request)) return reply(null, 403);
    return withRequestOwner(request, async ({ ownerId }, headers) => {
      if (pending || creating || receipts.size >= MAX_RECEIPTS) {
        return reply({ error: 'Transfer busy' }, 409, headers);
      }
      creating = true;
      try {
        const source = await readWorkspaceModelConfig(await pool(), ownerId);
        if (source?.unreadableSecrets.length) {
          return reply({ error: 'Some provider credentials cannot be read' }, 409, headers);
        }
        const id = randomUUID();
        pending = {
          id,
          sourceOwnerId: ownerId,
          sourceRevision: source?.revision ?? null,
          config: source?.config ?? {},
          expires: Date.now() + TTL,
          registering: false,
          applying: false,
        };
        receipts.set(id, {
          sourceOwnerId: ownerId,
          applied: false,
          expires: pending.expires,
        });
        return reply({ version: DESKTOP_SETTINGS_SYNC_VERSION, id }, 202, headers);
      } finally {
        creating = false;
      }
    });
  }

  if (!desktopRequest(request)) return reply(null, 403);
  return withRequestOwner(request, async ({ ownerId }, headers) => {
    if (!pending || pending.id !== body.id) {
      const receipt = receipts.get(body.id);
      if (
        body.action === 'confirm' &&
        receipt?.applied === true &&
        receipt.targetOwnerId === ownerId
      ) {
        return reply({ confirmed: true }, 200, headers);
      }
      return reply({ error: 'Transfer expired' }, 404, headers);
    }

    if (body.action === 'register') {
      if (pending.target && pending.target.ownerId !== ownerId) {
        return reply({ error: 'Transfer already claimed' }, 409, headers);
      }
      if (!pending.target) {
        if (pending.registering) return reply({ error: 'Transfer busy' }, 409, headers);
        const transfer = pending;
        transfer.registering = true;
        try {
          const target = await readWorkspaceModelConfig(await pool(), ownerId);
          if (pending !== transfer) return reply({ error: 'Transfer expired' }, 404, headers);
          if (
            ownerId === transfer.sourceOwnerId &&
            (target?.revision ?? null) !== transfer.sourceRevision
          ) {
            failTransfer(transfer, 'Source settings changed during synchronization');
            return reply({ error: 'Source settings changed during synchronization' }, 409, headers);
          }
          transfer.target = { ownerId, revision: target?.revision ?? null };
        } finally {
          transfer.registering = false;
        }
      }
      return reply({ registered: true }, 200, headers);
    }

    if (!pending.target || pending.target.ownerId !== ownerId) {
      return reply({ error: 'Transfer is not registered to this desktop' }, 409, headers);
    }
    if (body.action === 'confirm') {
      if (!pending.saved) return reply({ error: 'Transfer has not been saved' }, 409, headers);
      const id = pending.id;
      receipts.set(id, {
        sourceOwnerId: pending.sourceOwnerId,
        targetOwnerId: ownerId,
        applied: true,
        expires: Date.now() + TTL,
      });
      pending = null;
      return reply({ confirmed: true }, 200, headers);
    }
    if (pending.saved) {
      return reply({ saved: true, revision: pending.saved.revision }, 200, headers);
    }
    if (pending.applying) return reply({ error: 'Transfer busy' }, 409, headers);
    const transfer = pending;
    const targetRevision = pending.target.revision;
    transfer.applying = true;
    try {
      if (ownerId === transfer.sourceOwnerId) {
        const current = await readWorkspaceModelConfig(await pool(), ownerId);
        if ((current?.revision ?? null) !== targetRevision) {
          failTransfer(transfer, 'Source settings changed during synchronization');
          return reply({ error: 'Source settings changed during synchronization' }, 409, headers);
        }
      } else {
        const queryable = await pool();
        if (pending !== transfer) return reply({ error: 'Transfer expired' }, 404, headers);
        const revision = await saveWorkspaceModelConfig(
          queryable,
          ownerId,
          transfer.config,
          targetRevision,
        );
        transfer.saved = { revision };
      }
    } catch (error) {
      if (!(error instanceof WorkspaceConfigConflictError)) throw error;
      failTransfer(transfer, 'Desktop settings changed during synchronization');
      return reply({ error: 'Desktop settings changed during synchronization' }, 409, headers);
    } finally {
      transfer.applying = false;
    }

    if (!transfer.saved) transfer.saved = { revision: targetRevision };
    return reply({ saved: true, revision: transfer.saved.revision }, 200, headers);
  });
}
