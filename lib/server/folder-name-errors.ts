import { NextResponse } from 'next/server';

import { FOLDER_COUNT_LIMIT, FolderNameError } from '@/lib/utils/folder-name-validation';

/**
 * Map a folder-name refusal raised by the data layer onto the API's machine
 * codes (the reference's `folder-name-errors.ts`, ported onto this branch's
 * storage layer).
 *
 * The storage layer enforces the duplicate + count-limit checks inside its
 * folder transactions and throws {@link FolderNameError}; this turns those
 * refusals into the same 409/400 responses the route's own pre-checks produce.
 *
 * A raw PG unique violation (23505) is also mapped as a backstop for the
 * rename path: the `(owner_id, normalized_name)` unique index is the final
 * authority, and a duplicate that slipped past both the pre-check and the
 * rename UPDATE must answer 409 — the answer the client's duplicate handling
 * expects — rather than a 500. The folder-name index is the only unique
 * constraint a rename can violate (the UPDATE does not touch the primary key),
 * so every 23505 here is a duplicate folder name.
 *
 * Returns `null` when the error is not a folder-name refusal (caller falls
 * through to its generic 500 path).
 */
export function folderNameErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof FolderNameError) {
    switch (error.kind) {
      case 'duplicate':
        return jsonError(409, 'FOLDER_NAME_DUPLICATE', 'a folder with this name already exists');
      case 'limit':
        return jsonError(
          400,
          'FOLDER_COUNT_LIMIT',
          `folder count limit reached (${FOLDER_COUNT_LIMIT})`,
        );
      case 'empty':
        return jsonError(400, 'FOLDER_NAME_EMPTY', 'folder name must not be empty');
      case 'tooLong':
        return jsonError(400, 'FOLDER_NAME_TOO_LONG', 'folder name is too long');
    }
  }
  if (isPgUniqueViolation(error)) {
    return jsonError(409, 'FOLDER_NAME_DUPLICATE', 'a folder with this name already exists');
  }
  return null;
}

function isPgUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}
