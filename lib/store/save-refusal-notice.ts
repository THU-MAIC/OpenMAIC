'use client';

/**
 * A save the server REFUSED (not one that merely failed to arrive) is said
 * out loud, once per course: the editor otherwise looks as if the edit landed,
 * and it is gone on the next load. A refusal is final — retrying will not
 * change who owns the course — so the message says why rather than "try again".
 *
 * Loaded lazily by the stage store (`lib/store/stage.ts`), so the store's own
 * import graph stays free of the toast and the translations.
 */

import { HttpDocumentStoreError } from '@openmaic/storage';
import { toast } from 'sonner';
import i18n from '@/lib/i18n/config';

const noticed = new Set<string>();

/** Whether an error is the server refusing this viewer's write. */
export function isRefusedSave(error: unknown): boolean {
  return error instanceof HttpDocumentStoreError && (error.status === 401 || error.status === 403);
}

export function noticeRefusedSave(stageId: string, error: unknown): void {
  if (!isRefusedSave(error) || noticed.has(stageId)) return;
  noticed.add(stageId);
  toast.error(i18n.t('classroom.saveRefused'));
}
