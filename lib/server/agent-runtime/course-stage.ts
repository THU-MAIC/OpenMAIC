import { createHash } from 'node:crypto';

/** Model-visible wording shared by every course-scoped tool schema. */
export const COURSE_STAGE_ID_DESCRIPTION =
  'Target stage id obtained from create_stage or list_folder_stages.';

/**
 * Deterministic stage id for one create-style tool call.
 *
 * A replay of the same durable call reuses its stage while a genuinely new
 * call gets a new id. `create_stage` uses this seam before the owner-bound
 * DocumentStore claims the document.
 */
export function stageIdForCall(sessionId: string, callId: string): string {
  const digest = createHash('sha256').update(`${sessionId}:${callId}`, 'utf-8').digest('base64url');
  return `stage-${digest.slice(0, 10)}`;
}

/** Deterministic folder id for one replayable create_folder call. */
export function folderIdForCall(sessionId: string, callId: string): string {
  const digest = createHash('sha256')
    .update(`folder:${sessionId}:${callId}`, 'utf-8')
    .digest('base64url');
  return `folder-${digest.slice(0, 10)}`;
}
