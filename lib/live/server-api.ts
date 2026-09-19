import { createLogger } from '@/lib/logger';

const log = createLogger('ServerAPI');

/**
 * Course-name cap, shared with `PATCH /api/stages/:id` and the publish dialog.
 * Enforced client-side too so a too-long name is refused at the keyboard rather
 * than by a 400.
 */
export const STAGE_NAME_MAX_LENGTH = 120;

/** Why the server refused a rename, in the shape the UI wants to message. */
export type StageRenameRefusal = 'invalidName' | 'forbidden' | 'notFound' | 'failed';

export class StageRenameError extends Error {
  constructor(readonly kind: StageRenameRefusal) {
    super(`stage rename refused: ${kind}`);
    this.name = 'StageRenameError';
  }
}

/**
 * Rename a course through `PATCH /api/stages/:id`, which owns the whole rule:
 * the owner gate is re-checked inside the write transaction and the name lands
 * in the stage document. Deliberately NOT `renameStage` from the storage
 * boundary — that path is a client-side read-modify-write of the whole
 * document, which a course list has no reason to pull down just to change a
 * name.
 *
 * Returns the name the server stored (its own trim), so the caller renders what
 * was persisted rather than what was typed.
 */
export async function apiRenameStage(id: string, name: string): Promise<string> {
  const res = await fetch(`/api/stages/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    log.error(`Failed to rename stage ${id}: HTTP ${res.status}`);
    throw new StageRenameError(
      res.status === 400
        ? 'invalidName'
        : res.status === 403
          ? 'forbidden'
          : res.status === 404
            ? 'notFound'
            : 'failed',
    );
  }
  const body = (await res.json().catch(() => ({}))) as { name?: unknown };
  return typeof body.name === 'string' ? body.name : name.trim();
}
